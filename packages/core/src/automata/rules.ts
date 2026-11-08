/**
 * Worker run rules (donor `src/faculties/subagents/task-registry.ts`,
 * `task-visibility.ts`): the lifecycle matrix, who may see a run, and how a
 * run's terminal state reads as an activity.
 */
import type { ActivityStatus } from '../activity/index.ts';
import { canViewerRead, type ActivityId, type Viewer, type WorkerRunId } from '../shared/index.ts';
import type { WorkerOutcome, WorkerRun, WorkerRunStatus } from './types.ts';

const TRANSITIONS: Readonly<Record<WorkerRunStatus, readonly WorkerRunStatus[]>> = {
  queued: ['running', 'cancelled', 'failed'],
  // Recovery returns a pre-boundary attempt to the queue.
  running: ['completed', 'failed', 'cancelled', 'queued'],
  completed: [],
  failed: [],
  cancelled: [],
};

export function canTransitionWorker(from: WorkerRunStatus, to: WorkerRunStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export function isTerminalWorker(status: WorkerRunStatus): boolean {
  return TRANSITIONS[status].length === 0;
}

/**
 * A run belongs to the conversation that spawned it. That conversation always
 * sees it; another sees it only where it could read the spawning
 * conversation's material. Withheld runs read as missing.
 */
export function canViewWorkerRun(viewer: Viewer, run: Pick<WorkerRun, 'source'>): boolean {
  return canViewerRead(viewer, run.source.audience);
}

const RUN_PREFIX = 'worker_run:';

/**
 * The activity that mirrors a run's lifecycle. Only the runner settles it: its
 * status and outcome are the run's, never what the worker or a turn wrote.
 */
export function workerActivityId(runId: WorkerRunId): ActivityId {
  return `activity:${runId.startsWith(RUN_PREFIX) ? runId.slice(RUN_PREFIX.length) : runId}` as ActivityId;
}

/** The lifecycle status a terminal outcome maps to. */
export function statusForOutcome(outcome: WorkerOutcome): Exclude<WorkerRunStatus, 'queued' | 'running'> {
  switch (outcome) {
    case 'completed':
      return 'completed';
    case 'cancelled':
      return 'cancelled';
    case 'blocked':
    case 'budget_limited':
    case 'failed':
      return 'failed';
  }
}

/** How a run's outcome reads in the activity log. */
export function activityStatusForOutcome(outcome: WorkerOutcome): Exclude<ActivityStatus, 'in_progress'> {
  switch (outcome) {
    case 'completed':
      return 'completed';
    case 'cancelled':
      return 'abandoned';
    case 'budget_limited':
      return 'interrupted';
    case 'blocked':
    case 'failed':
      return 'failed';
  }
}
