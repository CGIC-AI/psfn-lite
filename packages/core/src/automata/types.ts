import type { ArtifactRef } from '../activity/index.ts';
import type {
  ActivityId,
  Audience,
  Author,
  ContactId,
  CoreError,
  Result,
  Sensitivity,
  SessionId,
  TurnId,
  WorkerRunId,
} from '../shared/index.ts';

export type WorkerRunStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
export const ACTIVE_WORKER_STATUSES: readonly WorkerRunStatus[] = ['queued', 'running'];

/** Terminal runs carry lineage, outcome and accounting only, never transcripts or reasoning. */
export type WorkerOutcome = 'completed' | 'blocked' | 'cancelled' | 'budget_limited' | 'failed';

/** What started a run: the companion's request, a per-turn task or a schedule. One runner serves all three. */
export const WORKER_TRIGGERS = ['request', 'turn', 'schedule'] as const;
export type WorkerTrigger = (typeof WORKER_TRIGGERS)[number];

/**
 * What a worker may do. `deriveWorkerScope` validates it against the inventory
 * and the parent scope: every action must exist and be open to workers, and
 * `maxSensitivity` caps the parent's admission. It can never widen it.
 */
export interface WorkerGrant {
  readonly actions: readonly { readonly tool: string; readonly action: string }[];
  readonly maxTurns: number;
  readonly maxSensitivity: Sensitivity;
}

/**
 * Who the parent turn acted for, recorded so a run is only ever driven again
 * under a freshly admitted scope for the same principal. It grants nothing.
 */
export type WorkerPrincipal =
  | { readonly kind: 'participant'; readonly contactId: ContactId }
  | { readonly kind: 'companion_internal' };

/** The event a run is bound to; its results never float free of it. */
export interface WorkerSource {
  readonly audience: Audience;
  readonly sessionId: SessionId | null;
  readonly turnId: TurnId | null;
  readonly principal: WorkerPrincipal;
  readonly trigger: WorkerTrigger;
}

/** Exclusive execution of one attempt. Calls from an older attempt or another owner are refused. */
export interface WorkerLease {
  readonly owner: string;
  readonly attempt: number;
  readonly until: string;
}

export interface WorkerGuidance {
  readonly at: string;
  readonly text: string;
  readonly author: Author;
}

export interface WorkerAccounting {
  readonly turnsUsed: number;
  readonly toolCalls: number;
  readonly modelCalls: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
}

/** A worker's reported result: machine-produced, bound to the run's source, never companion speech. */
export interface WorkerResult {
  readonly summary: string;
  readonly artifacts: readonly ArtifactRef[];
  readonly author: Author;
}

export interface WorkerRun {
  readonly id: WorkerRunId;
  /** Conversation-namespaced spawn key; a retried spawn with the same request replays this run. */
  readonly spawnKey: string;
  readonly requestDigest: string;
  readonly label: string;
  readonly task: string;
  readonly status: WorkerRunStatus;
  readonly outcome: WorkerOutcome | null;
  /** Why the run is in its state (for example `effect_outcome_unknown`, `lease_expired`). */
  readonly reason: string | null;
  readonly grant: WorkerGrant;
  readonly source: WorkerSource;
  readonly activityId: ActivityId;
  readonly lease: WorkerLease | null;
  /** Attempts started so far; recovery requeues at most `maxAttempts` times. */
  readonly attempts: number;
  readonly maxAttempts: number;
  readonly cancelRequested: boolean;
  readonly guidance: readonly WorkerGuidance[];
  readonly accounting: WorkerAccounting;
  readonly result: WorkerResult | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly finishedAt: string | null;
  readonly revision: number;
}

/** Position in run order (most recently created first, then id). */
export interface WorkerRunCursor {
  readonly createdAt: string;
  readonly id: WorkerRunId;
}

export interface WorkerRunQuery {
  /** Only runs in one of these statuses; null for every status. */
  readonly statuses: readonly WorkerRunStatus[] | null;
  readonly limit: number;
  readonly after: WorkerRunCursor | null;
}

/** Durable worker runs. `update` is compare-and-set on the revision. */
export interface WorkerRunPort {
  /** An existing id is an `already_exists` conflict. */
  insert(run: WorkerRun): Promise<Result<WorkerRun>>;
  get(id: WorkerRunId): Promise<Result<WorkerRun>>;
  /** One page, newest first. A page shorter than `limit` means the store is exhausted. */
  list(query: WorkerRunQuery): Promise<Result<readonly WorkerRun[]>>;
  /** Running runs whose lease ended before `now`, oldest lease first. */
  expired(now: string, limit: number): Promise<Result<readonly WorkerRun[]>>;
  update(next: WorkerRun, expectedRevision: number): Promise<Result<WorkerRun>>;
}

/**
 * The durable phase of one side effect a worker attempted (donor
 * background-work effect receipts). `started` is written before the effect
 * runs; `applied` and `rejected` record a definite outcome; a `started`
 * receipt left by a crash, or an effect whose store failed mid-write, becomes
 * `outcome_unknown` and is never executed again.
 */
export type WorkerEffectPhase = 'started' | 'applied' | 'rejected' | 'outcome_unknown';

export interface WorkerEffect {
  readonly runId: WorkerRunId;
  /** Supplied by the host per tool call and stable across retries of that call. */
  readonly effectKey: string;
  readonly tool: string;
  readonly action: string;
  readonly requestDigest: string;
  readonly attempt: number;
  readonly phase: WorkerEffectPhase;
  readonly result: unknown;
  readonly error: CoreError | null;
  readonly startedAt: string;
  readonly settledAt: string | null;
}

export interface WorkerEffectPort {
  /** Records a `started` receipt, or returns the existing one for this run and key without writing. */
  begin(effect: WorkerEffect): Promise<Result<{ readonly effect: WorkerEffect; readonly created: boolean }>>;
  /** Moves a `started` receipt to its outcome; any other current phase is a `stale_revision` conflict. */
  settle(next: WorkerEffect): Promise<Result<WorkerEffect>>;
  /** Every receipt of a run, oldest first. */
  list(runId: WorkerRunId): Promise<Result<readonly WorkerEffect[]>>;
}
