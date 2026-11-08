/**
 * Contract tests of the Postgres stores against a real throwaway pgvector
 * database: compare-and-set, uniqueness and atomicity under real
 * transactions, including concurrent writers.
 */
import pg from 'pg';
import { describe, expect, it } from 'vitest';
import { loadMigrations, migrate } from '../../packages/adapters/src/index.ts';
import type {
  ArchivedEntry,
  Audience,
  ContactRecord,
  IdempotencyKey,
  NorthStarItem,
  SessionId,
  SessionRecord,
  TurnId,
  TurnRecord,
} from '../../packages/core/src/index.ts';
import { dockerTestsOptedOut } from '../support/postgres-harness.ts';
import { PI, id } from '../core/fakes.ts';
import { entry } from './fs-support.ts';
import { usePostgres } from './pg-support.ts';

const errorOf = (result: { ok: boolean; error?: unknown }) => (result.ok ? 'ok' : result.error);
const AT = '2030-01-01T00:00:00.000Z';
const AUDIENCE: Audience = { kind: 'direct', channelId: id('dm-a'), contactId: id('contact-a') };
const COMPANION_AUTHOR = { kind: 'companion' } as const;

function turn(sessionId: string, n: number, baseRevision: number): TurnRecord {
  return {
    turnId: `turn-${String(n)}` as TurnId,
    sessionId: sessionId as SessionId,
    owner: { surface: PI, instance: 'pi-1' },
    idempotencyKey: `key-${String(n)}` as IdempotencyKey,
    requestFingerprint: 'fp',
    baseRevision,
    audience: AUDIENCE,
    trigger: { kind: 'participant_message', speaker: id('contact-a'), text: 'hello' },
    openedAt: AT,
    leaseUntil: AT,
    settlement: null,
  };
}

function session(sessionId: string, lastActivityAt = AT): SessionRecord {
  return { sessionId: sessionId as SessionId, audience: AUDIENCE, createdAt: AT, lastActivityAt, previousSessionId: null, continuesFrom: null };
}

function contact(contactId: string, ...handles: string[]): ContactRecord {
  return {
    contactId: id(contactId),
    displayName: contactId,
    trust: 'regular',
    relationship: 'acquaintance',
    machineIntelligence: null,
    consent: 'granted',
    status: { kind: 'active' },
    sensitivity: 'personal',
    identities: handles.map((externalId) => ({ channelKind: 'chat', externalId, privacy: null, linkedAt: AT, linkedBy: COMPANION_AUTHOR })),
    createdAt: AT,
    updatedAt: AT,
    revision: 1,
  };
}

const change = { action: 'test', author: COMPANION_AUTHOR, at: AT, detail: {} };

