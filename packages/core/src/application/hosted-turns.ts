import type {
  SessionArchivePort,
  TurnLedgerPort,
  TurnOutcome,
  TurnOwner,
  TurnRecord,
} from '../sessions/index.ts';
import { conflict, denied, invalid, notFound, ok, sameAudience, type IdempotencyKey, type Result, type SessionId, type TurnId } from '../shared/index.ts';
import type { EmotionService } from './emotion-service.ts';
import type { SessionService } from './session-service.ts';
import type { TurnContextAssembler, TurnContextLimits, TurnContextParts } from './turn-context.ts';
import { sameOwner, turnEntries } from './turn-history.ts';
import type { TriggerInput, TurnLifecycle } from './turn-lifecycle.ts';
import { isTrustedTurnScope, type TrustedTurnScope } from './trusted-scope.ts';
import type { WorkerRunner } from './worker-runner.ts';

/**
 * Turns run by an external host (a companion harness outside this process,
 * such as Hermes) against core's lifecycle. The host's transport admits the
 * caller from its credential and supplies only the host's process instance,
 * the idempotency key and, for participant turns, the message; everything
 * else — session, trigger attribution, ownership checks, settlement order,
 * post-turn work — is core's existing lifecycle and services. A host may
 * prepare, settle and checkpoint only turns of the audience it was admitted
 * for, and settle only turns it owns.
 */
export interface HostedTurns {
  prepare(scope: TrustedTurnScope, input: HostedPrepareInput): Promise<Result<HostedPrepared>>;
  settle(scope: TrustedTurnScope, input: HostedSettleInput): Promise<Result<HostedSettled>>;
  /**
   * Before the host compacts its own working context: proves every named turn
   * of this audience is in canonical history (repairing an incomplete append),
   * so dropping the host's copy loses no source evidence. Any turn that is
   * missing or belongs to another audience refuses the whole checkpoint.
   */
  checkpoint(scope: TrustedTurnScope, input: HostedCheckpointInput): Promise<Result<HostedCheckpoint>>;
}

export interface HostedPrepareInput {
  readonly owner: TurnOwner;
  readonly idempotencyKey: IdempotencyKey;
  readonly trigger: TriggerInput;
}

export type HostedPrepared =
  | {
      readonly kind: 'prepared';
      readonly turnId: TurnId;
      readonly sessionId: SessionId;
      /** True when this key's turn was already open: the host is resuming it, not starting a new one. */
      readonly resumed: boolean;
      readonly context: TurnContextParts;
    }
  | { readonly kind: 'replayed'; readonly record: TurnRecord };

export interface HostedSettleInput {
  readonly owner: TurnOwner;
  readonly turnId: TurnId;
  readonly outcome: TurnOutcome;
  /** Governed tool calls the host made in the turn; an emotion signal, never authority. */
  readonly toolCallCount: number;
}

export interface HostedSettled {
  readonly record: TurnRecord;
  /** False when the turn had already settled with this outcome and only its history was repaired. */
  readonly settledNow: boolean;
  /** Post-turn work, run only when the turn settled now; each part reports its own failure. */
  readonly postTurn: {
    readonly emotion: Result<unknown> | null;
    readonly workers: Result<unknown> | null;
  };
}

export interface HostedCheckpointInput {
  readonly turnIds: readonly TurnId[];
}

export interface HostedCheckpoint {
  readonly settled: readonly TurnId[];
  /** Turns still open; their trigger is in history, their outcome is not yet. */
  readonly open: readonly TurnId[];
}

export interface HostedTurnsDeps {
  readonly lifecycle: TurnLifecycle;
  readonly ledger: Pick<TurnLedgerPort, 'head' | 'get'>;
  readonly archive: Pick<SessionArchivePort, 'append'>;
  readonly sessions: Pick<SessionService, 'current'>;
  readonly context: TurnContextAssembler;
  readonly emotion: Pick<EmotionService, 'observeTurn'>;
  readonly workers: Pick<WorkerRunner, 'resume'>;
  readonly limits: TurnContextLimits;
}

const PREPARE_ATTEMPTS = 3;
const MAX_CHECKPOINT_TURNS = 500;

