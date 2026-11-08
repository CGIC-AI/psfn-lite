import {
  arcReadable,
  episodeReadable,
  type Episode,
  type EpisodeMachineSignals,
  type EpisodeMeaning,
  type EpisodeStorePort,
} from '../episodes/index.ts';
import type { SourceAccess } from '../memory/index.ts';
import { conflict, denied, invalid, notFound, ok, type Clock, type ContactId, type Result, type TurnId } from '../shared/index.ts';
import {
  accessOf,
  boundedText,
  embedTexts,
  emptyUsage,
  fuseRankings,
  requireTrusted,
  type Embeddings,
  type InferenceUsage,
} from './memory-scope.ts';
import type { SearchMode } from './memory-service.ts';
import type { TrustedTurnScope } from './trusted-scope.ts';

const MEANING_MAX = 4_000;
const TIMELINE_MAX_DAYS = 366;

/**
 * An episode as a reader sees it. An unreviewed episode is labelled a
 * machine draft and its runtime signals stay labelled as inference; the
 * companion's meaning, when present, is shown as its own.
 */
export interface EpisodeView {
  readonly id: string;
  readonly lifecycle: Episode['lifecycle'];
  readonly form: Episode['form'];
  readonly rendering: 'companion_meaning' | 'machine_draft';
  readonly meaning: EpisodeMeaning | null;
  readonly machineSignals: EpisodeMachineSignals & { readonly origin: { readonly kind: 'machine_inference'; readonly producer: string } };
  readonly participantContactIds: readonly ContactId[];
  readonly occurredFrom: string;
  readonly occurredTo: string;
}

export interface ArcView {
  readonly id: string;
  readonly title: string;
  readonly episodeIds: readonly string[];
  readonly from: string;
  readonly to: string;
}

export interface EpisodeService {
  search(
    scope: TrustedTurnScope,
    input: { readonly query: string; readonly limit: number },
  ): Promise<Result<{ readonly episodes: readonly EpisodeView[]; readonly mode: SearchMode; readonly usage: InferenceUsage }>>;
  get(
    scope: TrustedTurnScope,
    input: { readonly episodeId: string },
  ): Promise<
    Result<{
      readonly episode: EpisodeView;
      readonly sourceTurnIds: readonly TurnId[];
      readonly segments: Episode['segments'];
      readonly arcs: readonly ArcView[];
    }>
  >;
  timeline(
    scope: TrustedTurnScope,
    input: { readonly from: string; readonly to: string; readonly limit: number },
  ): Promise<Result<readonly EpisodeView[]>>;
  authorMeaning(
    scope: TrustedTurnScope,
    input: { readonly episodeId: string; readonly text: string; readonly expectedRevision: number; readonly source: EpisodeMeaning['source'] },
  ): Promise<Result<EpisodeView>>;
}

/**
 * The companion's meaning is companion-private: it is shown only to readers
 * that may read companion-internal material (`selfSource`). Everyone else sees
 * the machine draft, with no sign that meaning exists.
 */
export function renderEpisode(access: SourceAccess, episode: Episode): EpisodeView {
  const meaning = access.selfSource ? episode.meaning : null;
  return {
    id: episode.id,
    lifecycle: episode.lifecycle,
    form: episode.form,
    rendering: meaning === null ? 'machine_draft' : 'companion_meaning',
    meaning,
    machineSignals: { ...episode.machineSignals, origin: { kind: 'machine_inference', producer: episode.machineSignals.producer } },
    participantContactIds: episode.participantContactIds,
    occurredFrom: episode.occurredFrom,
    occurredTo: episode.occurredTo,
  };
}

/**
 * The `episode` tool. Reads are filtered by the scope's access before ranking;
 * a withheld episode reads as missing, and an arc is shown only when every
 * one of its members is readable, so neither its span nor its size leaks a
 * withheld episode. Meaning is written only by the companion in a self turn,
 * compare-and-set on the meaning revision.
 */
