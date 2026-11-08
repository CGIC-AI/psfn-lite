import {
  briefSignals,
  mergeEpisodes,
  participantsOf,
  planArcs,
  planConsolidation,
  salienceOf,
  segmentEntries,
  themesOf,
  type Episode,
  type EpisodeMachineSignals,
  type EpisodeStorePort,
  type Segment,
} from '../episodes/index.ts';
import type { SessionCursorPort } from '../memory/index.ts';
import type { SessionArchivePort, SessionCatalogPort, SessionRecord } from '../sessions/index.ts';
import { conversationKey, invalid, isNonEmptyString, ok, type Clock, type Result, type SessionId, type TurnId } from '../shared/index.ts';
import type { ModelPort } from './host-ports.ts';
import { emptyUsage, requireMaintenanceScope, type InferenceUsage } from './memory-scope.ts';
import type { TrustedTurnScope } from './trusted-scope.ts';

const SUMMARY_PRODUCER = 'episode_synthesis';
const SUMMARY_TOKENS = 300;
const CONVERSATION_SCAN = 500;
const ARC_SCAN = 1_000;

export interface FormationReport {
  readonly sessionId: SessionId;
  readonly outcome: 'formed' | 'up_to_date' | 'not_ended';
  readonly throughSeq: number;
  readonly episodes: readonly { readonly episodeId: string; readonly form: Episode['form']; readonly created: boolean }[];
  /** Ranges with no conversational entries, recorded instead of silently skipped. */
  readonly noConversation: readonly { readonly fromSeq: number; readonly toSeq: number }[];
  readonly usage: InferenceUsage;
}

export interface ConsolidationReport {
  readonly conversation: string;
  readonly merged: readonly { readonly survivorId: string; readonly absorbedIds: readonly string[] }[];
  readonly promoted: readonly string[];
  /** Episodes left untouched because they carry companion meaning. */
  readonly frozen: readonly string[];
}

export interface ArcReport {
  readonly arcs: readonly { readonly arcId: string; readonly episodeIds: readonly string[]; readonly created: boolean }[];
}

export interface EpisodeFormation {
  form(scope: TrustedTurnScope, input: { readonly sessionId: SessionId; readonly maxEntries: number }): Promise<Result<FormationReport>>;
  consolidate(scope: TrustedTurnScope, input: { readonly conversation: string }): Promise<Result<ConsolidationReport>>;
  weaveArcs(scope: TrustedTurnScope, input: { readonly since: string }): Promise<Result<ArcReport>>;
}

/**
 * Episodes from ended conversations (donor
 * `src/faculties/memory/episodic/synthesis.ts`, `sleep-consolidation.ts`,
 * `arc-formation.ts`). A session has ended when it is no longer its
 * conversation's active session or has been idle for `endedAfterMs`. Every
 * conversational segment becomes an episode: a normal one gets a model
 * summary attributed as machine inference, a brief one deterministic
 * signals and no model call. Episode ids derive from the session and first
 * archive position and the watermark advances only after all are stored, so
 * a rerun returns the same episodes. Consolidation and arcs never write
 * meaning, and an episode the companion has given meaning is never merged.
 */
