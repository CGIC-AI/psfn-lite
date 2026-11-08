import type { Result, SessionId, TurnId, WorkerRunId } from '../shared/index.ts';

export type WorkerRunStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';

/** Terminal runs carry lineage, outcome and accounting only, never transcripts or reasoning. */
export type WorkerOutcome = 'completed' | 'blocked' | 'cancelled' | 'budget_limited' | 'failed';

/** Tool actions a worker may call, already intersected with the parent's grant. */
export interface WorkerGrant {
  readonly actions: readonly { readonly tool: string; readonly action: string }[];
  readonly maxTurns: number;
}

export interface WorkerRun {
  readonly id: WorkerRunId;
  readonly task: string;
  readonly status: WorkerRunStatus;
  readonly outcome: WorkerOutcome | null;
  readonly grant: WorkerGrant;
  /** The conversation and turn that spawned the run; only that audience can see it. */
  readonly source: { readonly sessionId: SessionId; readonly turnId: TurnId };
  readonly revision: number;
}

export interface WorkerRunPort {
  get(id: WorkerRunId): Promise<Result<WorkerRun>>;
  transition(id: WorkerRunId, to: WorkerRunStatus, expectedRevision: number): Promise<Result<WorkerRun>>;
}

/**
 * Bounded execution supplied by the active harness. Core decides authority and
 * records lifecycle; the harness runs the loop with only the granted tools.
 */
export interface WorkerExecutionPort {
  start(run: WorkerRun): Promise<Result<void>>;
  cancel(id: WorkerRunId): Promise<Result<void>>;
}
