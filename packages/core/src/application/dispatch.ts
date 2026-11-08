import {
  denied,
  fail,
  invalid,
  isRecord,
  ok,
  unavailable,
  type ActionDescriptor,
  type Result,
  type ToolDescriptor,
} from '../shared/index.ts';
import { resolveAction } from './tool-inventory.ts';
import { isTrustedTurnScope, type TrustedTurnScope } from './trusted-scope.ts';

export interface ToolCall {
  readonly tool: string;
  readonly action: string;
  /** Model-supplied arguments. They never carry authority. */
  readonly args: unknown;
}

/** A domain operation. Authority arrives as `scope`, separately from model arguments. */
export type ActionHandler = (
  scope: TrustedTurnScope,
  args: Readonly<Record<string, unknown>>,
) => Promise<Result<unknown>>;

/** Handlers keyed by tool then action. Absent handlers report `unavailable`. */
export type ActionHandlers = Readonly<Record<string, Readonly<Record<string, ActionHandler>>>>;

/** A tool result, attributed so a harness renders it as labelled context. */
export interface AttributedToolResult {
  readonly origin: { readonly kind: 'tool_result'; readonly tool: string; readonly action: string };
  readonly content: unknown;
}

export interface ToolDispatcher {
  dispatch(scope: TrustedTurnScope, call: ToolCall): Promise<Result<AttributedToolResult>>;
}

/** Argument names that would look like authority; rejecting them keeps attempts visible. */
const RESERVED_AUTHORITY_KEYS = ['viewer', 'caller', 'callerContactId', 'companionId', 'trustedScope', 'admitted'];

export function createToolDispatcher(deps: {
  readonly inventory: readonly ToolDescriptor[];
  readonly handlers: ActionHandlers;
}): Result<ToolDispatcher> {
  const issues: string[] = [];
  for (const [tool, actions] of Object.entries(deps.handlers)) {
    for (const action of Object.keys(actions)) {
      if (!resolveAction(deps.inventory, tool, action).ok) issues.push(`handler ${tool}.${action} is not in the inventory`);
    }
  }
  if (issues.length > 0) return invalid(...issues);
  return ok({ dispatch: (scope, call) => dispatch(deps, scope, call) });
}

async function dispatch(
  deps: { readonly inventory: readonly ToolDescriptor[]; readonly handlers: ActionHandlers },
  scope: TrustedTurnScope,
  call: ToolCall,
): Promise<Result<AttributedToolResult>> {
  if (!isTrustedTurnScope(scope)) return denied('unknown_authority', 'scope was not admitted by ingress');
  const resolved = resolveAction(deps.inventory, call.tool, call.action);
  if (!resolved.ok) return resolved;
  const { action } = resolved.value;
  if (!isRecord(call.args)) return invalid('tool arguments must be an object');
  const reserved = RESERVED_AUTHORITY_KEYS.filter((key) => Object.hasOwn(call.args as object, key));
  if (reserved.length > 0) return invalid(`authority cannot be passed as arguments: ${reserved.join(', ')}`);

  const gate = enforceDeclaredRestrictions(scope, call, action);
  if (!gate.ok) return gate;

  const handler = deps.handlers[call.tool]?.[call.action];
  if (handler === undefined) return unavailable(`${call.tool}.${call.action}`, 'no handler is configured for this action');
  const result = await handler(scope, call.args);
  if (!result.ok) return fail(result.error);
  return ok({ origin: { kind: 'tool_result', tool: call.tool, action: call.action }, content: result.value });
}

function enforceDeclaredRestrictions(scope: TrustedTurnScope, call: ToolCall, action: ActionDescriptor): Result<void> {
  if (!scope.admitted.includes(action.admission)) {
    return denied('audience_not_admitted', `${call.tool}.${call.action} requires ${action.admission} admission`);
  }
  if (action.restrictions.includes('foreground_only') && scope.turnKind !== 'foreground') {
    return denied('background_turn', `${call.tool}.${call.action} is refused in background turns`);
  }
  if (action.restrictions.includes('self_audience_only') && scope.audience.kind !== 'self') {
    return denied('requires_self_audience', `${call.tool}.${call.action} runs only in companion-internal turns`);
  }
  if (scope.caller.kind === 'worker') {
    if (action.workers === 'denied') return denied('worker_not_permitted', `workers may not call ${call.tool}.${call.action}`);
    const granted = scope.caller.grant.actions.some((g) => g.tool === call.tool && g.action === call.action);
    if (!granted) return denied('worker_not_permitted', `${call.tool}.${call.action} is outside this worker's grant`);
  }
  return ok(undefined);
}