export function createHostedTurns(deps: HostedTurnsDeps): HostedTurns {
  /**
   * Another owner's open turn is recovered once its lease lapsed (a host
   * process that restarted has a new instance). This owner's own open turn
   * may still be running, so it is refused: the host settles its own turns.
   */
  const clearOpenTurn = async (scope: TrustedTurnScope, sessionId: SessionId, owner: TurnOwner): Promise<Result<void>> => {
    const head = await deps.ledger.head(sessionId);
    if (!head.ok) return head;
    if (head.value.openTurnId === null) return ok(undefined);
    const open = await deps.ledger.get(head.value.openTurnId);
    if (!open.ok) return open;
    if (sameOwner(open.value.owner, owner)) {
      return conflict('turn_already_open', `turn ${open.value.turnId} of this host is still open in the session; settle it first`);
    }
    const recovered = await deps.lifecycle.recoverTurn(scope, { sessionId, owner });
    return !recovered.ok && recovered.error.kind !== 'not_found' ? recovered : ok(undefined);
  };

  const visibleTurn = async (scope: TrustedTurnScope, turnId: TurnId): Promise<Result<TurnRecord>> => {
    const found = await deps.ledger.get(turnId);
    if (!found.ok) return found.error.kind === 'not_found' ? notFound(`turn ${turnId}`) : found;
    // Another audience's turn reads exactly like a missing one.
    return sameAudience(found.value.audience, scope.audience) ? found : notFound(`turn ${turnId}`);
  };

  return {
    async prepare(scope, input) {
      if (!isTrustedTurnScope(scope)) return denied('unknown_authority', 'scope was not admitted by ingress');
      if (scope.caller.kind === 'worker') return denied('worker_not_permitted', 'workers do not run host turns');
      const session = await deps.sessions.current(scope);
      if (!session.ok) return session;
      const sessionId = session.value.sessionId;
      let refused: Result<never> = conflict('stale_revision', 'the session kept changing while the turn was prepared');
      for (let attempt = 0; attempt < PREPARE_ATTEMPTS; attempt += 1) {
        const head = await deps.ledger.head(sessionId);
        if (!head.ok) return head;
        // Assembled against this revision; prepareTurn refuses it if the session moved since.
        const context = await deps.context.assemble(scope, { sessionId, limits: deps.limits, excludeTurn: null });
        if (!context.ok) return context;
        const prepared = await deps.lifecycle.prepareTurn(scope, {
          sessionId,
          owner: input.owner,
          idempotencyKey: input.idempotencyKey,
          expectedRevision: head.value.revision,
          trigger: input.trigger,
        });
        if (prepared.ok) {
          if (prepared.value.kind === 'replayed') return ok({ kind: 'replayed', record: prepared.value.record });
          const { record } = prepared.value.turn;
          if (head.value.openTurnId !== record.turnId) {
            return ok({ kind: 'prepared', turnId: record.turnId, sessionId, resumed: false, context: context.value });
          }
          // The key's turn was already open: show the history as it was before its trigger.
          const resumed = await deps.context.assemble(scope, { sessionId, limits: deps.limits, excludeTurn: record.turnId });
          if (!resumed.ok) return resumed;
          return ok({ kind: 'prepared', turnId: record.turnId, sessionId, resumed: true, context: resumed.value });
        }
        const error = prepared.error;
        if (error.kind !== 'conflict') return prepared;
        refused = prepared;
        if (error.reason === 'stale_revision') continue;
        if (error.reason !== 'turn_already_open') return prepared;
        const cleared = await clearOpenTurn(scope, sessionId, input.owner);
        if (!cleared.ok) return cleared;
      }
      return refused;
    },

    async settle(scope, input) {
      if (!isTrustedTurnScope(scope)) return denied('unknown_authority', 'scope was not admitted by ingress');
      if (!Number.isInteger(input.toolCallCount) || input.toolCallCount < 0) return invalid('toolCallCount must be a non-negative integer');
      const found = await visibleTurn(scope, input.turnId);
      if (!found.ok) return found;
      const turn = { scope, record: found.value };
      const before = found.value.settlement;
      const settled =
        input.outcome.kind === 'completed'
          ? await deps.lifecycle.commitTurn(turn, input.owner, input.outcome)
          : await deps.lifecycle.abortTurn(turn, input.owner, input.outcome);
      if (!settled.ok) return settled;
      if (before !== null) return ok({ record: settled.value, settledNow: false, postTurn: { emotion: null, workers: null } });
      const emotion = await deps.emotion.observeTurn(scope, { turnId: input.turnId, toolCallCount: input.toolCallCount });
      const workers = scope.caller.kind === 'participant' ? await deps.workers.resume(scope) : null;
      return ok({ record: settled.value, settledNow: true, postTurn: { emotion, workers } });
    },

    async checkpoint(scope, input) {
      if (!isTrustedTurnScope(scope)) return denied('unknown_authority', 'scope was not admitted by ingress');
      if (input.turnIds.length > MAX_CHECKPOINT_TURNS) return invalid(`a checkpoint names at most ${MAX_CHECKPOINT_TURNS} turns`);
      const settled: TurnId[] = [];
      const open: TurnId[] = [];
      for (const turnId of new Set(input.turnIds)) {
        const found = await visibleTurn(scope, turnId);
        if (!found.ok) return found;
        // Identical entries are no-ops, so this both proves and repairs the turn's history.
        const archived = await deps.archive.append(turnEntries(found.value));
        if (!archived.ok) return archived;
        (found.value.settlement === null ? open : settled).push(turnId);
      }
      return ok({ settled, open });
    },
  };
}
