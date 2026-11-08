/**
 * The Pi companion harness: conversation turns and companion-internal turns
 * strictly through core's lifecycle.
 *
 *   ingress.admit -> sessions.current -> assemble context -> prepareTurn
 *   -> model loop (one Pi tool per domain tool, every call through the core
 *      dispatcher under the turn's scope)
 *   -> deliver -> commitTurn | abortTurn
 *   -> post-turn: emotion.observeTurn, and workers.resume for participants.
 *
 * A retried request replays its settled turn instead of executing again. A
 * turn is never executed twice: when the outcome could not be recorded, the
 * harness holds it and a retry of the request, or the session's next turn,
 * records it (see turn-settler.ts). An open turn of this harness that is not
 * running here is recorded as interrupted by the host. A turn a crashed
 * predecessor left open is recovered the same way once its lease expires,
 * then the new turn is prepared. Every ending is recorded: interruption and
 * failure are settled with their cause and any partial reply, never dropped.
 * After `shutdown` no turn starts, and one already preparing is recorded as
 * interrupted by shutdown without calling the model.
 */
import { createHash } from 'node:crypto';
import {
  TOOL_INVENTORY,
  conflict,
  internalContext,
  invalid,
  ok,
  parseId,
  unavailable,
  type DeliveryStatus,
  type EmotionService,
  type InternalTurnPort,
  type ObserveOutcome,
  type PreparedTurn,
  type Result,
  type SessionId,
  type SessionService,
  type ToolDispatcher,
  type TriggerInput,
  type TrustedIngress,
  type TrustedTurnScope,
  type TurnLedgerPort,
  type TurnId,
  type TurnLifecycle,
  type TurnOutcome,
  type TurnOwner,
  type TurnRecord,
  type WorkerRun,
  type WorkerRunner,
} from './core.ts';
import { assembleTurnContext, type ContextLimits, type TurnContext, type TurnContextSources } from './context.ts';
import { runModelLoop, type LoopUsage } from './loop.ts';
import type { PiModelRuntime } from './model-runtime.ts';
import type { Message } from './pi.ts';
import { labelledText, toModelMessages } from './render.ts';
import { TurnInterruption, deliveryStatusOf, interruptedBeforeStart, settledView, unfinishedOutcome, type InterruptedBy, type SettledStatus } from './settlement.ts';
import { piTools } from './tools.ts';
import { createTurnSettler, type SettledTurn } from './turn-settler.ts';

/** The channel a participant turn's reply goes out on, owned by the host. */
export interface ReplyDeliveryPort {
  /** ok once delivered; `denied`, `invalid` or `not_found` only when it definitely did not go out. */
  deliver(scope: TrustedTurnScope, reply: string): Promise<Result<void>>;
}

export interface HarnessLimits extends ContextLimits {
  /** Model calls one turn may make; the circuit breaker against a runaway tool loop. */
  readonly maxModelCalls: number;
  readonly maxToolResultChars: number;
}

export interface CompanionHarnessDeps {
  readonly ingress: TrustedIngress;
  readonly lifecycle: TurnLifecycle;
  readonly sessions: Pick<SessionService, 'current'>;
  readonly ledger: Pick<TurnLedgerPort, 'head' | 'get'>;
  readonly context: TurnContextSources;
  readonly dispatcher: ToolDispatcher;
  readonly emotion: Pick<EmotionService, 'observeTurn'>;
  readonly workers: Pick<WorkerRunner, 'resume'>;
  readonly runtime: PiModelRuntime;
  readonly owner: TurnOwner;
  readonly delivery: ReplyDeliveryPort;
  readonly limits: HarnessLimits;
}

export interface ConversationRequest {
  /** Host transport evidence; ingress verifies it. */
  readonly evidence: unknown;
  readonly text: string;
  /** Stable per request: a retry with the same key replays the settled turn. */
  readonly idempotencyKey: string;
  /** Abort with a `TurnInterruption` reason to attribute the interruption. */
  readonly signal?: AbortSignal;
}

