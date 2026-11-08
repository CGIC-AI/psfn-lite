import type { ActivityId, Audience, Author, Result, SessionId, TurnId, WorkerRunId } from '../shared/index.ts';

export type ActivityStatus = 'in_progress' | 'completed' | 'interrupted' | 'failed' | 'abandoned';

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

/** Durable activity log; `update` is compare-and-set on revision. */
export interface ActivityLogPort {
  insert(record: ActivityRecord): Promise<Result<ActivityRecord>>;
  get(id: ActivityId): Promise<Result<ActivityRecord>>;
  update(record: ActivityRecord, expectedRevision: number): Promise<Result<ActivityRecord>>;
}
