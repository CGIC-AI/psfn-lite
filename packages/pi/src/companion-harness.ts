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
 * turn a crashed predecessor left open is recovered (recorded as
 * interrupted by the host) once its lease expires, then the new turn is
 * prepared. Every ending is recorded: interruption and failure are settled
 * with their cause and any partial reply, never dropped.
 */
import { createHash } from 'node:crypto';
import {
  TOOL_INVENTORY,
  internalContext,
  invalid,
  ok,
  parseId,
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
  type TurnLifecycle,
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
import { TurnInterruption, deliveryStatusOf, settledView, unfinishedOutcome, type InterruptedBy, type SettledStatus } from './settlement.ts';
import { piTools } from './tools.ts';

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
  readonly ledger: Pick<TurnLedgerPort, 'head'>;
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
  /** Aborts every running turn; each settles as interrupted by `by`. Returns how many were running. */
  interruptAll(by: InterruptedBy): number;
  activeTurns(): number;
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
  const active = new Set<AbortController>();

  const prepare = async (
    scope: TrustedTurnScope,
    sessionId: SessionId,
    trigger: TriggerInput,
    key: string,
  ): Promise<Result<{ readonly kind: 'prepared'; readonly turn: PreparedTurn; readonly context: TurnContext } | { readonly kind: 'replayed'; readonly record: TurnRecord }>> => {
    const idempotencyKey = parseId('idempotency_key', key);
    if (!idempotencyKey.ok) return idempotencyKey;
    for (let attempt = 0; ; attempt += 1) {
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
        return prepared.value.kind === 'replayed'
          ? ok({ kind: 'replayed', record: prepared.value.record })
          : ok({ kind: 'prepared', turn: prepared.value.turn, context: context.value });
      }
      const error = prepared.error;
      if (attempt > 0 || error.kind !== 'conflict') return prepared;
      if (error.reason === 'stale_revision') continue;
      if (error.reason !== 'turn_already_open') return prepared;
      // A predecessor left this session's turn open. Once its lease ran out it is recorded as interrupted by the host.
      const recovered = await deps.lifecycle.recoverTurn(scope, { sessionId, owner: deps.owner });
      if (!recovered.ok) return recovered.error.kind === 'conflict' ? recovered : prepared;
    }
  };

  const runTurn = async (
    scope: TrustedTurnScope,
    trigger: TriggerInput,
    key: string,
    signal: AbortSignal | undefined,
    channel: boolean,
  ): Promise<Result<TurnReport>> => {
    const session = await deps.sessions.current(scope);
    if (!session.ok) return session;
    const prepared = await prepare(scope, session.value.sessionId, trigger, key);
    if (!prepared.ok) return prepared;
    if (prepared.value.kind === 'replayed') {
      const record = prepared.value.record;
      const view = settledView(record);
      if (view === null) return invalid('a replayed turn is settled');
      return ok({ record, reply: view.reply, delivery: view.delivery, status: 'replayed', usage: null, postTurn: null });
    }
    const { turn, context } = prepared.value;

    const prompt = triggerMessage(trigger);
    if (!prompt.ok) return prompt;
    const controller = new AbortController();
    const onAbort = () => controller.abort(signal?.reason);
    if (signal?.aborted === true) onAbort();
    signal?.addEventListener('abort', onAbort, { once: true });
    active.add(controller);
    let settled: Result<TurnRecord>;
    let reply: string | null = null;
    let delivery: DeliveryStatus = 'not_attempted';
    let usage: LoopUsage;
    try {
      const now = Date.now();
      const outcome = await runModelLoop({
        runtime: deps.runtime,
        systemPrompt: context.systemPrompt,
        history: toModelMessages(context.history, deps.runtime.model, now),
        prompt: { role: 'user', content: prompt.value, timestamp: now } satisfies Message,
        tools: piTools(TOOL_INVENTORY, (_id, call) => deps.dispatcher.dispatch(turn.scope, call), () => true, { maxResultChars: limits.maxToolResultChars }),
        signal: controller.signal,
        maxModelCalls: limits.maxModelCalls,
      });
      usage = outcome.usage;
      if (outcome.kind === 'completed') {
        reply = outcome.reply;
        if (channel && reply !== null) delivery = deliveryStatusOf(await deps.delivery.deliver(turn.scope, reply));
        settled = await deps.lifecycle.commitTurn(turn, deps.owner, { kind: 'completed', reply, delivery });
      } else {
        const unfinished = unfinishedOutcome(outcome);
        reply = unfinished.partialReply;
        delivery = unfinished.delivery;
        settled = await deps.lifecycle.abortTurn(turn, deps.owner, unfinished);
      }
    } finally {
      signal?.removeEventListener('abort', onAbort);
      active.delete(controller);
    }
    // A failed settlement leaves the turn open; the next prepare repairs history or recovers the turn.
    if (!settled.ok) return settled;
    const view = settledView(settled.value);
    if (view === null) return invalid('a settled turn has an outcome');

    const emotion = await deps.emotion.observeTurn(turn.scope, { turnId: settled.value.turnId, toolCallCount: usage.toolCalls });
    const workers = turn.scope.caller.kind === 'participant' ? await deps.workers.resume(turn.scope) : null;
    return ok({ status: view.status, record: settled.value, reply, delivery, usage, postTurn: { emotion, workers } });
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

  return ok({
    async converse(request) {
      const scope = await deps.ingress.admit(request.evidence);
      if (!scope.ok) return scope;
      if (scope.value.caller.kind !== 'participant') return invalid('conversation turns come from participants; internal turns run through internalTurns');
      return runTurn(scope.value, { kind: 'participant_message', text: request.text }, request.idempotencyKey, request.signal, true);
    },
    internalTurns,
    interruptAll(by) {
      const running = [...active];
      for (const controller of running) controller.abort(new TurnInterruption(by));
      return running.length;
    },
    activeTurns: () => active.size,
  });
}

/** The trigger as the model sees it: participant speech plainly, an internal trigger with its system-note label. */
function triggerMessage(trigger: TriggerInput): Result<string> {
  if (trigger.kind === 'participant_message') return ok(trigger.text);
  const entry = internalContext(trigger.origin, trigger.text);
  return entry.ok ? ok(labelledText(entry.value)) : entry;
}
