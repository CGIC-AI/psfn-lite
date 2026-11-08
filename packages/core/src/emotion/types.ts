import type { Audience, Author, ChannelId, ContactId, PresentationRole, Result, SessionId, TurnId } from '../shared/index.ts';

export interface Vad {
  readonly valence: number;
  readonly arousal: number;
  readonly dominance: number;
}

/**
 * Emotion state is kept per audience scope so a room's state never leaks into
 * a DM. One contact shares one direct scope across channels (donor
 * `scoped-emotion.ts`); rooms are independent; companion-internal turns have
 * their own scope.
 */
export type EmotionScopeKey =
  | { readonly kind: 'direct'; readonly contactId: ContactId }
  | { readonly kind: 'room'; readonly channelId: ChannelId }
  | { readonly kind: 'self' };

/** Fast VAD, slow mood, decaying discrete labels and a signal confidence, all machine-estimated. */
export interface AffectSnapshot {
  readonly vad: Vad;
  readonly mood: Vad;
  readonly discrete: Readonly<Record<string, number>>;
  readonly confidence: number;
}

/** One estimator reading of a turn. It is inference about the turn, never a self-report. */
export interface AffectObservation {
  readonly vad: Vad;
  readonly discrete: Readonly<Record<string, number>>;
  readonly confidence: number;
  /** Which estimator produced it, recorded as the machine author. */
  readonly producer: string;
}

/** Text handed to an estimator, labelled with the role its origin allows. */
export interface EstimatorMessage {
  readonly role: PresentationRole;
  readonly label: string | null;
  readonly text: string;
}

/**
 * Host-supplied affect estimator (a classifier or model). Core never assumes
 * it is free: every reading is one inference call, counted by the caller.
 */
export interface AffectEstimatorPort {
  estimate(request: {
    readonly purpose: 'emotion.observe';
    readonly turnId: TurnId;
    readonly messages: readonly EstimatorMessage[];
  }): Promise<Result<AffectObservation>>;
}

/** A queued narrative appraisal: the scope moved far enough from the last appraised VAD. */
export interface AppraisalDecision {
  readonly turnId: TurnId;
  readonly sessionId: SessionId;
  readonly baselineVad: Vad;
  readonly targetVad: Vad;
  readonly delta: number;
  readonly threshold: number;
}

/**
 * Durable meaningful-change gate state. The donor kept this in memory, so a
 * restart re-seeded it; Lite persists it with the scope's state.
 */
export interface AppraisalGateState {
  /** VAD at the last appraisal, or the seed taken from the first trusted observation. */
  readonly baselineVad: Vad | null;
  readonly turnsSinceLast: number;
  /** An appraisal owed for a committed turn but not yet written (crash or model failure). */
  readonly pending: AppraisalDecision | null;
}

export type ProcessingQuality = 'fluent' | 'deliberate' | 'struggling';
export type ConversationTrajectory = 'casual' | 'deepening' | 'shifting' | 'wrapping-up';

/** Deterministic self-model signals for one turn (donor `self-model/state.ts`), machine-derived. */
export interface SelfModelSnapshot {
  readonly turnId: TurnId;
  readonly certainty: number;
  readonly engagement: number;
  readonly processing: ProcessingQuality;
  readonly trajectory: ConversationTrajectory;
  readonly salientTerms: readonly string[];
  readonly openConcernCount: number;
  readonly computedAt: string;
}

export interface EmotionStateRecord {
  readonly scope: EmotionScopeKey;
  /** Stable storage key of `scope`. */
  readonly key: string;
  readonly snapshot: AffectSnapshot;
  /** When `snapshot` was last advanced (decay is applied from here). */
  readonly updatedAt: string;
  /** The last observation trusted enough to apply; null means no estimate exists. */
  readonly lastTrusted: { readonly at: string; readonly producer: string; readonly confidence: number } | null;
  readonly gate: AppraisalGateState;
  readonly selfModel: SelfModelSnapshot | null;
  /** 0 before the first write. */
  readonly revision: number;
}

export type GateOutcome = 'baseline_seeded' | 'no_movement' | 'untrusted_telemetry' | 'appraisal_due' | 'not_applicable';

/** What changed a scope's state, recorded once per source so retries never double-apply. */
export interface EmotionObservationRecord {
  /** `turn:<turnId>` or `relief:<generationId>`. */
  readonly id: string;
  readonly scopeKey: string;
  readonly kind: 'turn' | 'concern_relief';
  readonly trusted: boolean;
  readonly impulse: Vad | null;
  readonly confidence: number | null;
  readonly producer: string;
  readonly gate: GateOutcome;
  readonly at: string;
}

export interface EmotionStatePort {
  get(key: string): Promise<Result<EmotionStateRecord | null>>;
  observation(id: string): Promise<Result<EmotionObservationRecord | null>>;
  /**
   * Compare-and-set on the scope's revision (0 creates the scope). The
   * observation, when given, is recorded in the same transaction; an id that is
   * already recorded is an `already_exists` conflict and nothing changes.
   */
  commit(input: {
    readonly next: EmotionStateRecord;
    readonly expectedRevision: number;
    readonly observation: EmotionObservationRecord | null;
  }): Promise<Result<EmotionStateRecord>>;
}

/** A narrative appraisal of a meaningful change. Machine inference, never companion speech. */
export interface AppraisalEntry {
  /** `appraisal:<turnId>`: one appraisal per turn. */
  readonly id: string;
  readonly scopeKey: string;
  /** Audience of the conversation it was derived from; reads follow `canViewerRead`. */
  readonly source: Audience;
  readonly sessionId: SessionId;
  readonly turnId: TurnId;
  readonly summary: string;
  readonly vad: Vad;
  readonly delta: number;
  readonly author: Author;
  readonly at: string;
}

export interface AppraisalLogPort {
  /** Idempotent by id: identical content returns the stored entry, different content is an `entry_mismatch` conflict. */
  append(entry: AppraisalEntry): Promise<Result<AppraisalEntry>>;
  get(id: string): Promise<Result<AppraisalEntry | null>>;
  /** Newest first across every scope; callers filter by audience. */
  recent(limit: number): Promise<Result<readonly AppraisalEntry[]>>;
}

/** What the companion says about its own state, stored apart from every estimate. */
export interface EmotionSelfReport {
  readonly id: string;
  readonly scopeKey: string;
  readonly audience: Audience;
  readonly text: string;
  readonly author: Author;
  readonly source: 'companion_authored';
  /** A correction names the report it supersedes; the original is kept. */
  readonly supersedes: string | null;
  readonly reportedAt: string;
}

export interface SelfReportPort {
  /** Append-only; an existing id is an `already_exists` conflict. */
  append(report: EmotionSelfReport): Promise<Result<EmotionSelfReport>>;
  get(id: string): Promise<Result<EmotionSelfReport>>;
  /** Newest first within one scope. */
  recent(scopeKey: string, limit: number): Promise<Result<readonly EmotionSelfReport[]>>;
}

/** A reflection record as the self-model sees it; authorship and audience are the record's own. */
export interface AuthoredReflection {
  readonly id: string;
  readonly text: string;
  readonly author: Author;
  readonly source: Audience;
  readonly createdAt: string;
}

/**
 * Narrow read of reflection records, which the journals domain owns. Core
 * filters authorship (only companion-authored text is rendered as authored
 * reflection) and audience before anything is shown.
 */
export interface AuthoredReflectionPort {
  /** Newest first. */
  recent(limit: number): Promise<Result<readonly AuthoredReflection[]>>;
}
