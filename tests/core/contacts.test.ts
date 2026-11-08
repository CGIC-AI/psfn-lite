import { describe, expect, it } from 'vitest';
import { continuityWorld, OPERATOR } from './continuity-world.ts';

const errorOf = (result: { ok: boolean; error?: unknown }) => (result.ok ? 'ok' : result.error);

describe('contact authority at ingress', () => {
  it('denies unknown, untracked, revoked, blocked and archived callers', async () => {
    const world = await continuityWorld();
    world.authenticator.tokens.set('nobody', { ...(world.authenticator.tokens.get('primary-dm') as object), principal: { kind: 'channel_account', identity: { channelKind: 'chat', externalId: 'nobody' } } });
    expect(errorOf(await world.ingress.admit('nobody'))).toMatchObject({ kind: 'denied', reason: 'unknown_authority' });

    const { friend, acquaintance, stranger } = world.people;
    await world.admin.setConsent(OPERATOR, friend, 'revoked');
    expect(errorOf(await world.ingress.admit('friend-dm'))).toMatchObject({ kind: 'denied', reason: 'untracked_contact' });
    await world.admin.setConsent(OPERATOR, acquaintance, 'pending');
    expect(errorOf(await world.ingress.admit('acq-dm'))).toMatchObject({ kind: 'denied', reason: 'untracked_contact' });
    await world.admin.archive(OPERATOR, stranger);
    expect(errorOf(await world.ingress.admit('stranger-dm'))).toMatchObject({ kind: 'denied', reason: 'unknown_authority' });
  });

  it('resolves a merged identity through the survivor and never widens authority', async () => {
    const world = await continuityWorld();
    const { friend, stranger } = world.people;
    const merged = await world.admin.merge(OPERATOR, stranger, friend);
    expect(merged.ok && merged.value).toMatchObject({ trust: 'public', identities: [{ externalId: 'friend-handle' }, { externalId: 'stranger-handle' }] });
    const viaOldIdentity = await world.admit('stranger-dm');
    expect(viaOldIdentity.caller).toEqual({ kind: 'participant', contactId: friend, trust: 'public' });

    const stale = await world.contacts.lookup(await world.admit('primary-dm'), { contactId: stranger });
    expect(stale.ok && stale.value.contact).toMatchObject({ status: 'merged', mergedInto: friend, identities: [] });
  });

  it('keeps a merged person out when either side was blocked or revoked', async () => {
    const world = await continuityWorld();
    const { friend, acquaintance, stranger } = world.people;
    await world.contacts.block(await world.admit('primary-dm'), { contactId: stranger, reason: 'abusive' });
    expect(errorOf(await world.ingress.admit('stranger-dm'))).toMatchObject({ reason: 'blocked_contact' });
    await world.admin.merge(OPERATOR, stranger, friend);
    expect(errorOf(await world.ingress.admit('friend-dm'))).toMatchObject({ reason: 'blocked_contact' });
    expect(errorOf(await world.ingress.admit('stranger-dm'))).toMatchObject({ reason: 'blocked_contact' });

    await world.admin.setConsent(OPERATOR, acquaintance, 'revoked');
    const survivor = await world.contacts.lookup(await world.admit('primary-dm'), { contactId: friend });
    if (!survivor.ok) throw new Error('lookup');
    await world.admin.merge(OPERATOR, acquaintance, friend);
    await world.contacts.unblock(await world.admit('primary-dm'), { contactId: friend, reason: null });
    expect(errorOf(await world.ingress.admit('acq-dm'))).toMatchObject({ reason: 'untracked_contact' });
    expect(errorOf(await world.ingress.admit('friend-dm'))).toMatchObject({ reason: 'untracked_contact' });
  });

  it('treats a broken merge chain as unknown authority', async () => {
    const world = await continuityWorld();
    const { friend } = world.people;
    const record = world.contactStore.records.get(friend);
    if (record === undefined) throw new Error('friend');
    world.contactStore.records.set(friend, { ...record, status: { kind: 'merged', into: friend, at: record.createdAt } });
    expect(errorOf(await world.ingress.admit('friend-dm'))).toMatchObject({ reason: 'unknown_authority' });
  });
});

