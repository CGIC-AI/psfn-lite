import type { FleetAuthAction } from '../../system/config/fleet-auth-vocabulary.js';
// Lite seam S8: request-capability.ts and request-capability-target.ts are cut with
// fleet auth; request-capability-versions.ts holds the one type copy the kept union
// names, and the resource scope/area come from garden-route-types.ts, the union the
// donor's CompiledGardenRequestTarget resource used.
import type { RequestCapabilityAuthorityVersions } from './request-capability-versions.js';
import type {
  GardenResourceArea,
  GardenWorkspaceScope,
} from '../../boundary/fleet-auth/garden-route-types.js';
import type {
  GardenRouteAuthorization,
  GardenSubjectRelation,
} from '../../boundary/fleet-auth/garden-route-authorization.js';
import type { ContactMutationAuditMetadata } from '../../core/contacts/types.js';

export interface GardenRequestResourceContext {
  readonly routeId: string;
  readonly scope: GardenWorkspaceScope;
  readonly area: GardenResourceArea;
  readonly companionId: string | null;
  readonly pathParams: Readonly<Record<string, string>>;
  readonly query: Readonly<Record<string, readonly string[]>>;
}

export interface FleetGardenActorContext {
  readonly kind: 'fleet_principal';
  readonly principalId: string;
  readonly provider: 'discord' | 'admin_token' | 'testing_harness';
  readonly providerSubjectId: string;
  readonly contactId: string;
  readonly contactBindingId: string;
  readonly role: 'owner' | 'admin' | 'member' | 'guest';
  readonly operatorGrantId: string;
  readonly sessionRecordId: string;
  readonly sessionAssurance: 'oauth' | 'escalated' | 'break_glass';
  /**
   * D1 deployment access mode (signed by the gateway from the boot-frozen
   * account roster): `sole_admin` deployments have exactly one rostered human
   * and are never subject-gated; `multi_admin` keeps the subject boundary.
   */
  readonly accessMode: 'sole_admin' | 'multi_admin';
}

export interface StandaloneGardenActorContext {
  readonly kind: 'standalone_operator';
  readonly actorId: 'standalone-token:operator';
}

export interface PublicGardenActorContext {
  readonly kind: 'public';
  readonly actorId: 'public:anonymous';
}

export type GardenActorContext =
  | FleetGardenActorContext
  | StandaloneGardenActorContext
  | PublicGardenActorContext;

interface GardenRequestContextBase {
  readonly actor: GardenActorContext;
  readonly action: FleetAuthAction;
  readonly resource: GardenRequestResourceContext;
  readonly subjectRelation: GardenSubjectRelation;
  readonly authorization: GardenRouteAuthorization;
}

export interface FleetGardenRequestContext extends GardenRequestContextBase {
  readonly kind: 'fleet_principal';
  readonly requestId: string;
  readonly decisionId: string;
  readonly authorizationEventId: string;
  readonly resolvedAt: string;
  readonly versions: RequestCapabilityAuthorityVersions;
  readonly issuedAt: number;
  readonly expiresAt: number;
  readonly actor: FleetGardenActorContext;
}

export interface StandaloneGardenRequestContext extends GardenRequestContextBase {
  readonly kind: 'standalone_token';
  readonly requestId: null;
  readonly decisionId: null;
  readonly versions: null;
  readonly actor: StandaloneGardenActorContext;
}

export interface PublicGardenRequestContext extends GardenRequestContextBase {
  readonly kind: 'public';
  readonly requestId: null;
  readonly decisionId: null;
  readonly versions: null;
  readonly actor: PublicGardenActorContext;
}

export type GardenRequestContext =
  | FleetGardenRequestContext
  | StandaloneGardenRequestContext
  | PublicGardenRequestContext;

export const FLEET_GARDEN_CONTACT_OPERATOR_ACTOR = 'operator:fleet-garden';

export interface FleetGardenContactMutationActor {
  readonly actorId: typeof FLEET_GARDEN_CONTACT_OPERATOR_ACTOR;
  readonly auditMetadata: ContactMutationAuditMetadata;
}

/**
 * The gateway's audited ADMIN_TOKEN Garden door (actor kind
 * `admin_token_operator`, psfn-framework-jxthv). The gateway signs this exact
 * shape only after a constant-time ADMIN_TOKEN match and a durable door audit
 * row (`assertAdminTokenAuthContext` rejects any other admin_token shape), so
 * it is operator authority equivalent to an SSO owner — never a fallback for a
 * missing or failed SSO session.
 */
export function isAuditedAdminTokenOperator(
  context: GardenRequestContext,
): context is FleetGardenRequestContext {
  return context.kind === 'fleet_principal'
    && context.actor.provider === 'admin_token'
    && context.actor.role === 'owner'
    && context.actor.accessMode === 'sole_admin'
    && context.actor.sessionAssurance === 'break_glass';
}

