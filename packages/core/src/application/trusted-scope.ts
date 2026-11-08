import {
  SENSITIVITIES,
  capSensitivities,
  denied,
  invalid,
  isOneOf,
  ok,
  type Audience,
  type CompanionId,
  type ContactId,
  type Result,
  type Sensitivity,
  type SurfaceId,
  type Author,
  type TrustLevel,
  type Viewer,
  type WorkerRunId,
} from '../shared/index.ts';
import type { WorkerGrant } from '../automata/index.ts';
import { resolveAction, TOOL_INVENTORY } from './tool-inventory.ts';

export type InternalPurpose = 'reflection' | 'free_time' | 'maintenance' | 'scheduled_prompt';

export type PrincipalCaller =
  | { readonly kind: 'participant'; readonly contactId: ContactId; readonly trust: TrustLevel }
  | { readonly kind: 'companion_internal'; readonly purpose: InternalPurpose };

export type Caller =
  | PrincipalCaller
  | {
      readonly kind: 'worker';
      readonly runId: WorkerRunId;
      readonly grant: WorkerGrant;
      readonly parent: PrincipalCaller;
    };

/**
 * Authority for one turn, bound at ingress from host-verified evidence.
 * Model arguments never contribute to it. Only scopes minted by ingress (or
 * narrowed from one) pass `isTrustedTurnScope`; a structural copy does not.
 */
export interface TrustedTurnScope {
  readonly companionId: CompanionId;
  readonly surface: SurfaceId;
  readonly caller: Caller;
  readonly audience: Audience;
  readonly admitted: readonly Sensitivity[];
  readonly turnKind: 'foreground' | 'background';
  readonly policyVersion: number;
}

const minted = new WeakSet<TrustedTurnScope>();

/** Internal to the application layer; not part of the public entry. */
export function mintTrustedScope(fields: TrustedTurnScope): TrustedTurnScope {
  const scope = Object.freeze({ ...fields, admitted: Object.freeze([...fields.admitted]) });
  minted.add(scope);
  return scope;
}

export function isTrustedTurnScope(value: unknown): value is TrustedTurnScope {
  return typeof value === 'object' && value !== null && minted.has(value as TrustedTurnScope);
}

/**
 * Narrows a turn scope for a bounded worker: same audience, a background turn,
 * only the granted actions, and admission capped at the grant's
 * `maxSensitivity`. A grant that names an unknown or worker-closed action, an
 * action above its own ceiling, or a ceiling the parent was not admitted to is
 * refused rather than trimmed. Workers cannot spawn workers.
 */
export function deriveWorkerScope(
  parent: TrustedTurnScope,
  runId: WorkerRunId,
  grant: WorkerGrant,
): Result<TrustedTurnScope> {
  if (!isTrustedTurnScope(parent)) return denied('unknown_authority', 'parent scope was not admitted by ingress');
  if (parent.caller.kind === 'worker') return denied('worker_not_permitted', 'workers cannot spawn workers');
  if (!Number.isInteger(grant.maxTurns) || grant.maxTurns < 1) return invalid('worker maxTurns must be a positive integer');
  if (!isOneOf(SENSITIVITIES, grant.maxSensitivity)) return invalid('worker maxSensitivity must be a known sensitivity');
  if (!parent.admitted.includes(grant.maxSensitivity)) {
    return denied('worker_not_permitted', `worker ceiling ${grant.maxSensitivity} exceeds the parent's admission`);
  }
  const admitted = capSensitivities(parent.admitted, grant.maxSensitivity);
  const issues: string[] = [];
  for (const { tool, action } of grant.actions) {
    const resolved = resolveAction(TOOL_INVENTORY, tool, action);
    if (!resolved.ok) {
      issues.push(`unknown action ${tool}.${action}`);
    } else if (resolved.value.action.workers === 'denied') {
      issues.push(`${tool}.${action} is not open to workers`);
    } else if (!admitted.includes(resolved.value.action.admission)) {
      issues.push(`${tool}.${action} requires ${resolved.value.action.admission} admission, above the worker ceiling`);
    }
  }
  if (issues.length > 0) return denied('worker_not_permitted', issues.join('; '));
  const frozenGrant: WorkerGrant = Object.freeze({
    actions: Object.freeze(grant.actions.map((a) => Object.freeze({ tool: a.tool, action: a.action }))),
    maxTurns: grant.maxTurns,
    maxSensitivity: grant.maxSensitivity,
  });
  return ok(
    mintTrustedScope({
      ...parent,
      caller: { kind: 'worker', runId, grant: frozenGrant, parent: parent.caller },
      admitted,
      turnKind: 'background',
    }),
  );
}

/** The read authority of a scope, in the form domain visibility rules take. */
export function viewerOf(scope: TrustedTurnScope): Viewer {
  return { audience: scope.audience, admitted: scope.admitted, worker: scope.caller.kind === 'worker' };
}

/**
 * Who a write made under this scope is attributed to. The companion acts in
 * its own turns and in participant conversations; a worker's output is
 * machine-produced, never companion-authored.
 */
export function authorOf(scope: TrustedTurnScope): Author {
  return scope.caller.kind === 'worker' ? { kind: 'machine', producer: `worker:${scope.caller.runId}` } : { kind: 'companion' };
}