export function createEpisodeService(deps: {
  readonly store: EpisodeStorePort;
  readonly embeddings: Embeddings;
  readonly clock: Clock;
}): EpisodeService {
  const visible = async (scope: TrustedTurnScope, episodeId: string): Promise<Result<Episode>> => {
    const found = await deps.store.get(episodeId);
    if (!found.ok) return found.error.kind === 'not_found' ? notFound(`episode ${episodeId}`) : found;
    return episodeReadable(accessOf(scope), found.value) ? found : notFound(`episode ${episodeId}`);
  };

  return {
    async search(scope, input) {
      const trusted = requireTrusted(scope);
      if (!trusted.ok) return trusted;
      const query = boundedText(input.query, 'query', 500);
      if (!query.ok) return query;
      const access = accessOf(scope);
      const usage = emptyUsage();
      const lexical = await deps.store.searchLexical(access, query.value, input.limit);
      const embedded = await embedTexts(deps.embeddings, [query.value], 'episode_search');
      usage.embeddingCalls += 1;
      usage.embeddedTexts += 1;
      const vector = embedded.ok ? embedded.value[0] : undefined;
      const semantic = vector === undefined ? null : await deps.store.searchSemantic(access, deps.embeddings.space, vector, input.limit);
      if (!lexical.ok && (semantic === null || !semantic.ok)) return lexical;
      const byId = new Map<string, Episode>();
      const lists: string[][] = [];
      for (const hits of [lexical, semantic]) {
        if (hits === null || !hits.ok) continue;
        lists.push(hits.value.map((h) => h.episode.id));
        for (const hit of hits.value) byId.set(hit.episode.id, hit.episode);
      }
      const episodes = fuseRankings(lists, input.limit)
        .map((id) => byId.get(id))
        .filter((e): e is Episode => e !== undefined && episodeReadable(access, e))
        .map((e) => renderEpisode(access, e));
      return ok({ episodes, mode: { lexical: lexical.ok ? 'ok' : 'unavailable', semantic: semantic?.ok === true ? 'ok' : 'unavailable' }, usage });
    },

    async get(scope, input) {
      const trusted = requireTrusted(scope);
      if (!trusted.ok) return trusted;
      const episode = await visible(scope, input.episodeId);
      if (!episode.ok) return episode;
      const access = accessOf(scope);
      const arcs = await deps.store.arcsContaining(episode.value.id);
      if (!arcs.ok) return arcs;
      const shown: ArcView[] = [];
      for (const arc of arcs.value) {
        const members: (Episode | null)[] = [];
        for (const memberId of arc.episodeIds) {
          const member = await deps.store.get(memberId);
          if (!member.ok && member.error.kind !== 'not_found') return member;
          members.push(member.ok ? member.value : null);
        }
        if (!arcReadable(members, access)) continue;
        const readable = members as Episode[];
        shown.push({
          id: arc.id,
          title: arc.title,
          episodeIds: arc.episodeIds,
          from: readable.map((m) => m.occurredFrom).sort()[0] ?? episode.value.occurredFrom,
          to: readable.map((m) => m.occurredTo).sort().at(-1) ?? episode.value.occurredTo,
        });
      }
      return ok({ episode: renderEpisode(access, episode.value), sourceTurnIds: episode.value.sourceTurnIds, segments: episode.value.segments, arcs: shown });
    },

    async timeline(scope, input) {
      const trusted = requireTrusted(scope);
      if (!trusted.ok) return trusted;
      if (input.from > input.to) return invalid('timeline from must not be after to');
      if (Date.parse(input.to) - Date.parse(input.from) > TIMELINE_MAX_DAYS * 86_400_000) return invalid(`a timeline covers at most ${TIMELINE_MAX_DAYS} days`);
      const access = accessOf(scope);
      const found = await deps.store.timeline(access, input.from, input.to, input.limit);
      return found.ok ? ok(found.value.filter((e) => episodeReadable(access, e)).map((e) => renderEpisode(access, e))) : found;
    },

    async authorMeaning(scope, input) {
      const trusted = requireTrusted(scope);
      if (!trusted.ok) return trusted;
      if (scope.audience.kind !== 'self' || scope.caller.kind !== 'companion_internal') {
        return denied('requires_self_audience', 'only the companion authors episode meaning, in its own turns');
      }
      const text = boundedText(input.text, 'text', MEANING_MAX);
      if (!text.ok) return text;
      const episode = await visible(scope, input.episodeId);
      if (!episode.ok) return episode;
      const current = episode.value.meaning?.revision ?? 0;
      if (current !== input.expectedRevision) {
        return conflict('stale_revision', `meaning of episode ${episode.value.id} moved`, { expectedRevision: input.expectedRevision, actualRevision: current });
      }
      const saved = await deps.store.setMeaning(
        episode.value.id,
        { authoredBy: 'companion', text: text.value, source: input.source, revision: current + 1, authoredAt: deps.clock.now().toISOString() },
        current,
      );
      return saved.ok ? ok(renderEpisode(accessOf(scope), saved.value)) : saved;
    },
  };
}
