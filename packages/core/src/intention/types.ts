import type { ChannelId, ContactId, Result, Sensitivity } from '../shared/index.ts';
import type { Vad } from '../emotion/index.ts';

export type ConcernStatus =
  | 'candidate'
  | 'active'
  | 'watching'
  | 'deferred'
  | 'blocked'
  | 'resolved'
  | 'dismissed'
  | 'suppressed';

/** Statuses a tool call may move a concern to; `candidate` is runtime-only. */
export type ConcernTransitionTarget = Exclude<ConcernStatus, 'candidate'>;

export interface ActiveConcern {
  readonly id: string;
  readonly text: string;
  readonly status: ConcernStatus;
  readonly sensitivity: Sensitivity;
  /** Tool-created concerns are always companion-owned; the model cannot claim operator/system. */
  readonly owner: 'companion' | 'operator' | 'system';
  readonly contactId: ContactId | null;
  readonly evidenceRefs: readonly string[];
  /** Omitted when no trusted, fresh telemetry exists; never fabricated. */
  readonly formationVad: Vad | null;
  readonly resolutionVad: Vad | null;
  readonly nextReviewAt: string | null;
  readonly revision: number;
}

export interface ConcernPort {
  listVisible(admitted: readonly Sensitivity[], viewerContactId: ContactId | null): Promise<Result<readonly ActiveConcern[]>>;
  transition(input: {
    readonly id: string;
    readonly to: ConcernTransitionTarget;
    readonly expectedRevision: number;
    readonly resolutionVad: Vad | null;
  }): Promise<Result<ActiveConcern>>;
}

export interface PendingFollowUp {
  readonly id: string;
  readonly channelId: ChannelId;
  readonly contactId: ContactId | null;
  readonly content: string;
  readonly dueAt: string;
  readonly state: 'pending' | 'activated' | 'dampened';
}
