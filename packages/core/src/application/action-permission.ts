import { denied, ok, type ActionDescriptor, type Result } from '../shared/index.ts';
import type { TrustedTurnScope } from './trusted-scope.ts';

/**
 * The declared restrictions of one inventory action for one scope: admission,
 * foreground-only and self-audience-only restrictions, worker denial and the
 * worker's grant. Dispatch applies it to every tool call; anything that shows
 * an action's data without a tool call (such as internal context) applies the
 * same check, so no path is wider than the tool.
 */
export function permitsAction(scope: TrustedTurnScope, tool: string, actionName: string, action: ActionDescriptor): Result<void> {
  if (!scope.admitted.includes(action.admission)) {
    return denied('audience_not_admitted', `${tool}.${actionName} requires ${action.admission} admission`);
  }
  if (action.restrictions.includes('foreground_only') && scope.turnKind !== 'foreground') {
    return denied('background_turn', `${tool}.${actionName} is refused in background turns`);
  }
  if (action.restrictions.includes('self_audience_only') && scope.audience.kind !== 'self') {
    return denied('requires_self_audience', `${tool}.${actionName} runs only in companion-internal turns`);
  }
  if (scope.caller.kind === 'worker') {
    if (action.workers === 'denied') return denied('worker_not_permitted', `workers may not call ${tool}.${actionName}`);
    const granted = scope.caller.grant.actions.some((g) => g.tool === tool && g.action === actionName);
    if (!granted) return denied('worker_not_permitted', `${tool}.${actionName} is outside this worker's grant`);
  }
  return ok(undefined);
}
