/**
 * Core's `WorkerHostPort` over the Pi model loop. Core owns the grant, the
 * lease, the turn budget, cancellation, effect fences and the result; this
 * host only runs the loop with the session's tools and reports how the
 * attempt ended.
 *
 * - Every model call is begun through `session.beginTurn()`: the first
 *   before the loop, each later one when the model asks for tools. A budget
 *   or cancel gate stops the loop, and the attempt is reported as
 *   `budget_limited` or `cancelled`.
 * - Tools are only the granted actions, and every call goes through
 *   `session.call` with an effect key derived from the attempt and a digest
 *   of the model's tool call id, so a retried call replays instead of
 *   repeating. Providers' raw ids may hold characters core refuses in a key
 *   (openai-responses ids contain `|`), so the raw id is never the key.
 * - The final text is the machine-produced summary; core records it as the
 *   worker's output, never as companion speech.
 * - The loop runs inside `start`, so a spawn or a resume returns once the
 *   attempt has settled. `cancel` aborts a running loop at once.
 * - `shutdown` refuses new attempts (core returns a refused attempt to the
 *   queue unrun) and aborts every running one; each is reported as cancelled
 *   with reason `host_shutdown`.
 */
import { createHash } from 'node:crypto';
import {
  TOOL_INVENTORY,
  ok,
  unavailable,
  type WorkerGuidance,
  type WorkerHostPort,
  type WorkerReport,
  type WorkerRunId,
  type WorkerSession,
} from './core.ts';
import { runModelLoop, type LoopOutcome } from './loop.ts';
import type { PiModelRuntime } from './model-runtime.ts';
import type { Message } from './pi.ts';
import { LABELLED_CONTEXT_NOTE, labelledText } from './render.ts';
import { describeError, piTools } from './tools.ts';

const SUMMARY_MAX = 8_000;

export interface WorkerHostOptions {
  readonly runtime: PiModelRuntime;
  readonly maxToolResultChars: number;
  /** Receives anything the host could not report through the session (a lost lease, a refused finish). */
  readonly onDiagnostic: (diagnostic: WorkerDiagnostic) => void;
}

export interface WorkerDiagnostic {
  readonly runId: WorkerRunId;
  readonly stage: 'begin_turn' | 'finish';
  readonly detail: string;
}

export interface PiWorkerHost extends WorkerHostPort {
  running(): readonly WorkerRunId[];
  /** Refuses new attempts and aborts the running ones. Returns how many were running. */
  shutdown(): number;
}

/** The abort reason of an attempt stopped because the host is shutting down. */
class HostShutdown extends Error {
  constructor() {
    super('the worker host is shutting down');
    this.name = 'HostShutdown';
  }
}

/** The effect key of one tool call of one attempt: stable for the call, and always within core's key alphabet. */
export function effectKey(attempt: number, toolCallId: string): string {
  return `attempt-${attempt}:${createHash('sha256').update(toolCallId).digest('hex').slice(0, 40)}`;
}

export function createPiWorkerHost(options: WorkerHostOptions): PiWorkerHost {
  const running = new Map<WorkerRunId, AbortController>();
  let closing = false;
  return {
    async start(session) {
      if (closing) return unavailable('worker_host', 'the worker host is shutting down');
      const controller = new AbortController();
      running.set(session.run.id, controller);
      try {
        await runAttempt(session, controller.signal, options);
      } finally {
        running.delete(session.run.id);
      }
      return ok(undefined);
    },
    cancel(runId) {
      running.get(runId)?.abort(new Error('cancel requested'));
      return Promise.resolve(ok(undefined));
    },
    running: () => [...running.keys()],
    shutdown() {
      closing = true;
      const current = [...running.values()];
      for (const controller of current) controller.abort(new HostShutdown());
      return current.length;
    },
  };
}

