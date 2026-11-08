import type { WorkerEffect, WorkerEffectPort, WorkerRun } from '../automata/index.ts';
import { conflict, fail, invalid, ok, type Clock, type CoreError, type Result } from '../shared/index.ts';
import type { AttributedToolResult, ToolCall, ToolDispatcher } from './dispatch.ts';
import { resolveAction, TOOL_INVENTORY } from './tool-inventory.ts';
import type { TrustedTurnScope } from './trusted-scope.ts';
import { digest } from './turn-history.ts';

const EFFECT_KEY = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,199}$/;

/**
 * The effect fence for worker writes (donor
 * `src/core/agent/background-work/store-port.ts`: begin, cross the boundary,
 * complete). A `started` receipt is durable before the write runs. A definite
 * result settles it as `applied` (the result is kept and replayed to any
 * retry) or `rejected` (nothing was written; the error is replayed). An
 * `unavailable` failure may have landed partway, so it settles as
 * `outcome_unknown`, as does a receipt a crash left `started`. Neither is ever
 * executed again: the retry returns an `outcome_unknown` conflict and recovery
 * blocks the run. Reads are not fenced.
 */
export async function fencedCall(
  deps: { readonly effects: WorkerEffectPort; readonly dispatcher: ToolDispatcher; readonly clock: Clock },
  input: { readonly run: WorkerRun; readonly attempt: number; readonly scope: TrustedTurnScope; readonly effectKey: string; readonly call: ToolCall },
): Promise<Result<AttributedToolResult>> {
  const resolved = resolveAction(TOOL_INVENTORY, input.call.tool, input.call.action);
  if (!resolved.ok) return resolved;
  if (resolved.value.action.access === 'read') return deps.dispatcher.dispatch(input.scope, input.call);
  if (!EFFECT_KEY.test(input.effectKey)) return invalid('effectKey must be 1-200 characters of [A-Za-z0-9:._-] starting alphanumeric');

  const requestDigest = digest({ tool: input.call.tool, action: input.call.action, args: input.call.args });
  const begun = await deps.effects.begin({
    runId: input.run.id,
    effectKey: input.effectKey,
    tool: input.call.tool,
    action: input.call.action,
    requestDigest,
    attempt: input.attempt,
    phase: 'started',
    result: null,
    error: null,
    startedAt: deps.clock.now().toISOString(),
    settledAt: null,
  });
  if (!begun.ok) return begun;
  const { effect } = begun.value;
  if (!begun.value.created) return replay(effect, requestDigest);

  const dispatched = await deps.dispatcher.dispatch(input.scope, input.call);
  const settledAt = deps.clock.now().toISOString();
  const outcome: WorkerEffect = dispatched.ok
    ? { ...effect, phase: 'applied', result: dispatched.value.content, settledAt }
    : { ...effect, phase: dispatched.error.kind === 'unavailable' ? 'outcome_unknown' : 'rejected', error: dispatched.error, settledAt };
  const settled = await deps.effects.settle(outcome);
  // An unrecorded outcome must not be reported as a clean result: the receipt stays `started`, which reads as unknown.
  if (!settled.ok) return settled;
  return dispatched;
}

function replay(effect: WorkerEffect, requestDigest: string): Result<AttributedToolResult> {
  if (effect.requestDigest !== requestDigest) return conflict('idempotency_mismatch', `effect ${effect.effectKey} was already used for a different call`);
  switch (effect.phase) {
    case 'applied':
      return ok({ origin: { kind: 'tool_result', tool: effect.tool, action: effect.action }, content: effect.result });
    case 'rejected':
      return fail(effect.error ?? unknownError(effect));
    case 'started':
    case 'outcome_unknown':
      return fail(unknownError(effect));
  }
}

function unknownError(effect: WorkerEffect): CoreError {
  return {
    kind: 'conflict',
    reason: 'outcome_unknown',
    detail: `effect ${effect.effectKey} (${effect.tool}.${effect.action}) started without a recorded outcome; it is not executed again`,
  };
}
