/**
 * Recording a turn outcome the harness already knows, so a transient storage
 * failure can neither lose it nor make the turn run twice.
 *
 * - `settle` writes the outcome through commitTurn or abortTurn. Core
 *   accepts the same owner and the same outcome again, so a transient
 *   failure (an `unavailable` result or a throw) is retried a bounded number
 *   of times.
 * - An outcome that still could not be written is held in memory by turn id.
 *   The turn stays open in the ledger, and only this owner may settle it.
 * - `settleAbandoned` settles an open turn of this owner that is not running
 *   in this process: with the held outcome when there is one, otherwise as
 *   interrupted by the host with delivery `unknown`, since nothing records
 *   how far it got. It never runs the turn again.
 */
import type { CoreError, PreparedTurn, Result, TurnId, TurnLifecycle, TurnOutcome, TurnOwner, TurnRecord } from './core.ts';

export const SETTLE_ATTEMPTS = 3;
const SETTLE_BACKOFF_MS = 25;

/** Interrupted by the host, delivery unknown: an open turn whose outcome no one recorded. */
export const ABANDONED_OUTCOME: TurnOutcome = { kind: 'interrupted', by: 'host', partialReply: null, delivery: 'unknown' };

export interface SettledTurn {
  readonly record: TurnRecord;
  /** Tool calls the turn made, for the emotion observation; 0 when the turn was abandoned unrecorded. */
  readonly toolCalls: number;
}

export interface TurnSettler {
  settle(turn: PreparedTurn, outcome: TurnOutcome, toolCalls: number): Promise<Result<SettledTurn>>;
  settleAbandoned(turn: PreparedTurn): Promise<Result<SettledTurn>>;
  /** Turn ids whose outcome is known here but not yet recorded. */
  held(): readonly TurnId[];
}

export function createTurnSettler(deps: { readonly lifecycle: Pick<TurnLifecycle, 'commitTurn' | 'abortTurn'>; readonly owner: TurnOwner }): TurnSettler {
  const held = new Map<TurnId, { readonly outcome: TurnOutcome; readonly toolCalls: number }>();

  const write = async (turn: PreparedTurn, outcome: TurnOutcome): Promise<Result<TurnRecord>> => {
    try {
      return outcome.kind === 'completed'
        ? await deps.lifecycle.commitTurn(turn, deps.owner, outcome)
        : await deps.lifecycle.abortTurn(turn, deps.owner, outcome);
    } catch (error) {
      return { ok: false, error: { kind: 'unavailable', capability: 'turn_settlement', detail: error instanceof Error ? error.message : String(error) } };
    }
  };

  const settle = async (turn: PreparedTurn, outcome: TurnOutcome, toolCalls: number): Promise<Result<SettledTurn>> => {
    const turnId = turn.record.turnId;
    let result = await write(turn, outcome);
    for (let attempt = 1; !result.ok && transient(result.error) && attempt < SETTLE_ATTEMPTS; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, SETTLE_BACKOFF_MS * attempt));
      result = await write(turn, outcome);
    }
    if (result.ok) {
      held.delete(turnId);
      return { ok: true, value: { record: result.value, toolCalls } };
    }
    // A definite refusal will not change on retry; only a transient failure keeps the outcome for later.
    if (transient(result.error)) held.set(turnId, { outcome, toolCalls });
    else held.delete(turnId);
    return result;
  };

  return {
    settle,
    settleAbandoned(turn) {
      const known = held.get(turn.record.turnId);
      return known === undefined ? settle(turn, ABANDONED_OUTCOME, 0) : settle(turn, known.outcome, known.toolCalls);
    },
    held: () => [...held.keys()],
  };
}

function transient(error: CoreError): boolean {
  return error.kind === 'unavailable';
}
