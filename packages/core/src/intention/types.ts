import type { Audience, Author, ContactId, Result, Sensitivity } from '../shared/index.ts';
import type { Vad } from '../emotion/index.ts';

export const CONCERN_STATUSES = ['candidate', 'active', 'watching', 'deferred', 'blocked', 'resolved', 'dismissed', 'suppressed'] as const;
export type ConcernStatus = (typeof CONCERN_STATUSES)[number];

/** Statuses a tool call may move a concern to; `candidate` is runtime-only. */
export type ConcernTransitionTarget = Exclude<ConcernStatus, 'candidate'>;
export const CONCERN_TRANSITION_TARGETS: readonly ConcernTransitionTarget[] = CONCERN_STATUSES.filter(
  (s): s is ConcernTransitionTarget => s !== 'candidate',
);

export const CONCERN_PRIORITIES = ['low', 'medium', 'high'] as const;
export type ConcernPriority = (typeof CONCERN_PRIORITIES)[number];

/** What a piece of evidence points at. The reference is kept verbatim; its content is never copied in. */
export const CONCERN_EVIDENCE_KINDS = ['turn', 'session_entry', 'memory', 'journal', 'activity', 'note'] as const;
export type ConcernEvidenceKind = (typeof CONCERN_EVIDENCE_KINDS)[number];

export interface ConcernEvidenceRef {
  readonly kind: ConcernEvidenceKind;
  readonly ref: string;
  /** Sensitivity of what the reference points at; a viewer not admitted to it cannot see the concern. */
  readonly sensitivity: Sensitivity;
}

/** How a concern ended, with the affect arc only when both snapshots were really captured. */
export interface ConcernResolution {
  /** Unique per resolution, so its relief is applied to emotion state exactly once. */
  readonly generationId: string;
  readonly status: 'resolved' | 'dismissed' | 'suppressed';
  readonly outcome: string | null;
  readonly evidenceRefs: readonly ConcernEvidenceRef[];
  /** From trusted, fresh telemetry of the resolving scope, or null. Never fabricated. */
  readonly resolutionVad: Vad | null;
  /** resolutionVad minus formationVad, sign preserved; null unless both exist. */
  readonly reliefDelta: Vad | null;
  /** Prose description of the arc. It is derived from two estimates, so it is machine-authored. */
  readonly arc: { readonly text: string; readonly author: Author } | null;
  readonly resolvedAt: string;
}

export interface ActiveConcern {
  readonly id: string;
  readonly text: string;
  readonly status: ConcernStatus;
  readonly priority: ConcernPriority;
  readonly sensitivity: Sensitivity;
  /** Tool-created concerns are always companion-owned; the model cannot claim operator/system. */
  readonly owner: 'companion' | 'operator' | 'system';
  readonly author: Author;
  /** The audience the concern was formed in; reads follow `canViewerRead` on it. */
  readonly formedIn: Audience;
  /** The direct contact it was formed with, if any. */
  readonly contactId: ContactId | null;
  /** Every evidence reference ever attached. Nothing is removed; a reopen adds new evidence. */
  readonly evidenceRefs: readonly ConcernEvidenceRef[];
  /** From trusted, fresh telemetry at formation, or null. Never fabricated. */
  readonly formationVad: Vad | null;
  /** The current resolution; earlier ones stay in the concern's event history. */
  readonly resolution: ConcernResolution | null;
  readonly nextReviewAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly revision: number;
}

/** One append-only step in a concern's life. */
export interface ConcernEvent {
  readonly concernId: string;
  readonly revision: number;
  readonly kind: 'created' | 'transitioned';
  readonly from: ConcernStatus | null;
  readonly to: ConcernStatus;
  /** Evidence attached by this step. */
  readonly evidenceRefs: readonly ConcernEvidenceRef[];
  readonly outcome: string | null;
  readonly resolution: ConcernResolution | null;
  readonly author: Author;
  readonly at: string;
}

/** Position in the concern order (most recently updated first, then id descending). */
export interface ConcernCursor {
  readonly updatedAt: string;
  readonly id: string;
}

export interface ConcernListQuery {
  /** Only concerns in an open status (`OPEN_CONCERN_STATUSES`). */
  readonly openOnly: boolean;
  readonly limit: number;
  /** Continue strictly after this concern; null starts at the most recent. */
  readonly after: ConcernCursor | null;
}

export interface ConcernPort {
  get(id: string): Promise<Result<ActiveConcern>>;
  /**
   * One page, most recently updated first. A page shorter than `limit` means
   * the store is exhausted. Callers filter by audience and page on.
   */
  list(query: ConcernListQuery): Promise<Result<readonly ActiveConcern[]>>;
  /** Writes revision 1 and its event; an existing id is an `already_exists` conflict. */
  create(concern: ActiveConcern, event: ConcernEvent): Promise<Result<ActiveConcern>>;
  /** Compare-and-set on the revision; the event is appended in the same transaction. */
  update(next: ActiveConcern, expectedRevision: number, event: ConcernEvent): Promise<Result<ActiveConcern>>;
  /** Oldest first. */
  events(id: string, limit: number): Promise<Result<readonly ConcernEvent[]>>;
}

export const FOLLOW_UP_STATES = ['pending', 'activated', 'dampened'] as const;
export type FollowUpState = (typeof FOLLOW_UP_STATES)[number];

export interface PendingFollowUp {
  /** Derived from target conversation, content and due time, so a retried create is the same follow-up. */
  readonly id: string;
  /** The conversation it will be raised in; reads follow `canViewerRead` on it. */
  readonly target: Audience;
  readonly content: string;
  readonly dueAt: string;
  readonly state: FollowUpState;
  readonly concernId: string | null;
  readonly author: Author;
  readonly createdAt: string;
  readonly activatedAt: string | null;
  readonly revision: number;
}

/** Position in the follow-up order (earliest due first, then id). */
export interface FollowUpCursor {
  readonly dueAt: string;
  readonly id: string;
}

export interface FollowUpListQuery {
  /** Only follow-ups in this state; null for every state. */
  readonly state: FollowUpState | null;
  /** Only follow-ups due at or before this instant; null for any due time. */
  readonly dueAtOrBefore: string | null;
  readonly limit: number;
  /** Continue strictly after this follow-up; null starts at the earliest due. */
  readonly after: FollowUpCursor | null;
}

export interface FollowUpPort {
  /** Idempotent by id: an existing id returns the stored follow-up with `created: false`. */
  create(followUp: PendingFollowUp): Promise<Result<{ readonly followUp: PendingFollowUp; readonly created: boolean }>>;
  get(id: string): Promise<Result<PendingFollowUp>>;
  /**
   * One page, earliest due first. A page shorter than `limit` means the store
   * is exhausted. Callers filter by audience and page on.
   */
  list(query: FollowUpListQuery): Promise<Result<readonly PendingFollowUp[]>>;
  /** Compare-and-set on the revision. */
  update(next: PendingFollowUp, expectedRevision: number): Promise<Result<PendingFollowUp>>;
}
