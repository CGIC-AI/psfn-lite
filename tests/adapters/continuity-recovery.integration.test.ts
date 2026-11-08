/**
 * End-to-end continuity over the real adapters: JSONL canonical history plus
 * Postgres structured state, driven through the real core services. Covers
 * crash recovery of an interrupted turn, a harness reset, contact authority
 * on the real store, and a full backup restored into a fresh history root and
 * a fresh database.
 */
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  createHistoryBackupComponent,
  openFileBackupStore,
  type FileSessionArchive,
  type PostgresState,
} from '../../packages/adapters/src/index.ts';
import { createContinuityBackup, type BackupStorePort, type RenderedEntry, type SessionId } from '../../packages/core/src/index.ts';
import { FakeApprovals, FakeModel } from '../core/continuity-fakes.ts';
import { registerPeople, standardTokens, wireWorld, OPERATOR, type WorldPorts } from '../core/continuity-world.ts';
import { FakeAuthenticator, FixedClock, PI, SequentialIds, TOOL_TRANSPORT } from '../core/fakes.ts';
import { dockerTestsOptedOut } from '../support/postgres-harness.ts';
import { layoutFor, openArchive, tempRoots } from './fs-support.ts';
import { usePostgres } from './pg-support.ts';

const errorOf = (result: { ok: boolean; error?: unknown }) => (result.ok ? 'ok' : result.error);
const textsOf = (content: unknown) => (content as RenderedEntry[]).map((e) => e.text);

interface Host {
  readonly clock: FixedClock;
  readonly ids: SequentialIds;
  readonly authenticator: FakeAuthenticator;
}

function host(): Host {
  const authenticator = new FakeAuthenticator();
  standardTokens(authenticator);
  authenticator.tokens.set('primary-dm-mcp', { ...(authenticator.tokens.get('primary-dm') as object), surface: TOOL_TRANSPORT });
  authenticator.tokens.set('nobody-dm', { ...(authenticator.tokens.get('primary-dm') as object), principal: { kind: 'channel_account', identity: { channelKind: 'chat', externalId: 'nobody-handle' } } });
  return { clock: new FixedClock(), ids: new SequentialIds(), authenticator };
}

function realPorts(h: Host, archive: FileSessionArchive, state: PostgresState): WorldPorts {
  return {
    ...h,
    contactStore: state.contacts,
    approvals: new FakeApprovals(),
    model: new FakeModel(),
    catalog: state.sessions,
    archive,
    ledger: state.ledger,
    projection: state.projection,
    continuity: state.continuity,
    focus: state.focus,
    layers: state.layers,
    persona: state.persona,
    blocks: state.blocks,
    valuesJournal: state.values,
    northStar: state.northStar,
  };
}

async function backupStore(dir: string): Promise<BackupStorePort> {
  const opened = await openFileBackupStore(dir);
  if (!opened.ok) throw new Error(JSON.stringify(opened.error));
  return opened.value;
}

function continuityBackup(archive: FileSessionArchive, state: PostgresState) {
  const created = createContinuityBackup({ components: [createHistoryBackupComponent(archive), state.backup], clock: new FixedClock() });
  if (!created.ok) throw new Error(JSON.stringify(created.error));
  return created.value;
}

