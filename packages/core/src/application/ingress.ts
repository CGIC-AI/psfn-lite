import type { ContactAuthorityPort } from '../contacts/index.ts';
import {
  SENSITIVITIES,
  TRUST_LEVELS,
  denied,
  invalid,
  isNonEmptyString,
  isOneOf,
  isRecord,
  ok,
  parseDisclosurePolicy,
  parseId,
  type Audience,
  type CompanionId,
  type DisclosurePolicy,
  type Result,
} from '../shared/index.ts';
import type { CallerAuthenticatorPort, HostAttestation } from './host-ports.ts';
import { mintTrustedScope, type InternalPurpose, type TrustedTurnScope } from './trusted-scope.ts';

const INTERNAL_PURPOSES: readonly InternalPurpose[] = ['reflection', 'free_time', 'maintenance', 'scheduled_prompt'];
const GROUP_ROOMS = ['small_group', 'large_group', 'broadcast'] as const;

export interface TrustedIngress {
  /**
   * Turns host transport evidence into a trusted turn scope. Caller, contact
   * and audience come only from that evidence and core's contact authority.
   */
  admit(evidence: unknown): Promise<Result<TrustedTurnScope>>;
}

export function createTrustedIngress(deps: {
  readonly companionId: CompanionId;
  readonly authenticator: CallerAuthenticatorPort;
  readonly contacts: ContactAuthorityPort;
  readonly policy: unknown;
}): Result<TrustedIngress> {
  const policy = parseDisclosurePolicy(deps.policy);
  if (!policy.ok) return policy;
  return ok({ admit: (evidence) => admit(deps, policy.value, evidence) });
}

async function admit(
  deps: { readonly companionId: CompanionId; readonly authenticator: CallerAuthenticatorPort; readonly contacts: ContactAuthorityPort },
  policy: DisclosurePolicy,
  evidence: unknown,
): Promise<Result<TrustedTurnScope>> {
  const authenticated = await deps.authenticator.authenticate(evidence);
  if (!authenticated.ok) return authenticated;
  const attestation = parseAttestation(authenticated.value);
  if (!attestation.ok) return attestation;
  const { surface, principal, room, turnKind } = attestation.value;

  if (principal.kind === 'companion_internal') {
    if (room.kind !== 'self') return denied('requires_self_audience', 'internal turns have no participant audience');
    if (turnKind !== 'background') return invalid('internal turns are background turns');
    return ok(
      mintTrustedScope({
        companionId: deps.companionId,
        surface,
        caller: { kind: 'companion_internal', purpose: principal.purpose },
        audience: { kind: 'self' },
        admitted: SENSITIVITIES,
        turnKind,
        policyVersion: policy.version,
      }),
    );
  }

  if (room.kind === 'self') return denied('unknown_authority', 'a channel account cannot open a self-audience turn');
  const resolution = await deps.contacts.resolve(principal.identity);
  if (!resolution.ok) return resolution;
  const contact = resolution.value;
  switch (contact.kind) {
    case 'unknown':
      return denied('unknown_authority', 'channel identity is not a known contact');
    case 'untracked':
      return denied('untracked_contact', 'contact has not been approved for tracking');
    case 'blocked':
      return denied('blocked_contact', 'contact is blocked');
    case 'known':
      break;
  }
  if (!isOneOf(TRUST_LEVELS, contact.trust)) return denied('unknown_authority', 'contact trust is not a known level');
  const audience: Audience =
    room.kind === 'direct'
      ? { kind: 'direct', channelId: room.channelId, contactId: contact.contactId }
      : { kind: 'group', channelId: room.channelId, room: room.room };
  const roomKind = room.kind === 'direct' ? 'direct' : room.room;
  return ok(
    mintTrustedScope({
      companionId: deps.companionId,
      surface,
      caller: { kind: 'participant', contactId: contact.contactId, trust: contact.trust },
      audience,
      admitted: policy.ceilings[contact.trust][roomKind],
      turnKind,
      policyVersion: policy.version,
    }),
  );
}

/** Host adapters are outside the type system's reach; their output is re-validated. */
function parseAttestation(raw: unknown): Result<HostAttestation> {
  if (!isRecord(raw)) return invalid('attestation must be an object');
  const surface = parseId('surface', raw['surface']);
  if (!surface.ok) return surface;
  const turnKind = raw['turnKind'];
  if (turnKind !== 'foreground' && turnKind !== 'background') return invalid('attestation turnKind is unknown');
  const room = parseRoom(raw['room']);
  if (!room.ok) return room;
  const principal = raw['principal'];
  if (!isRecord(principal)) return denied('unknown_authority', 'attestation has no principal');
  if (principal['kind'] === 'companion_internal') {
    const purpose = principal['purpose'];
    if (!isOneOf(INTERNAL_PURPOSES, purpose)) return denied('unknown_authority', 'internal purpose is unknown');
    return ok({ surface: surface.value, principal: { kind: 'companion_internal', purpose }, room: room.value, turnKind });
  }
  if (principal['kind'] === 'channel_account') {
    const identity = principal['identity'];
    if (!isRecord(identity) || !isNonEmptyString(identity['channelKind']) || !isNonEmptyString(identity['externalId'])) {
      return denied('unknown_authority', 'channel account identity is incomplete');
    }
    return ok({
      surface: surface.value,
      principal: { kind: 'channel_account', identity: { channelKind: identity['channelKind'], externalId: identity['externalId'] } },
      room: room.value,
      turnKind,
    });
  }
  return denied('unknown_authority', 'attestation principal kind is unknown');
}

function parseRoom(raw: unknown): Result<HostAttestation['room']> {
  if (!isRecord(raw)) return denied('audience_not_admitted', 'attestation has no room');
  if (raw['kind'] === 'self') return ok({ kind: 'self' });
  const channel = parseId('channel', raw['channelId']);
  if (!channel.ok) return denied('audience_not_admitted', 'room channel id is invalid');
  const channelId = channel.value;
  if (raw['kind'] === 'direct') return ok({ kind: 'direct', channelId });
  if (raw['kind'] === 'group') {
    const roomKind = raw['room'];
    if (!isOneOf(GROUP_ROOMS, roomKind)) return denied('audience_not_admitted', 'group room kind is unknown');
    return ok({ kind: 'group', channelId, room: roomKind });
  }
  return denied('audience_not_admitted', 'room kind is unknown');
}
