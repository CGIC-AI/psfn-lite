import type { ChannelId, ContactId, Result, TurnId } from '../shared/index.ts';
import type { MemoryReadScope } from '../memory/index.ts';

/** Signals computed by the runtime. They are inference, never the companion's meaning. */
export interface EpisodeMachineSignals {
  readonly authoredBy: 'runtime';
  readonly summary: string;
  readonly salience: number;
}

/** Meaning the companion authored about an episode. Only the companion writes it. */
export interface EpisodeMeaning {
  readonly authoredBy: 'companion';
  readonly text: string;
  readonly source: 'companion_reflection' | 'companion_direct';
  readonly revision: number;
}

export interface Episode {
  readonly id: string;
  readonly lifecycle: 'candidate' | 'canonical' | 'merged' | 'superseded';
  readonly channelId: ChannelId;
  readonly participantContactIds: readonly ContactId[];
  readonly sourceTurnIds: readonly TurnId[];
  readonly occurredFrom: string;
  readonly occurredTo: string;
  readonly machineSignals: EpisodeMachineSignals;
  /** Null until the companion reviews it; an unreviewed episode renders as a machine draft. */
  readonly meaning: EpisodeMeaning | null;
}

/** Search reports its own health instead of degrading silently. */
export interface EpisodeSearchResult {
  readonly episodes: readonly Episode[];
  readonly mode: { readonly lexical: 'ok' | 'unavailable'; readonly semantic: 'ok' | 'unavailable' };
}

export interface EpisodeReadPort {
  search(scope: MemoryReadScope, query: string, limit: number): Promise<Result<EpisodeSearchResult>>;
  get(scope: MemoryReadScope, id: string): Promise<Result<Episode>>;
  timeline(scope: MemoryReadScope, from: string, to: string): Promise<Result<readonly Episode[]>>;
}

/**
 * The sole writer of episode meaning. Compare-and-set on the meaning revision
 * so machine consolidation can never overwrite first-person meaning.
 */
export interface CompanionMeaningPort {
  setMeaning(input: {
    readonly episodeId: string;
    readonly text: string;
    readonly expectedRevision: number;
  }): Promise<Result<EpisodeMeaning>>;
}
