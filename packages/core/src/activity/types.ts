import type { ActivityId, Audience, Author, Result, SessionId, TurnId, WorkerRunId } from '../shared/index.ts';

export const ACTIVITY_STATUSES = ['in_progress', 'completed', 'interrupted', 'failed', 'abandoned'] as const;
export type ActivityStatus = (typeof ACTIVITY_STATUSES)[number];

/** The event an activity is bound to; background results never float free of their source. */
export interface ActivitySource {
  readonly sessionId: SessionId | null;
  readonly turnId: TurnId | null;
  readonly workerRunId: WorkerRunId | null;
}

export interface ArtifactRef {
  readonly kind: string;
  readonly ref: string;
}

/** An attributed note on an activity: the companion's reflection or a machine summary. */
export interface ActivityNote {
  readonly author: Author;
  readonly text: string;
}

/**
 * What the companion has been doing. Visibility is the audience the activity
 * happened in; awareness of an activity is not permission to disclose it.
 */
export interface ActivityRecord {
  readonly id: ActivityId;
  readonly purpose: string;
  readonly status: ActivityStatus;
  readonly outcome: string | null;
  readonly artifacts: readonly ArtifactRef[];
  readonly notes: readonly ActivityNote[];
  readonly source: ActivitySource;
  readonly visibility: Audience;
  readonly startedAt: string;
  readonly updatedAt: string;
  readonly revision: number;
}

/** Position in activity order (most recently started first, then id). */
export interface ActivityCursor {
  readonly startedAt: string;
  readonly id: ActivityId;
}

/** Durable activity log; `update` is compare-and-set on revision. */
export interface ActivityLogPort {
  /** An existing id is an `already_exists` conflict. */
  insert(record: ActivityRecord): Promise<Result<ActivityRecord>>;
  get(id: ActivityId): Promise<Result<ActivityRecord>>;
  /** One page, newest first. A page shorter than `limit` means the store is exhausted. */
  list(limit: number, after: ActivityCursor | null): Promise<Result<readonly ActivityRecord[]>>;
  update(record: ActivityRecord, expectedRevision: number): Promise<Result<ActivityRecord>>;
}