export interface PostTurnReport {
  /** The emotion observation of the settled turn; a failure is reported here, not hidden. */
  readonly emotion: Result<ObserveOutcome>;
  /** Requeued worker runs of this conversation driven after the turn; null for internal turns, where the scheduler resumes. */
  readonly workers: Result<readonly WorkerRun[]> | null;
}

export interface TurnReport {
  readonly status: SettledStatus | 'replayed';
  readonly record: TurnRecord;
  readonly reply: string | null;
  readonly delivery: DeliveryStatus;
  readonly usage: LoopUsage | null;
  readonly postTurn: PostTurnReport | null;
}

export interface CompanionHarness {
  converse(request: ConversationRequest): Promise<Result<TurnReport>>;
  /** Core's `InternalTurnPort`: free time, scheduled prompts. */
  readonly internalTurns: InternalTurnPort;
  /** Aborts every turn in progress, including one still preparing; each settles as interrupted by `by`. Returns how many there were. */
  interruptAll(by: InterruptedBy): number;
  /** Refuses new turns from now on and interrupts every turn in progress as `shutdown`. */
  shutdown(): number;
  activeTurns(): number;
  /** Turns whose outcome is known but could not be recorded yet; a retry or the session's next turn records them. */
  unsettledTurns(): readonly TurnId[];
  /** Tries once more to record every held outcome (a host does this before it closes storage); returns the turn ids still unrecorded. */
  settleHeld(): Promise<readonly TurnId[]>;
}

