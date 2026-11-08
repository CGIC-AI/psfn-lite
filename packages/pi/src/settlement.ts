/**
 * How a model loop's ending becomes the recorded turn outcome. Each ending
 * maps to exactly one outcome: a completed loop commits its reply and the
 * actual delivery status; an aborted loop is an interruption by whoever
 * aborted it; a provider error, a harness error or a refused next call is a
 * failure with its cause. Nothing is guessed.
 */
import type { CoreError, DeliveryStatus, Result, TurnOutcome, TurnRecord } from './core.ts';
import type { LoopOutcome } from './loop.ts';

export type InterruptedBy = Extract<TurnOutcome, { kind: 'interrupted' }>['by'];

/** The abort reason a harness caller passes to its signal so the interruption is attributed. */
export class TurnInterruption extends Error {
  readonly by: InterruptedBy;
  constructor(by: InterruptedBy) {
    super(`turn interrupted by ${by}`);
    this.name = 'TurnInterruption';
    this.by = by;
  }
}

/** Delivery port results read the way core reads reminder deliveries: only a definite refusal means "not sent". */
export function deliveryStatusOf(result: Result<void>): DeliveryStatus {
  if (result.ok) return 'delivered';
  return definiteRefusal(result.error) ? 'not_delivered' : 'unknown';
}

function definiteRefusal(error: CoreError): boolean {
  return error.kind === 'denied' || error.kind === 'invalid' || error.kind === 'not_found';
}

/** The outcome of a loop that did not complete; the partial reply never reached the channel. */
export function unfinishedOutcome(outcome: Exclude<LoopOutcome, { kind: 'completed' }>): Exclude<TurnOutcome, { kind: 'completed' }> {
  const delivery: DeliveryStatus = outcome.partialReply === null ? 'not_attempted' : 'not_delivered';
  switch (outcome.kind) {
    case 'aborted':
      return { kind: 'interrupted', by: outcome.reason instanceof TurnInterruption ? outcome.reason.by : 'host', partialReply: outcome.partialReply, delivery };
    case 'failed':
      return { kind: 'failed', error: { code: outcome.code, message: outcome.message }, partialReply: outcome.partialReply, delivery };
    case 'stopped':
      return { kind: 'failed', error: { code: 'turn_stopped', message: outcome.reason }, partialReply: outcome.partialReply, delivery };
  }
}

export type SettledStatus = 'completed' | 'interrupted' | 'failed';

/** The status and companion text a settled record carries. */
export function settledView(record: TurnRecord): { readonly status: SettledStatus; readonly reply: string | null; readonly delivery: DeliveryStatus } | null {
  const outcome = record.settlement?.outcome;
  if (outcome === undefined) return null;
  return {
    status: outcome.kind,
    reply: outcome.kind === 'completed' ? outcome.reply : outcome.partialReply,
    delivery: outcome.delivery,
  };
}
