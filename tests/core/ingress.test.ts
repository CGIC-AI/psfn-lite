import { describe, expect, it } from 'vitest';
import {
  BASELINE_DISCLOSURE_POLICY,
  SENSITIVITIES,
  createTrustedIngress,
  isTrustedTurnScope,
  parseDisclosurePolicy,
} from '../../packages/core/src/index.ts';
import { COMPANION, FRIEND, PI, PRIMARY, directAttestation, id, standardWorld } from './fakes.ts';

describe('trusted ingress', () => {
  it('binds caller, contact and audience from host evidence and contact authority', async () => {
    const { ingress } = standardWorld();
    const result = await ingress.admit('primary-dm');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.caller).toEqual({ kind: 'participant', contactId: PRIMARY, trust: 'primary' });
    expect(result.value.audience).toEqual({ kind: 'direct', channelId: 'dm-primary', contactId: PRIMARY });
    expect(result.value.admitted).toEqual(['public', 'personal', 'intimate', 'confidential']);
    expect(result.value.policyVersion).toBe(BASELINE_DISCLOSURE_POLICY.version);
    expect(isTrustedTurnScope(result.value)).toBe(true);
    expect(Object.isFrozen(result.value)).toBe(true);
  });

  it('narrows the ceiling by room: primary in a large group sees only public', async () => {
    const { ingress, authenticator } = standardWorld();
    authenticator.tokens.set('primary-room', {
      ...directAttestation('primary-handle', 'room-1'),
      room: { kind: 'group', channelId: id('room-1'), room: 'large_group' },
    });
    const result = await ingress.admit('primary-room');
    expect(result.ok && result.value.admitted).toEqual(['public']);
    expect(result.ok && result.value.audience).toEqual({ kind: 'group', channelId: 'room-1', room: 'large_group' });
  });

  it('admits companion-internal turns only as background self-audience turns', async () => {
    const { ingress, authenticator } = standardWorld();
    const self = await ingress.admit('free-time');
    expect(self.ok && self.value.caller).toEqual({ kind: 'companion_internal', purpose: 'free_time' });
    expect(self.ok && self.value.admitted).toEqual(SENSITIVITIES);

    authenticator.tokens.set('internal-in-dm', {
      surface: PI,
      principal: { kind: 'companion_internal', purpose: 'reflection' },
      room: { kind: 'direct', channelId: id('dm-primary') },
      turnKind: 'background',
    });
    const leaked = await ingress.admit('internal-in-dm');
    expect(leaked.ok || leaked.error).toMatchObject({ kind: 'denied', reason: 'requires_self_audience' });
  });

  it.each([
    ['unknown contact', 'chat:stranger', null, 'unknown_authority'],
    ['untracked contact', 'chat:stranger', { kind: 'untracked' }, 'untracked_contact'],
    ['blocked contact', 'chat:stranger', { kind: 'blocked', contactId: FRIEND }, 'blocked_contact'],
    ['malformed trust from storage', 'chat:stranger', { kind: 'known', contactId: FRIEND, trust: 'owner' }, 'unknown_authority'],
  ])('rejects %s', async (_label, key, resolution, reason) => {
    const { ingress, authenticator, contacts } = standardWorld();
    authenticator.tokens.set('stranger', directAttestation('stranger', 'dm-stranger'));
    if (resolution !== null) contacts.byIdentity.set(key, resolution as never);
    const result = await ingress.admit('stranger');
    expect(result.ok || result.error).toMatchObject({ kind: 'denied', reason });
  });

  it('propagates authentication failure instead of falling back to a default caller', async () => {
    const { ingress } = standardWorld();
    const result = await ingress.admit('forged-token');
    expect(result.ok || result.error).toMatchObject({ kind: 'denied', reason: 'unknown_authority' });
  });

  it.each([
    ['no principal', { surface: 'pi', room: { kind: 'self' }, turnKind: 'foreground' }, 'denied'],
    ['unknown principal kind', { surface: 'pi', principal: { kind: 'operator' }, room: { kind: 'self' }, turnKind: 'foreground' }, 'denied'],
    ['unknown room kind', { ...directAttestation('primary-handle', 'x'), room: { kind: 'stage', channelId: 'x' } }, 'denied'],
    ['missing room', { ...directAttestation('primary-handle', 'x'), room: undefined }, 'denied'],
    ['channel account in a self room', { ...directAttestation('primary-handle', 'x'), room: { kind: 'self' } }, 'denied'],
    ['unknown turn kind', { ...directAttestation('primary-handle', 'x'), turnKind: 'whenever' }, 'invalid'],
    ['bad surface id', { ...directAttestation('primary-handle', 'x'), surface: '' }, 'invalid'],
  ])('rejects a malformed host attestation: %s', async (_label, attestation, kind) => {
    const { ingress, authenticator } = standardWorld();
    authenticator.tokens.set('odd', attestation);
    const result = await ingress.admit('odd');
    expect(result.ok || result.error.kind).toBe(kind);
  });

  it('cannot be forged by copying a scope', async () => {
    const { admit } = standardWorld();
    const scope = await admit('friend-dm');
    expect(isTrustedTurnScope({ ...scope })).toBe(false);
    expect(isTrustedTurnScope(JSON.parse(JSON.stringify(scope)))).toBe(false);
  });

  it('refuses to start without a valid, non-widening disclosure policy', () => {
    const { authenticator, contacts } = standardWorld();
    const widened = structuredClone(BASELINE_DISCLOSURE_POLICY) as unknown as { ceilings: { public: { broadcast: string[] } } };
    widened.ceilings.public.broadcast = ['public', 'personal'];
    const created = createTrustedIngress({ companionId: COMPANION, authenticator, contacts, policy: widened });
    expect(created.ok || created.error.kind).toBe('invalid');
    expect(parseDisclosurePolicy({ version: 1, ceilings: {} }).ok).toBe(false);
    expect(parseDisclosurePolicy({ ...BASELINE_DISCLOSURE_POLICY, version: 0 }).ok).toBe(false);
    expect(parseDisclosurePolicy(BASELINE_DISCLOSURE_POLICY).ok).toBe(true);
  });
});
