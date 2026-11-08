import {
  denied,
  ok,
  type Audience,
  type CompanionId,
  type ContactId,
  type Result,
  type Sensitivity,
  type SurfaceId,
  type TrustLevel,
  type WorkerRunId,
} from '../shared/index.ts';
import type { WorkerGrant } from '../automata/index.ts';

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
 * Narrows a turn scope for a bounded worker: same audience and ceiling, a
 * background turn, and only the granted actions. Workers cannot spawn workers.
 */
export function deriveWorkerScope(
  parent: TrustedTurnScope,
  runId: WorkerRunId,
  grant: WorkerGrant,
): Result<TrustedTurnScope> {
  if (!isTrustedTurnScope(parent)) return denied('unknown_authority', 'parent scope was not admitted by ingress');
  if (parent.caller.kind === 'worker') return denied('worker_not_permitted', 'workers cannot spawn workers');
  return ok(
    mintTrustedScope({
      ...parent,
      caller: { kind: 'worker', runId, grant, parent: parent.caller },
      turnKind: 'background',
    }),
  );
}
