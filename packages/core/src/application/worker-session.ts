import type { ArtifactRef } from '../activity/index.ts';
import type { WorkerGuidance, WorkerRun } from '../automata/index.ts';
import type { Result, WorkerRunId } from '../shared/index.ts';
import type { AttributedToolResult, ToolCall } from './dispatch.ts';
import type { TrustedTurnScope } from './trusted-scope.ts';

/** What a turn of the worker loop may do next. */
export type WorkerTurnGate =
  | { readonly kind: 'turn'; readonly turn: number; readonly guidance: readonly WorkerGuidance[] }
  | { readonly kind: 'budget_exhausted' }
  | { readonly kind: 'cancel_requested' };

/** How an attempt ended, as the host reports it. Core records it; the host never writes the run itself. */
export interface WorkerReport {
  readonly outcome: 'completed' | 'blocked' | 'cancelled' | 'budget_limited';
  /** Machine-produced summary of the result; recorded as the worker's output, never as companion speech. */
  readonly summary: string;
  readonly artifacts: readonly ArtifactRef[];
  readonly reason: string | null;
  readonly usage: { readonly modelCalls: number; readonly inputTokens: number; readonly outputTokens: number };
}

/**
 * One claimed attempt of a worker run, handed to the host. Core owns the
 * grant, scope, lifecycle, effects and result; the host runs the model loop
 * and reaches state only through this session. Every call is refused once
 * the attempt is no longer the run's current one (settled, recovered or
 * taken over).
 */
export interface WorkerSession {
  readonly run: WorkerRun;
  /** The narrowed worker scope: the parent's audience, admission capped at the grant's ceiling, granted actions only. */
  readonly scope: TrustedTurnScope;
  /** Starts the next model turn: counts it against `maxTurns`, renews the lease and returns new guidance. */
  beginTurn(): Promise<Result<WorkerTurnGate>>;
  /**
   * Dispatches one tool call under the worker scope. Writes pass an effect
   * fence keyed by `effectKey`, which the host keeps stable when it retries
   * the same call: a retry replays the recorded result instead of repeating
   * the effect, and an effect whose outcome is unknown is never executed again.
   */
  call(effectKey: string, call: ToolCall): Promise<Result<AttributedToolResult>>;
  /** Settles the run with the attempt's outcome and binds the result to the run's source and activity. */
  finish(report: WorkerReport): Promise<Result<WorkerRun>>;
}

/**
 * Bounded execution supplied by the active harness. Core decides authority and
 * records lifecycle; the harness runs the loop with only the session's tools.
 */
export interface WorkerHostPort {
  /** Accepts a claimed attempt. A refusal returns the run to the queue untouched. */
  start(session: WorkerSession): Promise<Result<void>>;
  /** Asks a running attempt to stop; it still settles through its session. */
  cancel(runId: WorkerRunId): Promise<Result<void>>;
}
