import type { Audience, ContactId, Result, SessionId, TurnId } from '../shared/index.ts';
import type { EmbeddingSpace, SourceAccess } from '../memory/index.ts';

/** Signals computed by the runtime. They are inference, never the companion's meaning. */
export interface EpisodeMachineSignals {
  readonly authoredBy: 'runtime';
  readonly producer: string;
  readonly summary: string;
  readonly salience: number;
  readonly themes: readonly string[];
}

/** Meaning the companion authored about an episode. Only the companion writes it. */
export interface EpisodeMeaning {
  readonly authoredBy: 'companion';
  readonly text: string;
  readonly source: 'companion_reflection' | 'companion_direct';
  readonly revision: number;
  readonly authoredAt: string;
}

/**
 * `brief` marks an ended conversation too short for a model summary: it is
 * kept as an episode with deterministic signals instead of being dropped.
 */
export type EpisodeForm = 'conversation' | 'brief';
export type EpisodeLifecycle = 'candidate' | 'canonical' | 'merged';

/** The archive range of one session an episode covers. */
export interface EpisodeSegment {
  readonly sessionId: SessionId;
  readonly fromSeq: number;
  readonly toSeq: number;
}

export interface Episode {
  readonly id: string;
  readonly lifecycle: EpisodeLifecycle;
  readonly form: EpisodeForm;
  /** The audience the episode happened in; it decides who may read it. */
  readonly source: Audience;
  readonly segments: readonly EpisodeSegment[];
  readonly participantContactIds: readonly ContactId[];
  readonly sourceTurnIds: readonly TurnId[];
  readonly occurredFrom: string;
  readonly occurredTo: string;
  readonly machineSignals: EpisodeMachineSignals;
  /** Null until the companion reviews it; an unreviewed episode renders as a machine draft. */
  readonly meaning: EpisodeMeaning | null;
  readonly mergedInto: string | null;
  readonly revision: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** Episodes the runtime grouped as one thread of lived experience. Machine-drafted. */
export interface EpisodeArc {
  readonly id: string;
  readonly title: string;
  readonly episodeIds: readonly string[];
  readonly participantContactIds: readonly ContactId[];
  readonly authoredBy: 'runtime';
  readonly revision: number;
  readonly updatedAt: string;
}

export interface EpisodeHit {
  readonly episode: Episode;
  readonly score: number;
}

/**
 * Durable episodes. Filtered reads take a `SourceAccess` and apply it before
 * ranking and limits. `saveMachine` never writes meaning: the stored meaning
 * is kept whatever the record passed in says, so machine consolidation can
 * never overwrite first-person meaning. `setMeaning` is the sole meaning
 * writer, compare-and-set on the meaning revision, and keeps every version.
 */
export interface EpisodeStorePort {
  get(id: string): Promise<Result<Episode>>;
  /** Creates the episode, or returns the existing one with `created: false` when the id is taken. */
  createIfAbsent(episode: Episode): Promise<Result<{ readonly episode: Episode; readonly created: boolean }>>;
  saveMachine(episode: Episode, expectedRevision: number): Promise<Result<Episode>>;
  setMeaning(episodeId: string, meaning: EpisodeMeaning, expectedMeaningRevision: number): Promise<Result<Episode>>;
  meaningHistory(episodeId: string): Promise<Result<readonly EpisodeMeaning[]>>;
  searchLexical(access: SourceAccess, query: string, limit: number): Promise<Result<readonly EpisodeHit[]>>;
  searchSemantic(access: SourceAccess, space: EmbeddingSpace, vector: readonly number[], limit: number): Promise<Result<readonly EpisodeHit[]>>;
  timeline(access: SourceAccess, from: string, to: string, limit: number): Promise<Result<readonly Episode[]>>;
  withParticipant(access: SourceAccess, contactId: ContactId, limit: number): Promise<Result<readonly Episode[]>>;
  /** Unfiltered, for maintenance: non-merged episodes of one conversation, oldest first. */
  inConversation(conversation: string, limit: number): Promise<Result<readonly Episode[]>>;
  /** Unfiltered, for maintenance: canonical episodes that ended at or after `since`, oldest first. */
  canonicalSince(since: string, limit: number): Promise<Result<readonly Episode[]>>;
  putEmbedding(episodeId: string, space: EmbeddingSpace, vector: readonly number[]): Promise<Result<void>>;
  pendingEmbeddings(space: EmbeddingSpace, limit: number): Promise<Result<readonly Episode[]>>;
  arcsContaining(episodeId: string): Promise<Result<readonly EpisodeArc[]>>;
  getArc(arcId: string): Promise<Result<EpisodeArc>>;
  /** `expectedRevision` null creates; otherwise compare-and-set. Replaces membership. */
  saveArc(arc: EpisodeArc, expectedRevision: number | null): Promise<Result<EpisodeArc>>;
}
