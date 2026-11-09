import { describe, expect, it } from 'vitest';
import {
  assertGardenRequestCompanionScope,
  gardenRequestCompanionScopeDenial,
  GardenCompanionScopeError,
} from './garden-companion-scope.js';
import {
  createStandaloneGardenRequestContext,
  type FleetGardenRequestContext,
  type GardenRequestContext,
  type PublicGardenRequestContext,
} from './garden-request-context.js';
import type { GardenRouteAuthorization } from '../../boundary/fleet-auth/garden-route-authorization.js';

const COMPANION_A = '11111111-1111-4111-8111-111111111111';
const COMPANION_B = '22222222-2222-4222-8222-222222222222';

const AUTHORIZATION: GardenRouteAuthorization = Object.freeze({
  action: 'dashboard.read',
  baseRole: 'member',
  resource: Object.freeze({ scope: 'personal_workspace', area: 'dashboard' }),
  subjectRelation: 'operator_scope',
  requirements: Object.freeze({
    assurance: 'oauth',
    confirmation: 'none',
    approvals: Object.freeze([]),
  }),
  publicAccess: 'never',
  recoveryAccess: 'forbidden',
}) as unknown as GardenRouteAuthorization;

function fleetContext(companionId: string | null): FleetGardenRequestContext {
  return Object.freeze({
    kind: 'fleet_principal',
    requestId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    decisionId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    authorizationEventId: 'event-a',
    resolvedAt: '2030-01-01T00:00:00.000Z',
    versions: Object.freeze({
      authorityGeneration: 1,
      globalAuthEpoch: 1,
      sessionAuthnVersion: 1,
      sessionAuthzVersion: 1,
      bindingVersion: 1,
      grantVersion: 1,
      policyVersion: 1,
    }),
    issuedAt: 1,
    expiresAt: 2,
    actor: Object.freeze({
      kind: 'fleet_principal',
      principalId: 'principal-a',
      provider: 'discord',
      providerSubjectId: 'provider-a',
      contactId: 'contact-a',
      contactBindingId: 'binding-a',
      role: 'member',
      operatorGrantId: 'grant-a',
      sessionRecordId: 'session-a',
      sessionAssurance: 'oauth',
    }),
    action: 'dashboard.read',
    resource: Object.freeze({
      routeId: 'GET /api/admin/dashboard',
      scope: 'personal_workspace',
      area: 'dashboard',
      companionId,
      pathParams: Object.freeze({}),
      query: Object.freeze({}),
    }),
    subjectRelation: 'operator_scope',
    authorization: AUTHORIZATION,
  }) as unknown as FleetGardenRequestContext;
}

describe('gardenRequestCompanionScopeDenial (invariant 11)', () => {
  it('allows a fleet request whose companion matches the bound companion', () => {
    expect(gardenRequestCompanionScopeDenial(fleetContext(COMPANION_A), COMPANION_A)).toBeNull();
  });

  it('denies a fleet request for a different companion than the dispatch binding', () => {
    const denial = gardenRequestCompanionScopeDenial(fleetContext(COMPANION_B), COMPANION_A);
    expect(denial).toBe(
      'Fleet Garden request companion does not match the dispatch companion binding',
    );
  });

  it('fails closed when the fleet request carries no companion target', () => {
    expect(gardenRequestCompanionScopeDenial(fleetContext(null), COMPANION_A)).toBe(
      'Fleet Garden request carries no authenticated companion target',
    );
  });

  it('fails closed when the dispatch has no companion binding', () => {
    expect(gardenRequestCompanionScopeDenial(fleetContext(COMPANION_A), undefined)).toBe(
      'Fleet Garden dispatch has no companion binding to scope the request',
    );
    expect(gardenRequestCompanionScopeDenial(fleetContext(COMPANION_A), '')).toBe(
      'Fleet Garden dispatch has no companion binding to scope the request',
    );
  });

  it('exempts a standalone-token context (single-companion Garden behavior unchanged)', () => {
    const standalone: GardenRequestContext = createStandaloneGardenRequestContext({
      authorization: AUTHORIZATION,
      routeId: 'GET /api/admin/dashboard',
      companionId: COMPANION_A,
      pathParams: {},
      query: {},
    });
    // Even a mismatched bound companion is irrelevant for standalone: no fleet target.
    expect(gardenRequestCompanionScopeDenial(standalone, COMPANION_B)).toBeNull();
    expect(gardenRequestCompanionScopeDenial(standalone, undefined)).toBeNull();
  });

  it('exempts a public context', () => {
    const publicContext = Object.freeze({
      kind: 'public',
      requestId: null,
      decisionId: null,
      versions: null,
      action: 'dashboard.read',
      resource: Object.freeze({
        routeId: 'GET /health',
        scope: 'public',
        area: 'public',
        companionId: null,
        pathParams: Object.freeze({}),
        query: Object.freeze({}),
      }),
      subjectRelation: 'operator_scope',
      authorization: AUTHORIZATION,
      actor: Object.freeze({ kind: 'public', actorId: 'public:anonymous' }),
    }) as unknown as PublicGardenRequestContext;
    expect(gardenRequestCompanionScopeDenial(publicContext, COMPANION_A)).toBeNull();
  });
});

describe('assertGardenRequestCompanionScope', () => {
  it('returns without throwing when the request companion is in scope', () => {
    expect(() =>
      assertGardenRequestCompanionScope(fleetContext(COMPANION_A), COMPANION_A),
    ).not.toThrow();
  });

  it('throws GardenCompanionScopeError on a cross-companion request', () => {
    expect(() =>
      assertGardenRequestCompanionScope(fleetContext(COMPANION_B), COMPANION_A),
    ).toThrow(GardenCompanionScopeError);
  });
});
