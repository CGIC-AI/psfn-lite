import { lexicalTokens, participantsReadable, sourceKeys, sourceReadable, tokenOverlap, type SourceAccess } from '../memory/index.ts';
import type { ArchivedEntry } from '../sessions/index.ts';
import type { ContactId } from '../shared/index.ts';
import type { Episode, EpisodeArc, EpisodeMachineSignals } from './types.ts';

/**
 * Episode rules ported from the donor's deterministic synthesis and nightly
 * consolidation (`src/faculties/memory/episodic/synthesis.ts`,
 * `src/faculties/memory/episodic/sleep-consolidation.ts`,
 * `src/faculties/memory/episodic/synthesis/consolidation.ts`,
 * `src/faculties/memory/episodic/arc-formation.ts`). Two Lite changes:
 * a short exchange, which the donor's salience minimums dropped, is kept as a
 * `brief` episode with deterministic signals, and an episode carrying companion
 * meaning is frozen, so consolidation never merges, absorbs into or
 * re-summarizes it.
 */

/** A pause longer than this splits a session into separate episodes (donor default). */
export const EPISODE_GAP_MS = 45 * 60_000;
/**
 * A segment with at most this many conversational entries and characters is
 * a brief exchange (a greeting and its answer). The donor dropped anything
 * under 2 entries and 120 characters; Lite keeps every such segment.
 */
export const BRIEF_MAX_ENTRIES = 3;
export const BRIEF_MAX_CHARS = 280;
/** Episodes of one conversation closer than this were one sitting and consolidate. */
export const CONSOLIDATION_GAP_MS = 30 * 60_000;
/** Arc members must follow each other within this window. */
export const ARC_WINDOW_MS = 14 * 24 * 60 * 60_000;
export const ARC_THEME_OVERLAP = 0.25;
const THEMES = 8;
const BRIEF_SUMMARY_CHARS = 160;

export function episodeReadable(access: SourceAccess, episode: Episode): boolean {
  if (episode.lifecycle === 'merged') return false;
  const { conversation, sourceClass } = sourceKeys(episode.source);
  return sourceReadable(access, conversation, sourceClass) && participantsReadable(access, episode.participantContactIds, episode.source);
}

/** An arc is shown only when every member is readable; otherwise it is withheld whole, span included. */
export function arcReadable(members: readonly (Episode | null)[], access: SourceAccess): boolean {
  return members.length > 0 && members.every((m) => m !== null && episodeReadable(access, m));
}

export function isConversational(entry: ArchivedEntry): boolean {
  return entry.entry.origin.kind === 'participant_speech' || entry.entry.origin.kind === 'companion_speech';
}

export interface Segment {
  readonly entries: readonly ArchivedEntry[];
  readonly conversational: readonly ArchivedEntry[];
  readonly classification: 'conversation' | 'brief' | 'no_conversation';
}

/** Splits a session's entries at long pauses and classifies each part. */
export function segmentEntries(entries: readonly ArchivedEntry[], gapMs = EPISODE_GAP_MS): Segment[] {
  const groups: ArchivedEntry[][] = [];
  let previous: number | null = null;
  for (const entry of entries) {
    const at = Date.parse(entry.entry.at);
    if (previous === null || at - previous > gapMs) groups.push([]);
    groups.at(-1)?.push(entry);
    previous = at;
  }
  return groups.map((group) => {
    const conversational = group.filter(isConversational);
    const chars = conversational.reduce((n, e) => n + e.entry.text.length, 0);
    const classification =
      conversational.length === 0
        ? 'no_conversation'
        : conversational.length <= BRIEF_MAX_ENTRIES && chars <= BRIEF_MAX_CHARS
          ? 'brief'
          : 'conversation';
    return { entries: group, conversational, classification };
  });
}

/** Most frequent content tokens, ties by first appearance. */
export function themesOf(texts: readonly string[], limit = THEMES): string[] {
  const counts = new Map<string, number>();
  for (const text of texts) for (const token of lexicalTokens(text)) counts.set(token, (counts.get(token) ?? 0) + 1);
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([token]) => token);
}

export function salienceOf(conversational: readonly ArchivedEntry[]): number {
  const chars = conversational.reduce((n, e) => n + e.entry.text.length, 0);
  const score = 0.35 + Math.min(0.3, conversational.length / 40) + Math.min(0.2, chars / 4000);
  return Math.round(Math.min(1, score) * 1000) / 1000;
}

/** Deterministic signals for a brief exchange: no model call, labelled as such. */
export function briefSignals(conversational: readonly ArchivedEntry[]): EpisodeMachineSignals {
  const first = conversational[0]?.entry.text.trim() ?? '';
  const excerpt = first.length > BRIEF_SUMMARY_CHARS ? `${first.slice(0, BRIEF_SUMMARY_CHARS - 1)}…` : first;
  return {
    authoredBy: 'runtime',
    producer: 'brief_exchange',
    summary: `Brief exchange: ${excerpt}`,
    salience: 0.1,
    themes: themesOf(conversational.map((e) => e.entry.text)),
  };
}