describe('contact tool', () => {
  it('withholds personal contacts from callers whose room does not admit them, for reads and writes alike', async () => {
    const world = await continuityWorld();
    const stranger = await world.admit('stranger-dm');
    const listed = await world.call(stranger, 'contact', 'list');
    expect(listed.ok && listed.value.content).toEqual([]);
    const lookup = await world.call(stranger, 'contact', 'lookup', { contactId: world.people.primary });
    expect(errorOf(lookup)).toMatchObject({ kind: 'not_found' });
    const note = await world.call(stranger, 'contact', 'note', { contactId: world.people.primary, text: 'x' });
    expect(errorOf(note)).toMatchObject({ kind: 'not_found' });
    expect(world.contactStore.noteRows).toHaveLength(0);

    const fromFriend = await world.call(await world.admit('friend-dm'), 'contact', 'search', { query: 'robin' });
    expect(fromFriend.ok && fromFriend.value.content).toMatchObject([{ contactId: world.people.primary }]);
  });

  it('never writes high-tier trust: set_trust is low-tier only and propose_trust queues an approval', async () => {
    const world = await continuityWorld();
    const scope = await world.admit('primary-dm');
    const { acquaintance, friend, stranger } = world.people;
    const promote = await world.call(scope, 'contact', 'set_trust', { contactId: acquaintance, trust: 'trusted' });
    expect(errorOf(promote)).toMatchObject({ kind: 'invalid' });
    const demoteHigh = await world.call(scope, 'contact', 'set_trust', { contactId: friend, trust: 'public' });
    expect(errorOf(demoteHigh)).toMatchObject({ kind: 'denied', reason: 'approval_required' });
    const drift = await world.call(scope, 'contact', 'set_trust', { contactId: stranger, trust: 'regular' });
    expect(drift.ok && drift.value.content).toMatchObject({ status: 'applied', contact: { trust: 'regular' } });

    const proposal = await world.call(scope, 'contact', 'propose_trust', { contactId: acquaintance, rationale: 'years of care' });
    expect(proposal.ok && proposal.value.content).toEqual({ status: 'proposed', proposalId: 'proposal-1' });
    expect(world.approvals.submitted[0]).toMatchObject({ kind: 'contact.trust.promote', payload: { from: 'regular', to: 'trusted' }, requestedBy: { kind: 'companion' } });
    expect(world.contactStore.records.get(acquaintance)?.trust).toBe('regular');
  });

  it('walks the relationship ladder one rank at a time and routes family/partner through approval', async () => {
    const world = await continuityWorld();
    const scope = await world.admit('primary-dm');
    const { stranger, friend } = world.people;
    expect(errorOf(await world.call(scope, 'contact', 'set_relationship', { contactId: stranger, relationship: 'friend' }))).toMatchObject({ reason: 'approval_required' });
    const step = await world.call(scope, 'contact', 'set_relationship', { contactId: stranger, relationship: 'acquaintance' });
    expect(step.ok && step.value.content).toMatchObject({ status: 'applied', contact: { relationship: 'acquaintance' } });
    expect(errorOf(await world.call(scope, 'contact', 'set_relationship', { contactId: friend, relationship: 'family' }))).toMatchObject({ reason: 'approval_required' });
    const proposed = await world.call(scope, 'contact', 'propose_relationship', { contactId: friend, relationship: 'family', rationale: 'chosen family' });
    expect(proposed.ok && proposed.value.content).toMatchObject({ status: 'proposed' });
    expect(errorOf(await world.call(scope, 'contact', 'propose_relationship', { contactId: friend, relationship: 'partner', rationale: 'x' }))).toMatchObject({ kind: 'invalid' });
  });

  it('links identities to low-tier contacts directly but proposes links that would confer high-tier authority', async () => {
    const world = await continuityWorld();
    const scope = await world.admit('primary-dm');
    const { primary, acquaintance } = world.people;
    const toPrimary = await world.call(scope, 'contact', 'link_identity', { contactId: primary, channelKind: 'chat', externalId: 'impostor' });
    expect(toPrimary.ok && toPrimary.value.content).toMatchObject({ status: 'proposed' });
    world.authenticator.tokens.set('impostor-dm', { ...(world.authenticator.tokens.get('primary-dm') as object), principal: { kind: 'channel_account', identity: { channelKind: 'chat', externalId: 'impostor' } } });
    expect(errorOf(await world.ingress.admit('impostor-dm'))).toMatchObject({ reason: 'unknown_authority' });

    const linked = await world.call(scope, 'contact', 'link_identity', { contactId: acquaintance, channelKind: 'mail', externalId: 'lee@example.org', privacy: 'private' });
    expect(linked.ok && linked.value.content).toMatchObject({ status: 'applied' });
    const clash = await world.call(scope, 'contact', 'link_identity', { contactId: world.people.stranger, channelKind: 'mail', externalId: 'lee@example.org' });
    expect(errorOf(clash)).toMatchObject({ kind: 'invalid' });
    const privacy = await world.call(scope, 'contact', 'set_channel_privacy', { contactId: acquaintance, channelKind: 'mail', externalId: 'lee@example.org', privacy: 'public' });
    expect(privacy.ok && privacy.value.content).toMatchObject({ contact: { identities: [{}, { privacy: 'public' }] } });
  });

  it('keeps notes attributed and readable only where their source conversation is', async () => {
    const world = await continuityWorld();
    const { acquaintance } = world.people;
    const primary = await world.admit('primary-dm');
    const note = await world.call(primary, 'contact', 'note', { contactId: acquaintance, text: 'mentioned a hard week' });
    expect(note.ok && note.value.content).toMatchObject({ author: { kind: 'companion' }, source: primary.audience });
    const fromPrimary = await world.contacts.lookup(primary, { contactId: acquaintance });
    expect(fromPrimary.ok && fromPrimary.value.notes).toHaveLength(1);
    const fromFriend = await world.contacts.lookup(await world.admit('friend-dm'), { contactId: acquaintance });
    expect(fromFriend.ok && fromFriend.value.notes).toEqual([]);
  });

  it('blocks and unblocks through status, protects the primary, and lets operator classification win', async () => {
    const world = await continuityWorld();
    const scope = await world.admit('primary-dm');
    const { primary, acquaintance } = world.people;
    expect(errorOf(await world.call(scope, 'contact', 'block', { contactId: primary }))).toMatchObject({ reason: 'approval_required' });
    await world.call(scope, 'contact', 'block', { contactId: acquaintance, reason: 'harassment' });
    expect(errorOf(await world.ingress.admit('acq-dm'))).toMatchObject({ reason: 'blocked_contact' });
    await world.call(scope, 'contact', 'unblock', { contactId: acquaintance });
    expect((await world.ingress.admit('acq-dm')).ok).toBe(true);

    const record = world.contactStore.records.get(acquaintance);
    if (record === undefined) throw new Error('acq');
    world.contactStore.records.set(acquaintance, { ...record, machineIntelligence: { value: false, setBy: 'operator' } });
    const flip = await world.call(scope, 'contact', 'set_machine_intelligence', { contactId: acquaintance, isMachineIntelligence: true });
    expect(errorOf(flip)).toMatchObject({ reason: 'approval_required' });
    const background = await world.call(await world.admit('friend-dm-background'), 'contact', 'block', { contactId: acquaintance });
    expect(errorOf(background)).toMatchObject({ reason: 'background_turn' });
    expect(world.contactStore.changes.map((c) => c.action)).toContain('block');
  });
});