describe.skipIf(dockerTestsOptedOut('continuity recovery'))('continuity over the real adapters', () => {
  const pgdb = usePostgres();

  it('recovers a turn interrupted by a crash and keeps every entry across a harness reset', async () => {
    const roots = await tempRoots();
    const layout = await layoutFor(roots);
    const url = await pgdb.database();
    const h = host();

    const firstArchive = await openArchive(layout);
    const firstState = await pgdb.open(url);
    const first = wireWorld(realPorts(h, firstArchive, firstState));
    await registerPeople(first.admin);
    const primary = await first.admit('primary-dm');
    const sessionId = await first.converse(primary, 'remember the blue door', 'always', 'k1');
    const prepared = await first.lifecycle().prepareTurn(primary, {
      sessionId,
      owner: { surface: PI, instance: 'pi-1' },
      idempotencyKey: 'k2' as never,
      expectedRevision: 1,
      trigger: { kind: 'participant_message', text: 'are you still there?' },
    });
    expect(prepared.ok && prepared.value.kind).toBe('prepared');

    // The harness process dies mid-turn: nothing settles, both stores go away.
    await firstArchive.close();
    await pgdb.close(firstState);

    const archive = await openArchive(layout);
    const state = await pgdb.open(url);
    const successor = wireWorld(realPorts(h, archive, state));
    const replacement = await successor.admit('primary-dm-mcp');
    const blocked = await successor.lifecycle().recoverTurn(replacement, { sessionId, owner: { surface: TOOL_TRANSPORT, instance: 'hermes-1' } });
    expect(errorOf(blocked)).toMatchObject({ kind: 'conflict', reason: 'turn_lease_active' });
    h.clock.advance(60_000);
    const recovered = await successor.lifecycle().recoverTurn(replacement, { sessionId, owner: { surface: TOOL_TRANSPORT, instance: 'hermes-1' } });
    expect(recovered.ok && recovered.value.settlement).toMatchObject({ outcome: { kind: 'interrupted', by: 'host' }, revision: 2 });

    const chain = archive.chain(sessionId);
    expect(chain.ok && chain.value.map((a) => [a.entry.origin.kind, a.entry.text])).toEqual([
      ['participant_speech', 'remember the blue door'],
      ['companion_speech', 'always'],
      ['participant_speech', 'are you still there?'],
      ['system_note', 'turn interrupted by host; recovered by mcp'],
    ]);
    await successor.converse(replacement, 'yes, back now', 'welcome back', 'k3');

    // A harness reset: a fresh wiring over the same durable state sees everything.
    const reset = wireWorld(realPorts(h, archive, state));
    const scope = await reset.admit('primary-dm');
    const history = await reset.call(scope, 'session', 'messages', { sessionId, limit: 50 });
    expect(history.ok && textsOf(history.value.content)).toEqual(expect.arrayContaining(['remember the blue door', 'are you still there?', 'yes, back now']));
    const search = await reset.call(scope, 'session', 'search', { query: 'blue door' });
    expect(search.ok && textsOf((search.value.content as { hits: unknown }).hits)).toEqual(['remember the blue door']);
    const watermark = await state.projection.watermark(sessionId);
    expect(watermark).toEqual(await archive.head(sessionId));
  });

  it('denies unknown, revoked and merged-away authority on the real contact store', async () => {
    const roots = await tempRoots();
    const h = host();
    const state = await pgdb.fresh();
    const world = wireWorld(realPorts(h, await openArchive(await layoutFor(roots)), state));
    const people = await registerPeople(world.admin);

    expect(errorOf(await world.ingress.admit('nobody-dm'))).toMatchObject({ kind: 'denied', reason: 'unknown_authority' });
    await world.admin.setConsent(OPERATOR, people.acquaintance, 'revoked');
    expect(errorOf(await world.ingress.admit('acq-dm'))).toMatchObject({ kind: 'denied', reason: 'untracked_contact' });

    // Merging the revoked contact into a trusted one must not resurrect it, and drags the survivor down.
    expect((await world.admin.merge(OPERATOR, people.acquaintance, people.friend)).ok).toBe(true);
    expect(errorOf(await world.ingress.admit('acq-dm'))).toMatchObject({ reason: 'untracked_contact' });
    expect(errorOf(await world.ingress.admit('friend-dm'))).toMatchObject({ reason: 'untracked_contact' });

    // Merging a public stranger into the primary never widens the stranger's handle to primary trust.
    expect((await world.admin.merge(OPERATOR, people.stranger, people.primary)).ok).toBe(true);
    const viaStranger = await world.admit('stranger-dm');
    expect(viaStranger.audience).toMatchObject({ contactId: people.primary });
    const survivor = await state.contacts.get(people.primary);
    expect(survivor.ok && survivor.value.trust).toBe('public');
    const source = await state.contacts.get(people.stranger);
    expect(source.ok && [source.value.status.kind, source.value.identities]).toEqual(['merged', []]);
  });

  it('restores a full backup into a fresh history root and database with identity and lineage intact', async () => {
    const sourceRoots = await tempRoots();
    const h = host();
    const archive = await openArchive(await layoutFor(sourceRoots));
    const state = await pgdb.fresh();
    const world = wireWorld(realPorts(h, archive, state));
    const people = await registerPeople(world.admin);

    const primary = await world.admit('primary-dm');
    const friend = await world.admit('friend-dm');
    const firstSession = await world.converse(primary, 'we planted tomatoes', 'they will love the sun', 'k1');
    await world.call(primary, 'session', 'new');
    await world.converse(primary, 'the move is on friday', 'I will help you plan', 'k2');
    const friendSession = await world.converse(friend, 'hike on saturday?', 'gladly', 'k3');
    expect((await world.call(primary, 'session', 'resume', { sessionId: friendSession })).ok).toBe(true);
    await world.call(primary, 'session', 'wake_return', { summary: 'we left off planning the move', occasion: 'return' });
    await world.call(primary, 'contact', 'note', { contactId: people.friend, text: 'loves long hikes' });
    await world.call(primary, 'orient', 'append', { block: 'human', text: 'Robin is moving house' });
    await world.call(primary, 'values', 'add_value', { value: 'honesty with care' });
    await world.call(primary, 'values', 'north_star_create', { title: 'care', content: 'care matters' });
    await world.identityAdmin.defineLayer(OPERATOR, { id: 'base', name: 'Base', type: 'base', content: 'Be kind.' });

    const setDir = join(sourceRoots.backups, 'set-1');
    const made = await continuityBackup(archive, state).backup(await backupStore(setDir));
    expect(made.ok && made.value.components.map((c) => c.name)).toEqual(['history', 'state']);

    const targetRoots = await tempRoots();
    const restoredArchive = await openArchive(await layoutFor(targetRoots));
    const restoredState = await pgdb.fresh();
    const restore = await continuityBackup(restoredArchive, restoredState).restore(await backupStore(setDir));
    expect(errorOf(restore)).toBe('ok');
    expect(errorOf(await continuityBackup(restoredArchive, restoredState).restore(await backupStore(setDir)))).toMatchObject({
      kind: 'conflict',
      reason: 'already_exists',
    });

    // Canonical history: same sessions, same entries, same chain hashes.
    expect(restoredArchive.sessionIds()).toEqual(archive.sessionIds());
    for (const sessionId of archive.sessionIds()) expect(restoredArchive.chain(sessionId)).toEqual(archive.chain(sessionId));
    // Structured state: same session lineage, contacts and continuity notes.
    expect(await restoredState.sessions.list(50, null)).toEqual(await state.sessions.list(50, null));
    const lineage = await restoredState.sessions.list(50, null);
    const records = lineage.ok ? lineage.value : [];
    expect(records.find((s) => s.continuesFrom === friendSession)?.audience).toEqual(primary.audience);
    expect(records.some((s) => s.previousSessionId === firstSession)).toBe(true);
    expect(await restoredState.contacts.list(50, null)).toEqual(await state.contacts.list(50, null));
    expect(await restoredState.contacts.notes(people.friend, 10)).toEqual(await state.contacts.notes(people.friend, 10));

    // The restored companion carries on: same people, same orientation, attributed history, rebuilt search.
    const restored = wireWorld(realPorts(h, restoredArchive, restoredState));
    const again = await restored.admit('primary-dm');
    const view = await restored.call(again, 'orient', 'view');
    expect(view.ok && JSON.stringify(view.value.content)).toContain('Robin is moving house');
    const messages = await restored.call(again, 'session', 'messages', { sessionId: firstSession });
    const original = await world.call(primary, 'session', 'messages', { sessionId: firstSession });
    expect(messages.ok && messages.value.content).toEqual(original.ok && original.value.content);
    expect(await restoredState.projection.watermark(firstSession as SessionId)).toEqual({ ok: true, value: { sessionId: firstSession, count: 0, hash: null } });
    const search = await restored.call(again, 'session', 'search', { query: 'tomatoes' });
    expect(search.ok && textsOf((search.value.content as { hits: unknown }).hits)).toEqual(['we planted tomatoes']);
    const valuesList = await restored.call(again, 'values', 'list_values');
    const originalValues = await world.call(primary, 'values', 'list_values');
    expect(valuesList.ok && valuesList.value.content).toEqual(originalValues.ok && originalValues.value.content);
    const northStar = await restored.call(again, 'values', 'north_star_list');
    expect(northStar.ok && JSON.stringify(northStar.value.content)).toContain('care matters');
  });
});