async function runAttempt(session: WorkerSession, signal: AbortSignal, options: WorkerHostOptions): Promise<void> {
  const { run } = session;
  const diagnose = (stage: WorkerDiagnostic['stage'], detail: string) => options.onDiagnostic({ runId: run.id, stage, detail });
  const finish = async (report: WorkerReport) => {
    const finished = await session.finish(report);
    if (!finished.ok) diagnose('finish', describeError(finished.error));
  };
  const noUsage = { modelCalls: 0, inputTokens: 0, outputTokens: 0 };

  const first = await session.beginTurn();
  if (!first.ok) return diagnose('begin_turn', describeError(first.error));
  if (first.value.kind !== 'turn') return finish(gateReport(first.value.kind, noUsage));
  let seen = first.value.guidance.length;
  // Written from the gate hook, so held in an object the compiler does not narrow.
  const gated: { stop: 'budget_exhausted' | 'cancel_requested' | null } = { stop: null };

  const granted = (tool: string, action: string) => run.grant.actions.some((g) => g.tool === tool && g.action === action);
  const outcome = await runModelLoop({
    runtime: options.runtime,
    systemPrompt: [
      `You are a bounded worker for the companion, running the task "${run.label}".`,
      'You may use only the tools listed. Your final message is your summary of the result; it is recorded as machine-produced output, not as the companion speaking.',
      LABELLED_CONTEXT_NOTE,
    ].join('\n'),
    history: [],
    prompt: { role: 'user', content: [labelledText({ role: 'labelled_context', label: 'system note: worker task', text: run.task }), ...guidanceTexts(first.value.guidance)].join('\n\n'), timestamp: Date.now() },
    tools: piTools(TOOL_INVENTORY, (toolCallId, call) => session.call(effectKey(run.attempts, toolCallId), call), granted, { maxResultChars: options.maxToolResultChars }),
    signal,
    maxModelCalls: run.grant.maxTurns,
    gate: async () => {
      const gate = await session.beginTurn();
      if (!gate.ok) {
        diagnose('begin_turn', describeError(gate.error));
        return { proceed: false, reason: `the attempt is no longer current: ${describeError(gate.error)}` };
      }
      if (gate.value.kind !== 'turn') {
        gated.stop = gate.value.kind;
        return { proceed: false, reason: gate.value.kind };
      }
      const fresh = gate.value.guidance.slice(seen);
      seen = gate.value.guidance.length;
      const steering: Message[] = guidanceTexts(fresh).map((text) => ({ role: 'user', content: text, timestamp: Date.now() }));
      return { proceed: true, steering };
    },
  });
  const usage = { modelCalls: outcome.usage.modelCalls, inputTokens: outcome.usage.inputTokens, outputTokens: outcome.usage.outputTokens };
  await finish(gated.stop !== null ? gateReport(gated.stop, usage, partialOf(outcome)) : outcomeReport(outcome, usage));
}

function guidanceTexts(guidance: readonly WorkerGuidance[]): string[] {
  return guidance.map((g) => labelledText({ role: 'labelled_context', label: 'system note: guidance for this worker', text: g.text }));
}

function partialOf(outcome: LoopOutcome): string | null {
  return outcome.kind === 'completed' ? outcome.reply : outcome.partialReply;
}

function summary(text: string | null, fallback: string): string {
  const trimmed = text?.trim() ?? '';
  if (trimmed.length === 0) return fallback;
  return trimmed.length <= SUMMARY_MAX ? trimmed : `${trimmed.slice(0, SUMMARY_MAX - 40)}\n[summary cut at ${SUMMARY_MAX} characters]`;
}

function gateReport(kind: 'budget_exhausted' | 'cancel_requested', usage: WorkerReport['usage'], partial: string | null = null): WorkerReport {
  return kind === 'cancel_requested'
    ? { outcome: 'cancelled', summary: summary(partial, 'The worker stopped because cancellation was requested.'), artifacts: [], reason: 'cancel_requested', usage }
    : { outcome: 'budget_limited', summary: summary(partial, 'The worker used its turn budget before finishing.'), artifacts: [], reason: 'turn_budget_exhausted', usage };
}

function outcomeReport(outcome: LoopOutcome, usage: WorkerReport['usage']): WorkerReport {
  switch (outcome.kind) {
    case 'completed':
      return { outcome: 'completed', summary: summary(outcome.reply, 'The worker finished without writing a summary.'), artifacts: [], reason: null, usage };
    case 'aborted':
      return outcome.reason instanceof HostShutdown
        ? { outcome: 'cancelled', summary: summary(outcome.partialReply, 'The worker was stopped because the host shut down.'), artifacts: [], reason: 'host_shutdown', usage }
        : { outcome: 'cancelled', summary: summary(outcome.partialReply, 'The worker was stopped while running.'), artifacts: [], reason: 'aborted', usage };
    case 'stopped':
      return { outcome: 'budget_limited', summary: summary(outcome.partialReply, `The worker stopped: ${outcome.reason}.`), artifacts: [], reason: outcome.reason, usage };
    case 'failed':
      return { outcome: 'blocked', summary: summary(outcome.partialReply, `The worker could not finish: ${outcome.code}.`), artifacts: [], reason: `${outcome.code}: ${outcome.message}`, usage };
  }
}