export function createEpisodeFormation(deps: {
  readonly catalog: SessionCatalogPort;
  readonly archive: SessionArchivePort;
  readonly cursors: SessionCursorPort;
  readonly episodes: EpisodeStorePort;
  readonly model: ModelPort;
  readonly clock: Clock;
  readonly endedAfterMs: number;
}): Result<EpisodeFormation> {
  if (!Number.isInteger(deps.endedAfterMs) || deps.endedAfterMs < 60_000) return invalid('endedAfterMs must be an integer of at least one minute');

  const ended = async (sessionId: SessionId): Promise<Result<{ readonly ended: boolean; readonly session: SessionRecord }>> => {
    const session = await deps.catalog.get(sessionId);
    if (!session.ok) return session;
    const head = await deps.catalog.active(conversationKey(session.value.audience));
    if (!head.ok) return head;
    const idle = deps.clock.now().getTime() - Date.parse(session.value.lastActivityAt) >= deps.endedAfterMs;
    return ok({ ended: head.value?.sessionId !== sessionId || idle, session: session.value });
  };

  const signals = async (segment: Segment, usage: InferenceUsage): Promise<Result<EpisodeMachineSignals>> => {
    if (segment.classification === 'brief') return ok(briefSignals(segment.conversational));
    const completed = await deps.model.complete({
      attribution: { purpose: SUMMARY_PRODUCER, turnId: null, output: 'machine_inference' },
      messages: [
        { role: 'labelled_context', label: 'system note: episode synthesis', text: 'Summarize this conversation as one lived episode in two or three sentences.' },
        ...segment.conversational.map((e) => ({
          role: 'labelled_context' as const,
          label: `transcript #${e.seq} (${e.entry.origin.kind === 'participant_speech' ? `participant ${e.entry.origin.speaker}` : 'companion'})`,
          text: e.entry.text,
        })),
      ],
      maxOutputTokens: SUMMARY_TOKENS,
    });
    if (!completed.ok) return completed;
    usage.modelCalls += 1;
    usage.inputTokens += completed.value.inputTokens;
    usage.outputTokens += completed.value.outputTokens;
    if (!isNonEmptyString(completed.value.text)) return invalid('the model returned an empty episode summary');
    return ok({
      authoredBy: 'runtime',
      producer: SUMMARY_PRODUCER,
      summary: completed.value.text.trim(),
      salience: salienceOf(segment.conversational),
      themes: themesOf(segment.conversational.map((e) => e.entry.text)),
    });
  };

  return ok({
    async form(scope, input) {
      const allowed = requireMaintenanceScope(scope);
      if (!allowed.ok) return allowed;
      const state = await ended(input.sessionId);
      if (!state.ok) return state;
      const cursor = await deps.cursors.get(input.sessionId);
      if (!cursor.ok) return cursor;
      const usage = emptyUsage();
      const base = { sessionId: input.sessionId, usage };
      if (!state.value.ended) return ok({ ...base, outcome: 'not_ended', throughSeq: cursor.value.seq, episodes: [], noConversation: [] });
      const range = await deps.archive.readRange(input.sessionId, cursor.value.seq + 1, input.maxEntries);
      if (!range.ok) return range;
      const last = range.value.at(-1);
      if (last === undefined) return ok({ ...base, outcome: 'up_to_date', throughSeq: cursor.value.seq, episodes: [], noConversation: [] });

      const formed: { episodeId: string; form: Episode['form']; created: boolean }[] = [];
      const noConversation: { fromSeq: number; toSeq: number }[] = [];
      const at = deps.clock.now().toISOString();
      for (const segment of segmentEntries(range.value)) {
        const first = segment.entries[0];
        const final = segment.entries.at(-1);
        if (first === undefined || final === undefined) continue;
        if (segment.classification === 'no_conversation') {
          noConversation.push({ fromSeq: first.seq, toSeq: final.seq });
          continue;
        }
        const id = `episode:${input.sessionId}:${first.seq}`;
        const existing = await deps.episodes.get(id);
        if (existing.ok) {
          formed.push({ episodeId: id, form: existing.value.form, created: false });
          continue;
        }
        if (existing.error.kind !== 'not_found') return existing;
        const machine = await signals(segment, usage);
        if (!machine.ok) return machine;
        const turnIds: TurnId[] = [...new Set(segment.conversational.map((e) => e.entry.turnId))];
        const created = await deps.episodes.createIfAbsent({
          id,
          lifecycle: 'candidate',
          form: segment.classification,
          source: state.value.session.audience,
          segments: [{ sessionId: input.sessionId, fromSeq: first.seq, toSeq: final.seq }],
          participantContactIds: participantsOf(segment.entries),
          sourceTurnIds: turnIds,
          occurredFrom: first.entry.at,
          occurredTo: final.entry.at,
          machineSignals: machine.value,
          meaning: null,
          mergedInto: null,
          revision: 1,
          createdAt: at,
          updatedAt: at,
        });
        if (!created.ok) return created;
        formed.push({ episodeId: id, form: created.value.episode.form, created: created.value.created });
      }
      const advanced = await deps.cursors.advance(input.sessionId, last.seq, cursor.value.revision);
      if (!advanced.ok) return advanced;
      return ok({ ...base, outcome: 'formed', throughSeq: last.seq, episodes: formed, noConversation });
    },

    async consolidate(scope, input) {
      const allowed = requireMaintenanceScope(scope);
      if (!allowed.ok) return allowed;
      const episodes = await deps.episodes.inConversation(input.conversation, CONVERSATION_SCAN);
      if (!episodes.ok) return episodes;
      const plan = planConsolidation(episodes.value);
      const at = deps.clock.now().toISOString();
      const merged: { survivorId: string; absorbedIds: string[] }[] = [];
      for (const { survivor, absorbed } of plan.merges) {
        const saved = await deps.episodes.saveMachine({ ...mergeEpisodes(survivor, absorbed, at), revision: survivor.revision + 1 }, survivor.revision);
        if (!saved.ok) return saved;
        for (const episode of absorbed) {
          const gone = await deps.episodes.saveMachine(
            { ...episode, lifecycle: 'merged', mergedInto: survivor.id, revision: episode.revision + 1, updatedAt: at },
            episode.revision,
          );
          if (!gone.ok) return gone;
        }
        merged.push({ survivorId: survivor.id, absorbedIds: absorbed.map((e) => e.id) });
      }
      for (const episode of plan.promote) {
        const saved = await deps.episodes.saveMachine({ ...episode, lifecycle: 'canonical', revision: episode.revision + 1, updatedAt: at }, episode.revision);
        if (!saved.ok) return saved;
      }
      return ok({ conversation: input.conversation, merged, promoted: plan.promote.map((e) => e.id), frozen: plan.frozen.map((e) => e.id) });
    },

    async weaveArcs(scope, input) {
      const allowed = requireMaintenanceScope(scope);
      if (!allowed.ok) return allowed;
      const episodes = await deps.episodes.canonicalSince(input.since, ARC_SCAN);
      if (!episodes.ok) return episodes;
      const arcs: { arcId: string; episodeIds: readonly string[]; created: boolean }[] = [];
      for (const planned of planArcs(episodes.value, deps.clock.now().toISOString())) {
        const existing = await deps.episodes.getArc(planned.id);
        if (!existing.ok && existing.error.kind !== 'not_found') return existing;
        if (existing.ok) {
          const same = existing.value.title === planned.title && existing.value.episodeIds.join() === planned.episodeIds.join();
          if (!same) {
            const saved = await deps.episodes.saveArc({ ...planned, revision: existing.value.revision + 1 }, existing.value.revision);
            if (!saved.ok) return saved;
          }
          arcs.push({ arcId: planned.id, episodeIds: planned.episodeIds, created: false });
          continue;
        }
        const saved = await deps.episodes.saveArc({ ...planned, revision: 1 }, null);
        if (!saved.ok) return saved;
        arcs.push({ arcId: planned.id, episodeIds: planned.episodeIds, created: true });
      }
      return ok({ arcs });
    },
  });
}