describe.skipIf(dockerTestsOptedOut('postgres stores'))('postgres stores', () => {
  const pgdb = usePostgres();

  it('migrates idempotently with pgvector and refuses drifted or unknown migrations', async () => {
    const url = await pgdb.database();
    const state = await pgdb.open(url);
    expect(state.schemaVersion).toBe(loadMigrations().length);
    const pool = new pg.Pool({ connectionString: url });
    try {
      const again = await migrate(pool);
      expect(again.ok && again.value.map((m) => m.version)).toEqual(loadMigrations().map((m) => m.version));
      const vector = await pool.query("SELECT extversion FROM pg_extension WHERE extname = 'vector'");
      expect(vector.rows[0]).toEqual({ extversion: '0.8.2' });

      await pool.query("UPDATE schema_migrations SET checksum = 'edited' WHERE version = 1");
      expect(errorOf(await migrate(pool))).toMatchObject({ kind: 'unavailable', detail: expect.stringContaining('modified after it ran') as unknown });
      await pool.query('UPDATE schema_migrations SET checksum = $1 WHERE version = 1', [loadMigrations()[0]?.checksum]);
      await pool.query("INSERT INTO schema_migrations (version, name, checksum) VALUES (999, 'future', 'x')");
      expect(errorOf(await migrate(pool))).toMatchObject({ kind: 'unavailable', detail: expect.stringContaining('does not know') as unknown });
    } finally {
      await pool.end();
    }
  });

  it('opens and settles turns compare-and-set, with exactly one winner among racing opens', async () => {
    const { ledger } = await pgdb.fresh();
    const opened = await Promise.all([ledger.open(turn('s-1', 1, 0)), ledger.open({ ...turn('s-1', 2, 0) })]);
    expect(opened.filter((r) => r.ok)).toHaveLength(1);
    const winner = opened.find((r) => r.ok);
    const winnerId = winner?.ok === true ? winner.value.turnId : ('none' as TurnId);
    expect(errorOf(await ledger.open(turn('s-1', 3, 0)))).toMatchObject({ kind: 'conflict', reason: 'turn_already_open' });

    expect(await ledger.lastSettled(id('s-1'))).toEqual({ ok: true, value: null });
    const settle = { turnId: winnerId, settledBy: { surface: PI, instance: 'pi-1' }, settledAt: AT };
    const outcome = { kind: 'completed', reply: 'hi', delivery: 'delivered' } as const;
    expect(errorOf(await ledger.settle({ ...settle, outcome, expectedRevision: 5 }))).toMatchObject({ kind: 'conflict', reason: 'stale_revision' });
    const settled = await ledger.settle({ ...settle, outcome, expectedRevision: 0 });
    expect(settled.ok && settled.value.settlement?.revision).toBe(1);
    expect(errorOf(await ledger.settle({ ...settle, outcome, expectedRevision: 1 }))).toMatchObject({ reason: 'stale_revision' });
    expect(await ledger.head(id('s-1'))).toEqual({ ok: true, value: { sessionId: 's-1', revision: 1, openTurnId: null } });
    const byKey = await ledger.findByIdempotencyKey(id('s-1'), winner?.ok === true ? winner.value.idempotencyKey : id('none'));
    expect(byKey.ok && byKey.value?.settlement?.outcome).toEqual(outcome);
    expect(errorOf(await ledger.open(turn('s-1', 1, 1)))).toMatchObject({ kind: 'conflict' });
    expect(errorOf(await ledger.get(id('turn-404')))).toMatchObject({ kind: 'not_found' });

    // lastSettled names the turn whose settlement produced the current revision, ignoring open turns.
    const lastOf = async () => {
      const last = await ledger.lastSettled(id('s-1'));
      return last.ok ? last.value?.turnId : last.error;
    };
    expect(await lastOf()).toBe(winnerId);
    expect((await ledger.open(turn('s-1', 4, 1))).ok).toBe(true);
    expect(await lastOf()).toBe(winnerId);
    expect((await ledger.settle({ ...settle, turnId: id('turn-4'), outcome, expectedRevision: 1 })).ok).toBe(true);
    expect(await lastOf()).toBe('turn-4');
    expect(await ledger.lastSettled(id('s-404'))).toEqual({ ok: true, value: null });
  });

  it('keeps the session catalog ordered, never lowers activity and moves conversation heads by CAS', async () => {
    const { sessions } = await pgdb.fresh();
    await sessions.create(session('s-a', '2030-01-01T00:00:01.000Z'));
    await sessions.create(session('s-b', '2030-01-01T00:00:02.000Z'));
    await sessions.create(session('s-c', '2030-01-01T00:00:02.000Z'));
    expect(errorOf(await sessions.create(session('s-a')))).toMatchObject({ kind: 'conflict', reason: 'already_exists' });
    await sessions.touch(id('s-a'), '2030-01-01T00:00:09.000Z');
    await sessions.touch(id('s-a'), '2030-01-01T00:00:05.000Z');
    const a = await sessions.get(id('s-a'));
    expect(a.ok && a.value.lastActivityAt).toBe('2030-01-01T00:00:09.000Z');
    expect(errorOf(await sessions.touch(id('s-x'), AT))).toMatchObject({ kind: 'not_found' });

    const page1 = await sessions.list(2, null);
    const ids1 = page1.ok ? page1.value.map((s) => s.sessionId) : [];
    expect(ids1).toEqual(['s-a', 's-c']);
    const last = page1.ok ? page1.value.at(-1) : undefined;
    const page2 = await sessions.list(2, last === undefined ? null : { lastActivityAt: last.lastActivityAt, sessionId: last.sessionId });
    expect(page2.ok && page2.value.map((s) => s.sessionId)).toEqual(['s-b']);

    const racing = await Promise.all([sessions.setActive('conv', id('s-a'), 0), sessions.setActive('conv', id('s-b'), 0)]);
    expect(racing.filter((r) => r.ok)).toHaveLength(1);
    expect(errorOf(await sessions.setActive('conv', id('s-c'), 0))).toMatchObject({ reason: 'stale_revision' });
    expect((await sessions.setActive('conv', id('s-c'), 1)).ok).toBe(true);
    expect(await sessions.active('conv')).toEqual({ ok: true, value: { conversation: 'conv', sessionId: 's-c', revision: 2 } });
    expect(await sessions.active('none')).toEqual({ ok: true, value: null });
  });

  it('allows one open focus per session and completes it once', async () => {
    const { focus, continuity } = await pgdb.fresh();
    const record = { focusId: 'f-1', sessionId: id<'session'>('s-1'), scope: 'move', startedAt: AT, startSeq: 2, completion: null };
    expect((await focus.open(record)).ok).toBe(true);
    expect(errorOf(await focus.open({ ...record, focusId: 'f-2' }))).toMatchObject({ kind: 'conflict', reason: 'already_exists' });
    const completion = { completedAt: AT, endSeq: 4, knowledge: 'boxes friday', author: COMPANION_AUTHOR };
    const done = await focus.complete('f-1', completion);
    expect(done.ok && done.value.completion).toEqual(completion);
    expect(errorOf(await focus.complete('f-1', completion))).toMatchObject({ kind: 'conflict' });
    expect(errorOf(await focus.complete('f-404', completion))).toMatchObject({ kind: 'not_found' });
    expect(await focus.openFor(id('s-1'))).toEqual({ ok: true, value: null });

    const note = { id: 'c-1', sessionId: id<'session'>('s-1'), kind: 'checkpoint' as const, occasion: null, summary: 'a', nextAnchor: null, author: COMPANION_AUTHOR, createdAt: AT };
    await continuity.append(note);
    await continuity.append({ ...note, id: 'c-2', summary: 'b' });
    expect(errorOf(await continuity.append(note))).toMatchObject({ reason: 'already_exists' });
    const listed = await continuity.list([id('s-1')], 5);
    expect(listed.ok && listed.value.map((n) => n.summary)).toEqual(['b', 'a']);
  });

  it('projects canon entries only at the watermark and searches with simple tokens', async () => {
    const { projection } = await pgdb.fresh();
    const archived: ArchivedEntry[] = [entry('s-1', 1, 'The lighthouse trip'), entry('s-1', 2, 'fog everywhere')].map((e, i) => ({
      seq: i + 1,
      hash: `h${String(i + 1)}`,
      entry: e,
    }));
    const empty = { sessionId: id<'session'>('s-1'), count: 0, hash: null };
    expect(await projection.project(id('s-1'), archived, empty)).toEqual({ ok: true, value: { sessionId: 's-1', count: 2, hash: 'h2' } });
    expect(errorOf(await projection.project(id('s-1'), [], empty))).toMatchObject({ kind: 'conflict', reason: 'stale_revision' });
    const gap = { seq: 5, hash: 'h5', entry: entry('s-1', 5) };
    expect(errorOf(await projection.project(id('s-1'), [gap], { sessionId: id('s-1'), count: 2, hash: 'h2' }))).toMatchObject({ kind: 'invalid' });
    const hits = await projection.search('LIGHTHOUSE', [id('s-1')], 10);
    expect(hits.ok && hits.value.map((h) => [h.seq, h.entry.text])).toEqual([[1, 'The lighthouse trip']]);
    expect(await projection.search('lighthouse', [id('s-2')], 10)).toEqual({ ok: true, value: [] });
    await projection.reset(id('s-1'));
    expect(await projection.watermark(id('s-1'))).toEqual({ ok: true, value: empty });
  });

  it('enforces one owner per channel identity and moves identities on merge atomically', async () => {
    const { contacts } = await pgdb.fresh();
    expect((await contacts.create(contact('c-1', 'h-1'), change)).ok).toBe(true);
    expect(errorOf(await contacts.create(contact('c-2', 'h-2', 'h-1'), change))).toMatchObject({ kind: 'conflict', reason: 'identity_conflict' });
    expect(errorOf(await contacts.get(id('c-2')))).toMatchObject({ kind: 'not_found' });
    expect(await contacts.findByIdentity({ channelKind: 'chat', externalId: 'h-2' })).toEqual({ ok: true, value: null });

    await contacts.create(contact('c-2', 'h-2'), change);
    const stale = await contacts.save({ ...contact('c-1', 'h-1'), displayName: 'x', revision: 2 }, 7, change);
    expect(errorOf(stale)).toMatchObject({ kind: 'conflict', reason: 'stale_revision', actualRevision: 1 });
    const grab = await contacts.save({ ...contact('c-1', 'h-1', 'h-2'), revision: 2 }, 1, change);
    expect(errorOf(grab)).toMatchObject({ reason: 'identity_conflict' });
    const unchanged = await contacts.get(id('c-1'));
    expect(unchanged.ok && unchanged.value.revision).toBe(1);

    const source = { ...contact('c-2'), status: { kind: 'merged' as const, into: id<'contact'>('c-1'), at: AT }, revision: 2 };
    const survivor = { ...contact('c-1', 'h-1', 'h-2'), revision: 2 };
    expect((await contacts.merge(source, survivor, { source: 1, survivor: 1 }, change)).ok).toBe(true);
    const found = await contacts.findByIdentity({ channelKind: 'chat', externalId: 'h-2' });
    expect(found.ok && found.value?.contactId).toBe('c-1');
    expect(errorOf(await contacts.merge(source, survivor, { source: 1, survivor: 1 }, change))).toMatchObject({ reason: 'stale_revision' });

    const note = { noteId: 'n-1', contactId: id<'contact'>('c-1'), text: 'likes tea', author: COMPANION_AUTHOR, source: AUDIENCE, at: AT };
    await contacts.appendNote(note);
    await contacts.appendNote({ ...note, noteId: 'n-2', text: 'moved house' });
    const notes = await contacts.notes(id('c-1'), 10);
    expect(notes.ok && notes.value.map((n) => n.text)).toEqual(['moved house', 'likes tea']);
    const listed = await contacts.list(10, id('c-1'));
    expect(listed.ok && listed.value.map((c) => c.contactId)).toEqual(['c-2']);
  });

  it('writes orientation blocks all-or-nothing and versions layers, persona and values', async () => {
    const { blocks, layers, persona, values } = await pgdb.fresh();
    const scope = { kind: 'conversation' as const, channelId: id<'channel'>('dm-a') };
    const write = (changes: { name: 'human' | 'goals'; text: string; expectedRevision: number }[]) =>
      blocks.write({ scope, changes, author: COMPANION_AUTHOR, at: AT });
    expect((await write([{ name: 'human', text: 'Robin', expectedRevision: 0 }])).ok).toBe(true);
    const partial = await write([
      { name: 'goals', text: 'move', expectedRevision: 0 },
      { name: 'human', text: 'stale', expectedRevision: 0 },
    ]);
    expect(errorOf(partial)).toMatchObject({ reason: 'stale_revision' });
    const read = await blocks.read(scope);
    expect(read.ok && read.value.map((b) => [b.name, b.text, b.revision])).toEqual([
      ['persona', '', 0],
      ['human', 'Robin', 1],
      ['goals', '', 0],
    ]);

    const v1 = { layerId: 'base', version: 1, content: 'Be kind.', enabled: true, checksum: 'c1', author: COMPANION_AUTHOR, reason: 'seed', at: AT };
    expect(errorOf(await layers.commit(v1, 0))).toMatchObject({ kind: 'not_found' });
    expect((await layers.commit(v1, 0, { name: 'Base', type: 'base' })).ok).toBe(true);
    const racing = await Promise.all([layers.commit({ ...v1, version: 2, checksum: 'a' }, 1), layers.commit({ ...v1, version: 2, checksum: 'b' }, 1)]);
    expect(racing.filter((r) => r.ok)).toHaveLength(1);
    const history = await layers.history('base', 10);
    expect(history.ok && history.value.map((v) => v.version)).toEqual([2, 1]);
    const listed = await layers.list();
    expect(listed.ok && listed.value.map((l) => [l.id, l.type, l.version])).toEqual([['base', 'base', 2]]);

    const card = { version: 1, card: { name: 'Wren' } as never, checksum: 'p', author: COMPANION_AUTHOR, reason: 'seed', at: AT };
    expect((await persona.commit(card, 0)).ok).toBe(true);
    expect(errorOf(await persona.commit(card, 0))).toMatchObject({ reason: 'stale_revision' });

    const value = { id: 'v-1', version: 1, reflection: 'honesty', context: null, author: COMPANION_AUTHOR, derivedFromVersion: null, createdAt: AT };
    await values.append(value);
    expect(errorOf(await values.append(value))).toMatchObject({ reason: 'already_exists' });
    expect(await values.latestVersion()).toEqual({ ok: true, value: 1 });
  });

  it('saves the North Star by CAS and keeps every item version', async () => {
    const url = await pgdb.database();
    const { northStar } = await pgdb.open(url);
    const item: NorthStarItem = {
      id: 'ns-1',
      title: 'care',
      content: 'care matters',
      priority: 0,
      enabled: true,
      version: 1,
      status: 'active',
      updatedAt: AT,
      updatedBy: COMPANION_AUTHOR,
    };
    expect((await northStar.save([item], 0, 'create')).ok).toBe(true);
    expect(errorOf(await northStar.save([item], 0, 'again'))).toMatchObject({ reason: 'stale_revision' });
    expect(errorOf(await northStar.save([{ ...item, content: 'sneaky' }], 1, 'edit'))).toMatchObject({ reason: 'entry_mismatch' });
    expect((await northStar.save([{ ...item, content: 'care, always', version: 2 }], 1, 'revise')).ok).toBe(true);
    expect(await northStar.read()).toMatchObject({ ok: true, value: { revision: 2, items: [{ content: 'care, always' }] } });
    const pool = new pg.Pool({ connectionString: url });
    try {
      const versions = await pool.query('SELECT version, reason FROM north_star_item_versions ORDER BY version');
      expect(versions.rows).toEqual([
        { version: 1, reason: 'create' },
        { version: 2, reason: 'revise' },
      ]);
    } finally {
      await pool.end();
    }
  });
});