export function participantsOf(entries: readonly ArchivedEntry[]): ContactId[] {
  const out: ContactId[] = [];
  for (const { entry } of entries) {
    if (entry.origin.kind === 'participant_speech' && !out.includes(entry.origin.speaker)) out.push(entry.origin.speaker);
  }
  return out.sort();
}

export interface ConsolidationPlan {
  readonly merges: readonly { readonly survivor: Episode; readonly absorbed: readonly Episode[] }[];
  /** Candidates that become canonical unchanged. */
  readonly promote: readonly Episode[];
  /** Episodes kept apart because the companion authored meaning for them. */
  readonly frozen: readonly Episode[];
}

/**
 * Groups one conversation's non-merged episodes into sittings. An episode
 * with meaning is frozen: it is promoted if needed but never merged and never
 * absorbs another, so the text and scope the companion wrote about stay
 * exactly as written.
 */
export function planConsolidation(episodes: readonly Episode[], gapMs = CONSOLIDATION_GAP_MS): ConsolidationPlan {
  const sorted = [...episodes].sort((a, b) => (a.occurredFrom < b.occurredFrom ? -1 : a.occurredFrom > b.occurredFrom ? 1 : 0));
  const merges: { survivor: Episode; absorbed: Episode[] }[] = [];
  const promote: Episode[] = [];
  const frozen: Episode[] = [];
  let group: Episode[] = [];
  const flush = () => {
    if (group.length === 0) return;
    const [survivor, ...absorbed] = group;
    if (survivor !== undefined) {
      if (absorbed.length > 0) merges.push({ survivor, absorbed });
      else if (survivor.lifecycle === 'candidate') promote.push(survivor);
    }
    group = [];
  };
  for (const episode of sorted) {
    if (episode.meaning !== null) {
      flush();
      frozen.push(episode);
      if (episode.lifecycle === 'candidate') promote.push(episode);
      continue;
    }
    const last = group.at(-1);
    if (last !== undefined && Date.parse(episode.occurredFrom) - Date.parse(last.occurredTo) > gapMs) flush();
    group.push(episode);
  }
  flush();
  return { merges, promote, frozen };
}

/** The survivor of a merge: union of coverage, joined runtime summaries, canonical. Meaning is untouched. */
export function mergeEpisodes(survivor: Episode, absorbed: readonly Episode[], at: string): Episode {
  const all = [survivor, ...absorbed];
  const unique = <T>(items: readonly T[]): T[] => [...new Set(items)];
  return {
    ...survivor,
    lifecycle: 'canonical',
    form: all.some((e) => e.form === 'conversation') ? 'conversation' : 'brief',
    segments: all.flatMap((e) => e.segments),
    participantContactIds: unique(all.flatMap((e) => e.participantContactIds)).sort(),
    sourceTurnIds: unique(all.flatMap((e) => e.sourceTurnIds)),
    occurredFrom: all.map((e) => e.occurredFrom).sort()[0] ?? survivor.occurredFrom,
    occurredTo: all.map((e) => e.occurredTo).sort().at(-1) ?? survivor.occurredTo,
    machineSignals: {
      authoredBy: 'runtime',
      producer: 'episode_consolidation',
      summary: all.map((e) => e.machineSignals.summary).join(' Then: '),
      salience: Math.max(...all.map((e) => e.machineSignals.salience)),
      themes: unique(all.flatMap((e) => e.machineSignals.themes)).slice(0, THEMES),
    },
    updatedAt: at,
  };
}

/**
 * Arcs over canonical episodes: consecutive episodes with the same non-empty
 * participants, overlapping themes and within the arc window. Ids derive from
 * the first member, so a rerun updates the same arc instead of adding one.
 */
export function planArcs(episodes: readonly Episode[], at: string): Omit<EpisodeArc, 'revision'>[] {
  const sorted = [...episodes]
    .filter((e) => e.lifecycle === 'canonical' && e.participantContactIds.length > 0)
    .sort((a, b) => (a.occurredFrom < b.occurredFrom ? -1 : 1));
  const open = new Map<string, Episode[]>();
  const arcs: Episode[][] = [];
  for (const episode of sorted) {
    const key = episode.participantContactIds.join(',');
    const chain = open.get(key);
    const last = chain?.at(-1);
    const continues =
      last !== undefined &&
      Date.parse(episode.occurredFrom) - Date.parse(last.occurredTo) <= ARC_WINDOW_MS &&
      tokenOverlap(last.machineSignals.themes, episode.machineSignals.themes) >= ARC_THEME_OVERLAP;
    if (chain !== undefined && continues) {
      chain.push(episode);
    } else {
      const next = [episode];
      open.set(key, next);
      arcs.push(next);
    }
  }
  return arcs
    .filter((members) => members.length > 1)
    .map((members) => {
      const first = members[0] as Episode;
      return {
        id: `arc:${first.id}`,
        title: themesOf(members.flatMap((m) => m.machineSignals.themes), 3).join(', '),
        episodeIds: members.map((m) => m.id),
        participantContactIds: first.participantContactIds,
        authoredBy: 'runtime',
        updatedAt: at,
      };
    });
}