export function createCompanionHarness(deps: CompanionHarnessDeps): Result<CompanionHarness> {
  const { limits } = deps;
  const positive = (n: number) => Number.isInteger(n) && n >= 1;
  const issues: string[] = [];
  if (!positive(limits.maxModelCalls)) issues.push('maxModelCalls must be a positive integer');
  if (!positive(limits.maxToolResultChars)) issues.push('maxToolResultChars must be a positive integer');
  if (!positive(limits.historyEntries)) issues.push('historyEntries must be a positive integer');
  if (!positive(limits.selfStateItems)) issues.push('selfStateItems must be a positive integer');
  if (issues.length > 0) return invalid(...issues);
  /** Every turn in progress, from before prepare until it settled; interruptAll reaches all of them. */
  const controllers = new Set<AbortController>();
  /** Turns of this owner that are executing in this process; any other open turn of this owner was abandoned. */
  const running = new Set<TurnId>();
  const settler = createTurnSettler({ lifecycle: deps.lifecycle, owner: deps.owner });
  let closing = false;

  /**
   * Clears the session's open turn so a new one can be prepared. A turn of this
   * owner that is not running here is settled (its held outcome, or abandoned);
   * one a predecessor left is recovered once its lease expired.
   */
  const clearOpenTurn = async (scope: TrustedTurnScope, sessionId: SessionId): Promise<Result<void>> => {
    const head = await deps.ledger.head(sessionId);
    if (!head.ok) return head;
    if (head.value.openTurnId === null) return ok(undefined);
    const open = await deps.ledger.get(head.value.openTurnId);
    if (!open.ok) return open;
    if (sameOwner(open.value.owner, deps.owner)) {
      if (running.has(open.value.turnId)) return conflict('turn_already_open', 'another turn of this session is running in this harness');
      const settled = await settler.settleAbandoned({ scope, record: open.value });
      return settled.ok ? ok(undefined) : settled;
    }
    const recovered = await deps.lifecycle.recoverTurn(scope, { sessionId, owner: deps.owner });
    if (!recovered.ok && recovered.error.kind !== 'not_found') return recovered;
    return ok(undefined);
  };

  const prepare = async (scope: TrustedTurnScope, sessionId: SessionId, trigger: TriggerInput, key: string): Promise<Result<Prepared>> => {
    const idempotencyKey = parseId('idempotency_key', key);
    if (!idempotencyKey.ok) return idempotencyKey;
    let refused: Result<never> = conflict('stale_revision', 'the session kept changing while the turn was prepared');
    for (let attempt = 0; attempt < PREPARE_ATTEMPTS; attempt += 1) {
      const head = await deps.ledger.head(sessionId);
      if (!head.ok) return head;
      // Context is assembled against this revision; prepareTurn refuses it if the session moved since.
      const context = await assembleTurnContext(deps.context, scope, sessionId, limits);
      if (!context.ok) return context;
      const prepared = await deps.lifecycle.prepareTurn(scope, {
        sessionId,
        owner: deps.owner,
        idempotencyKey: idempotencyKey.value,
        expectedRevision: head.value.revision,
        trigger,
      });
      if (prepared.ok) {
        if (prepared.value.kind === 'replayed') return ok({ kind: 'replayed', record: prepared.value.record });
        const { turn } = prepared.value;
        // Core hands back the open turn of an earlier attempt with this key; that attempt already ran.
        if (head.value.openTurnId === turn.record.turnId) return ok({ kind: 'reopened', turn });
        return ok({ kind: 'prepared', turn, context: context.value });
      }
      const error = prepared.error;
      if (error.kind !== 'conflict') return prepared;
      if (error.reason === 'stale_revision') {
        refused = prepared;
        continue;
      }
      if (error.reason !== 'turn_already_open') return prepared;
      const cleared = await clearOpenTurn(scope, sessionId);
      if (!cleared.ok) return cleared;
      refused = prepared;
    }
    return refused;
  };

  /** Post-turn work for a turn that settled now: the emotion observation, then the conversation's requeued workers. */
  const afterSettled = async (scope: TrustedTurnScope, settled: SettledTurn, usage: LoopUsage | null): Promise<Result<TurnReport>> => {
    const view = settledView(settled.record);
    if (view === null) return invalid('a settled turn has an outcome');
    const emotion = await deps.emotion.observeTurn(scope, { turnId: settled.record.turnId, toolCallCount: settled.toolCalls });
    const workers = scope.caller.kind === 'participant' ? await deps.workers.resume(scope) : null;
    return ok({ status: view.status, record: settled.record, reply: view.reply, delivery: view.delivery, usage, postTurn: { emotion, workers } });
  };

  /** Runs the model loop and delivers a completed reply. Never throws: anything unexpected is a recorded failure. */
  const execute = async (turn: PreparedTurn, context: TurnContext, prompt: string, signal: AbortSignal, channel: boolean): Promise<{ readonly outcome: TurnOutcome; readonly usage: LoopUsage | null }> => {
    if (signal.aborted) return { outcome: interruptedBeforeStart(signal.reason), usage: null };
    try {
      const now = Date.now();
      const loop = await runModelLoop({
        runtime: deps.runtime,
        systemPrompt: context.systemPrompt,
        history: toModelMessages(context.history, deps.runtime.model, now),
        prompt: { role: 'user', content: prompt, timestamp: now } satisfies Message,
        tools: piTools(TOOL_INVENTORY, (_id, call) => deps.dispatcher.dispatch(turn.scope, call), () => true, { maxResultChars: limits.maxToolResultChars }),
        signal,
        maxModelCalls: limits.maxModelCalls,
      });
      if (loop.kind !== 'completed') return { outcome: unfinishedOutcome(loop), usage: loop.usage };
      const delivery: DeliveryStatus = channel && loop.reply !== null ? await deliver(turn.scope, loop.reply) : 'not_attempted';
      return { outcome: { kind: 'completed', reply: loop.reply, delivery }, usage: loop.usage };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { outcome: { kind: 'failed', error: { code: 'harness_error', message }, partialReply: null, delivery: 'not_attempted' }, usage: null };
    }
  };

  /** A throwing delivery port may or may not have sent the reply. */
  const deliver = async (scope: TrustedTurnScope, reply: string): Promise<DeliveryStatus> => {
    try {
      return deliveryStatusOf(await deps.delivery.deliver(scope, reply));
    } catch {
      return 'unknown';
    }
  };

  const runTurn = async (
    scope: TrustedTurnScope,
    trigger: TriggerInput,
    key: string,
    signal: AbortSignal | undefined,
    channel: boolean,
  ): Promise<Result<TurnReport>> => {
    if (closing) return unavailable('companion_harness', 'the harness is shutting down');
    const prompt = triggerMessage(trigger);
    if (!prompt.ok) return prompt;
    const session = await deps.sessions.current(scope);
    if (!session.ok) return session;
    // Registered before prepare, so an interruption during prepare is recorded instead of missed.
    const controller = new AbortController();
    const onAbort = () => controller.abort(signal?.reason);
    if (signal?.aborted === true) onAbort();
    signal?.addEventListener('abort', onAbort, { once: true });
    controllers.add(controller);
    try {
      const prepared = await prepare(scope, session.value.sessionId, trigger, key);
      if (!prepared.ok) return prepared;
      if (prepared.value.kind === 'replayed') {
        const record = prepared.value.record;
        const view = settledView(record);
        if (view === null) return invalid('a replayed turn is settled');
        return ok({ record, reply: view.reply, delivery: view.delivery, status: 'replayed', usage: null, postTurn: null });
      }
      const { turn } = prepared.value;
      const turnId = turn.record.turnId;
      if (running.has(turnId)) return conflict('turn_already_open', 'this request is still running in this harness');
      if (prepared.value.kind === 'reopened') {
        // Re-issue the outcome this harness already knows, or record the turn as abandoned; never run it twice.
        const settled = await settler.settleAbandoned(turn);
        return settled.ok ? afterSettled(turn.scope, settled.value, null) : settled;
      }
      running.add(turnId);
      let executed: { readonly outcome: TurnOutcome; readonly usage: LoopUsage | null };
      try {
        executed = await execute(turn, prepared.value.context, prompt.value, controller.signal, channel);
      } finally {
        running.delete(turnId);
      }
      // A write that still fails is held; a retry of this request, or the session's next turn, records it.
      const settled = await settler.settle(turn, executed.outcome, executed.usage?.toolCalls ?? 0);
      if (!settled.ok) return settled;
      return afterSettled(turn.scope, settled.value, executed.usage);
    } finally {
      signal?.removeEventListener('abort', onAbort);
      controllers.delete(controller);
    }
  };

  const internalTurns: InternalTurnPort = {
    async run(request) {
      const key = `internal:${request.reference.kind}:${createHash('sha256').update(`${request.reference.id}\n${request.prompt}`).digest('hex').slice(0, 40)}`;
      const trigger: TriggerInput = {
        kind: 'internal',
        origin: { kind: 'system_note', source: request.purpose },
        purpose: request.purpose,
        text: request.prompt,
      };
      const report = await runTurn(request.scope, trigger, key, undefined, false);
      if (!report.ok) return report;
      const view = settledView(report.value.record);
      if (view === null) return invalid('an internal turn settles');
      return ok({ status: view.status, reply: view.reply });
    },
  };

  const interruptAll = (by: InterruptedBy): number => {
    const current = [...controllers];
    for (const controller of current) controller.abort(new TurnInterruption(by));
    return current.length;
  };

  return ok({
    async converse(request) {
      const scope = await deps.ingress.admit(request.evidence);
      if (!scope.ok) return scope;
      if (scope.value.caller.kind !== 'participant') return invalid('conversation turns come from participants; internal turns run through internalTurns');
      return runTurn(scope.value, { kind: 'participant_message', text: request.text }, request.idempotencyKey, request.signal, true);
    },
    internalTurns,
    interruptAll,
    shutdown() {
      closing = true;
      return interruptAll('shutdown');
    },
    activeTurns: () => controllers.size,
    unsettledTurns: () => settler.held(),
    settleHeld: () => settler.flush(),
  });
}

const PREPARE_ATTEMPTS = 3;

type Prepared =
  | { readonly kind: 'prepared'; readonly turn: PreparedTurn; readonly context: TurnContext }
  | { readonly kind: 'reopened'; readonly turn: PreparedTurn }
  | { readonly kind: 'replayed'; readonly record: TurnRecord };

function sameOwner(a: TurnOwner, b: TurnOwner): boolean {
  return a.surface === b.surface && a.instance === b.instance;
}

/** The trigger as the model sees it, rendered exactly as history renders it: participant speech or a system note, each with its label. */
function triggerMessage(trigger: TriggerInput): Result<string> {
  if (trigger.kind === 'participant_message') return ok(labelledText({ role: 'participant', label: null, text: trigger.text }));
  const entry = internalContext(trigger.origin, trigger.text);
  return entry.ok ? ok(labelledText(entry.value)) : entry;
}