/**
 * Operator assurance for escalated operator actions: an SSO session that
 * consumed an audited escalation grant for this request, or the audited
 * ADMIN_TOKEN operator door (whose every request is already door-audited).
 */
export function hasEscalatedOperatorAssurance(context: FleetGardenRequestContext): boolean {
  return context.actor.sessionAssurance === 'escalated' || isAuditedAdminTokenOperator(context);
}

/** Provider identity is audit attribution, never an actor or authority selector. */
export function resolveFleetGardenContactMutationActor(
  context: GardenRequestContext,
): FleetGardenContactMutationActor | null {
  if (context.kind !== 'fleet_principal'
    || context.actor.role !== 'owner') return null;
  const provider = context.actor.provider === 'discord'
    ? 'discord' as const
    : isAuditedAdminTokenOperator(context) ? 'admin_token' as const : null;
  if (!provider) return null;
  const required = [context.actor.providerSubjectId, context.actor.principalId,
    context.requestId, context.decisionId, context.authorizationEventId,
    context.actor.operatorGrantId, context.actor.sessionRecordId, context.actor.contactBindingId];
  if (required.some(value => !value.trim())) return null;
  return Object.freeze({
    actorId: FLEET_GARDEN_CONTACT_OPERATOR_ACTOR,
    auditMetadata: Object.freeze({
      source: 'fleet_garden', provider,
      providerSubjectId: context.actor.providerSubjectId,
      principalId: context.actor.principalId, requestId: context.requestId,
      decisionId: context.decisionId, authorizationEventId: context.authorizationEventId,
      operatorGrantId: context.actor.operatorGrantId,
      sessionRecordId: context.actor.sessionRecordId,
      contactBindingId: context.actor.contactBindingId,
    }),
  });
}

export function createStandaloneGardenRequestContext(input: {
  authorization: GardenRouteAuthorization;
  routeId: string;
  companionId?: string;
  pathParams: Readonly<Record<string, string>>;
  query: Readonly<Record<string, readonly string[]>>;
}): StandaloneGardenRequestContext {
  return Object.freeze({
    kind: 'standalone_token',
    requestId: null,
    decisionId: null,
    versions: null,
    action: input.authorization.action,
    resource: Object.freeze({
      routeId: input.routeId,
      scope: input.authorization.resource.scope,
      area: input.authorization.resource.area,
      companionId: input.companionId ?? null,
      pathParams: Object.freeze({ ...input.pathParams }),
      query: Object.freeze(Object.fromEntries(
        Object.entries(input.query).map(([key, values]) => [key, Object.freeze([...values])]),
      )),
    }),
    subjectRelation: input.authorization.subjectRelation,
    authorization: input.authorization,
    actor: Object.freeze({ kind: 'standalone_operator', actorId: 'standalone-token:operator' }),
  });
}

export function requireFleetGardenRequestContext(
  context: GardenRequestContext,
): FleetGardenRequestContext {
  if (context.kind !== 'fleet_principal') {
    throw new Error('This Garden operation requires a trusted fleet principal context');
  }
  return context;
}

/**
 * Require a fleet principal context whose admitted resource is bound to one
 * exact companion target. Fleet control-plane callers use this after
 * admission so a context created for companion A can never be applied to a
 * request routed at companion B — the route selection, the signed capability,
 * and the authenticated context must all name the same companion.
 */
export function requireCompanionBoundFleetGardenContext(
  context: GardenRequestContext,
  companionId: string,
): FleetGardenRequestContext {
  const fleet = requireFleetGardenRequestContext(context);
  if (!companionId || fleet.resource.companionId !== companionId) {
    throw new Error('Fleet Garden request context is bound to a different companion target');
  }
  return fleet;
}

/**
 * Legacy services that still expose unpartitioned session or alternate-memory
 * stores are not safe to call for a fleet principal. They remain fail closed
 * until their own subject selectors are explicit. Session reads and episodic
 * memory pass only through their subject-scoped projections (88u3); route
 * recovery, CogSec remediation, group memory, and shard review stay denied.
 */
/**
 * D1 helper: true when the signed fleet actor is the deployment's sole
 * rostered admin (admin-class role + `sole_admin` access mode). Such an actor
 * is never subject-partitioned from their own deployment's data.
 */
export function soleAdminFleetActor(
  context: Pick<FleetGardenRequestContext, 'actor'>,
): boolean {
  return (context.actor.role === 'owner' || context.actor.role === 'admin')
    && context.actor.accessMode === 'sole_admin';
}

/**
 * True when a fleet request is partitioned to its own subject (contact).
 * Sole-admin actors — including the audited ADMIN_TOKEN operator, whose
 * contact id is synthetic — act for the whole deployment (D1 doctrine).
 */
export function isSubjectBoundFleetRequest(
  context: GardenRequestContext | undefined,
): context is FleetGardenRequestContext {
  return context?.kind === 'fleet_principal' && !soleAdminFleetActor(context);
}
