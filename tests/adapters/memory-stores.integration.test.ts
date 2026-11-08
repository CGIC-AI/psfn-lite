/**
 * The memory, episode and journal stack over the real Postgres stores:
 * access filters applied in SQL before ranking (proved equal to the core
 * predicates), pgvector search through the per-space HNSW index,
 * idempotency and compare-and-set under real transactions, and a backup of
 * the new state restored into a fresh database.
 */
import pg from 'pg';
import { afterEach, describe, expect, it } from 'vitest';
import { openFileBackupStore, openPostgresMemoryState, type PostgresMemoryState } from '../../packages/adapters/src/index.ts';
import { embeddingIndexName } from '../../packages/adapters/src/postgres/memory-sql.ts';
import { memorySemanticQuery } from '../../packages/adapters/src/postgres/memory-stores.ts';
import {
  SENSITIVITIES,
  createContinuityBackup,
  episodeReadable,
  journalReadable,
  memoryReadable,
  sourceAccessFor,
  type Audience,
  type ContactId,
  type Episode,
  type IdempotencyKey,
  type JournalNote,
  type MemoryRecord,
  type MemorySubject,
  type Sensitivity,
  type SourceAccess,
} from '../../packages/core/src/index.ts';
import { FixedClock, id } from '../core/fakes.ts';
import { SPACE, hashEmbedding } from '../core/memory-fakes.ts';
import { ENDED_AFTER_MS, kindOf, memoryWorld } from '../core/memory-world.ts';
import { dockerTestsOptedOut } from '../support/postgres-harness.ts';
import { layoutFor, tempRoots } from './fs-support.ts';
import { usePostgres } from './pg-support.ts';

const AT = '2030-01-01T00:00:00.000Z';
const PRIMARY = id<'contact'>('contact-1');
const FRIEND = id<'contact'>('contact-2');
const AUDIENCES: Audience[] = [
  { kind: 'self' },
  { kind: 'direct', channelId: id('dm-primary'), contactId: PRIMARY },
  { kind: 'direct', channelId: id('dm-friend'), contactId: FRIEND },
  { kind: 'group', channelId: id('room-a'), room: 'small_group' },
  { kind: 'group', channelId: id('room-b'), room: 'large_group' },
];
const SUBJECTS: MemorySubject[] = [
  { kind: 'contacts', contactIds: [PRIMARY] },
  { kind: 'contacts', contactIds: [FRIEND] },
  { kind: 'contacts', contactIds: [FRIEND, PRIMARY] },
  { kind: 'room', channelId: id('room-a') },
  { kind: 'companion_internal' },
];

/** A spread of viewers: companion, a bounded worker, each direct conversation and a room. */
function accesses(): { name: string; access: SourceAccess }[] {
  const all = [...SENSITIVITIES];
  const personal: Sensitivity[] = ['public', 'personal'];
  return [
    { name: 'self', access: sourceAccessFor({ audience: AUDIENCES[0] as Audience, admitted: all, worker: false }, null) },
    { name: 'self worker', access: sourceAccessFor({ audience: AUDIENCES[0] as Audience, admitted: personal, worker: true }, null) },
    { name: 'primary dm', access: sourceAccessFor({ audience: AUDIENCES[1] as Audience, admitted: all, worker: false }, PRIMARY) },
    { name: 'friend dm', access: sourceAccessFor({ audience: AUDIENCES[2] as Audience, admitted: personal, worker: false }, FRIEND) },
    { name: 'room a', access: sourceAccessFor({ audience: AUDIENCES[3] as Audience, admitted: personal, worker: false }, FRIEND) },
    { name: 'primary worker', access: sourceAccessFor({ audience: AUDIENCES[1] as Audience, admitted: personal, worker: true }, PRIMARY) },
  ];
}

function memoryRecord(n: number, source: Audience, subject: MemorySubject, sensitivity: Sensitivity, state: MemoryRecord['state'] = 'current'): MemoryRecord {
  return {
    id: `memory-${String(n)}`,
    kind: 'fact',
    content: `shared lantern note ${String(n)}`,
    sensitivity,
    subject,
    confidence: 0.9,
    occurredAt: null,
    provenance: {
      author: { kind: 'companion' },
      attribution: { kind: 'companion_authored' },
      source,
      sourceSessionId: null,
      sourceTurnIds: [],
      sourceConversationAt: AT,
      via: 'tool_write',
      idempotencyKey: `key-${String(n)}` as IdempotencyKey,
      recordedAt: AT,
    },
    state,
    supersededBy: null,
    revision: 1,
    createdAt: AT,
    updatedAt: AT,
  };
}

function episodeRecord(n: number, source: Audience, participants: readonly ContactId[]): Episode {
  const from = new Date(Date.parse('2029-12-20T00:00:00.000Z') + n * 3_600_000).toISOString();
  return {
    id: `episode-${String(n)}`,
    lifecycle: n % 7 === 0 ? 'merged' : 'canonical',
    form: 'conversation',
    source,
    segments: [{ sessionId: id('session-x'), fromSeq: n, toSeq: n }],
    participantContactIds: participants,
    sourceTurnIds: [],
    occurredFrom: from,
    occurredTo: from,
    machineSignals: { authoredBy: 'runtime', producer: 'episode_synthesis', summary: `lantern walk ${String(n)}`, salience: 0.5, themes: ['lantern'] },
    meaning: null,
    mergedInto: null,
    revision: 1,
    createdAt: from,
    updatedAt: from,
  };
}

describe.skipIf(dockerTestsOptedOut('postgres memory stores'))('postgres memory stores', () => {
  const pgdb = usePostgres();
  const openedMemory: PostgresMemoryState[] = [];
  const idleErrors: Error[] = [];

  afterEach(async () => {
    for (const state of openedMemory.splice(0)) await state.close();
    if (idleErrors.length > 0) throw new Error(`idle pool errors: ${idleErrors.map((e) => e.message).join('; ')}`);
  });

  const openMemory = async (url: string, space = SPACE): Promise<PostgresMemoryState> => {
    const opened = await openPostgresMemoryState({ connectionString: url, onIdleError: (error) => idleErrors.push(error), space });
    if (!opened.ok) throw new Error(JSON.stringify(opened.error));
    openedMemory.push(opened.value);
    return opened.value;
  };

  it('applies the core access predicates in SQL for search, census, neighbours, timelines and journals', async () => {
    const stores = await openMemory(await pgdb.database());
    const memories: MemoryRecord[] = [];
    let n = 0;
    for (const source of AUDIENCES) {
      for (const subject of SUBJECTS) {
        for (const sensitivity of SENSITIVITIES) {
          n += 1;
          const record = memoryRecord(n, source, subject, sensitivity, n % 9 === 0 ? 'staged' : 'current');
          memories.push(record);
          const inserted = await stores.memories.insert({
            receipt: { idempotencyKey: record.provenance.idempotencyKey, requestDigest: 'd', memoryId: record.id, outcome: 'created', at: AT },
            record,
            vector: { space: SPACE, values: hashEmbedding(record.content) },
            links: [],
            events: [],
            supersede: [],
          });
          expect(inserted.ok).toBe(true);
        }
      }
    }
    const episodes: Episode[] = [];
    const participants: ContactId[][] = [[PRIMARY], [FRIEND], [FRIEND, PRIMARY], []];
    n = 0;
    for (const source of AUDIENCES) {
      for (const people of participants) {
        n += 1;
        const episode = episodeRecord(n, source, people);
        episodes.push(episode);
        expect((await stores.episodes.createIfAbsent(episode)).ok).toBe(true);
      }
    }
    const notes: JournalNote[] = [...AUDIENCES.map((source, i) => ({ source, i })), { source: null, i: 99 }].map(({ source, i }) => ({
      path: `notes/n${String(i)}.md`,
      provenance: source === null ? { scope: 'restricted' } : { scope: 'conversation', source },
      author: { kind: 'companion' },
      body: `lantern journal ${String(i)}`,
      revision: 1,
      createdAt: AT,
      updatedAt: AT,
    }));
    for (const note of notes) expect((await stores.journal.put(note, null)).ok).toBe(true);

    const ids = (rows: readonly { id: string }[]) => rows.map((r) => r.id).sort();
    for (const { name, access } of accesses()) {
      const visible = memories.filter((r) => memoryReadable(access, r));
      expect(visible.length, name).toBeGreaterThan(0);
      const lexical = await stores.memories.searchLexical(access, 'lantern', 500);
      expect(lexical.ok && ids(lexical.value.map((h) => h.record)), `${name} lexical`).toEqual(ids(visible));
      const semantic = await stores.memories.searchSemantic(access, SPACE, hashEmbedding('shared lantern note'), 500);
      expect(semantic.ok && ids(semantic.value.map((h) => h.record)), `${name} semantic`).toEqual(ids(visible));
      const census = await stores.memories.census(access);
      expect(census.ok && census.value.fact, `${name} census`).toBe(visible.length);
      const about = await stores.memories.aboutContact(access, PRIMARY, 500);
      expect(about.ok && ids(about.value), `${name} about`).toEqual(ids(visible.filter((r) => r.subject.kind === 'contacts' && r.subject.contactIds.includes(PRIMARY))));

      const timeline = await stores.episodes.timeline(access, '2029-01-01T00:00:00.000Z', '2030-12-31T00:00:00.000Z', 500);
      expect(timeline.ok && ids(timeline.value), `${name} timeline`).toEqual(ids(episodes.filter((e) => episodeReadable(access, e))));
      const lexicalEpisodes = await stores.episodes.searchLexical(access, 'lantern walk', 500);
      expect(lexicalEpisodes.ok && ids(lexicalEpisodes.value.map((h) => h.episode)), `${name} episode search`).toEqual(
        ids(episodes.filter((e) => episodeReadable(access, e))),
      );
      const journal = await stores.journal.list(access, 500);
      expect(journal.ok && journal.value.map((j) => j.path).sort(), `${name} journal`).toEqual(
        notes.filter((j) => journalReadable(access, j.provenance)).map((j) => j.path).sort(),
      );
    }
  });

  it('serves semantic search from the space\'s partial HNSW index and refuses a resized space', async () => {
    const url = await pgdb.database();
    const stores = await openMemory(url);
    const robin: MemorySubject = { kind: 'contacts', contactIds: [PRIMARY] };
    for (let i = 1; i <= 20; i += 1) {
      const record = memoryRecord(i, AUDIENCES[1] as Audience, robin, 'personal');
      await stores.memories.insert({
        receipt: { idempotencyKey: record.provenance.idempotencyKey, requestDigest: 'd', memoryId: record.id, outcome: 'created', at: AT },
        record,
        vector: { space: SPACE, values: hashEmbedding(`${record.content} ${String(i * 7)}`) },
        links: [],
        events: [],
        supersede: [],
      });
    }
    const access = accesses()[2]?.access as SourceAccess;
    const query = memorySemanticQuery(access, SPACE, hashEmbedding('lantern'), 5);
    if (!query.ok) throw new Error(JSON.stringify(query.error));
    const pool = new pg.Pool({ connectionString: url });
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      // A 20-row table is cheapest to sort; with sorting and other scans off the planner must
      // find an ordered path, which exists only if the query matches the space's HNSW index.
      for (const setting of ['enable_seqscan', 'enable_sort', 'enable_bitmapscan']) await client.query(`SET LOCAL ${setting} = off`);
      const plan = await client.query<{ 'QUERY PLAN': string }>(`EXPLAIN ${query.value.text}`, query.value.values);
      expect(plan.rows.map((r) => r['QUERY PLAN']).join('\n')).toContain(embeddingIndexName('memory_embeddings', SPACE));
      await client.query('ROLLBACK');
      const wrong = await stores.memories.putEmbedding('memory-1', SPACE, [1, 2, 3]);
      expect(wrong.ok || wrong.error).toMatchObject({ kind: 'invalid' });
    } finally {
      client.release();
      await pool.end();
    }
    const resized = await openPostgresMemoryState({ connectionString: url, onIdleError: (error) => idleErrors.push(error), space: { name: SPACE.name, dimensions: 8 } });
    expect(resized.ok || resized.error).toMatchObject({ kind: 'unavailable' });
  });

  it('runs the memory tools over Postgres: privacy, idempotency under concurrency, evolution and deletion', async () => {
    const stores = await openMemory(await pgdb.database());
    const world = await memoryWorld(stores);
    const robin = await world.admit('primary-dm');
    const sam = await world.admit('friend-dm');
    for (let i = 0; i < 4; i += 1) await world.must(robin, 'memory', 'write', { writeId: `r${String(i)}`, kind: 'fact', content: `Robin tends tomato bed ${String(i)}`, sensitivity: 'personal' });
    const own = await world.must<{ memoryId: string }>(sam, 'memory', 'write', { writeId: 's1', kind: 'fact', content: 'Sam waters the tomato garden', sensitivity: 'personal' });
    const found = await world.must<{ memories: { id: string }[]; mode: unknown }>(sam, 'memory', 'search', { query: 'tomato', limit: 1 });
    expect(found).toMatchObject({ memories: [{ id: own.memoryId }], mode: { lexical: 'ok', semantic: 'ok' } });
    expect((await world.must<{ total: number }>(sam, 'memory', 'census')).total).toBe(1);
    expect(kindOf(await world.call(sam, 'memory', 'get', { memoryId: 'memory-5' }))).toBe('not_found');

    const args = { writeId: 'race', kind: 'fact', content: 'Robin keeps three beehives on the roof garden', sensitivity: 'personal' };
    const [a, b] = await Promise.all([world.must<{ memoryId: string; replayed: boolean }>(robin, 'memory', 'write', args), world.must<{ memoryId: string; replayed: boolean }>(robin, 'memory', 'write', args)]);
    expect(a.memoryId).toBe(b.memoryId);
    expect([a.replayed, b.replayed].sort()).toEqual([false, true]);
    const mismatch = await world.call(robin, 'memory', 'write', { ...args, content: 'Robin keeps goats' });
    expect(mismatch.ok || mismatch.error).toMatchObject({ kind: 'conflict', reason: 'idempotency_mismatch' });

    const changed = await world.must<{ memoryId: string; outcome: string }>(robin, 'memory', 'write', {
      writeId: 'w2',
      kind: 'fact',
      content: 'Robin now keeps five beehives on the roof garden',
      sensitivity: 'personal',
    });
    expect(changed.outcome).toBe('superseded');
    const old = await stores.memories.get(a.memoryId);
    expect(old.ok && [old.value.state, old.value.supersededBy, old.value.revision]).toEqual(['superseded', changed.memoryId, 2]);

    const proposal = await world.must<{ proposalId: string }>(robin, 'memory', 'propose_delete', { memoryId: changed.memoryId, justification: 'inaccurate', explanation: 'wrong count' });
    expect((await world.administration.decideDeletion('operator:test', { proposalId: proposal.proposalId, approve: true })).ok).toBe(true);
    const afterDelete = await world.must<{ memories: { id: string }[] }>(robin, 'memory', 'search', { query: 'beehives' });
    expect(afterDelete.memories.map((m) => m.id)).not.toContain(changed.memoryId);
    await world.must(robin, 'memory', 'restore', { memoryId: changed.memoryId });
    const stale = await stores.memories.update({ ...(old.ok ? old.value : ({} as never)), content: 'x' }, 1, { memoryId: a.memoryId, kind: 'patched', author: { kind: 'companion' }, at: AT, detail: {} });
    expect(stale.ok || stale.error).toMatchObject({ kind: 'conflict', reason: 'stale_revision' });
  });

  it('backs up memory, episodes, journals and letters and restores them into a fresh database', async () => {
    const sourceUrl = await pgdb.database();
    const state = await pgdb.open(sourceUrl);
    const stores = await openMemory(sourceUrl);
    const world = await memoryWorld(stores);
    const robin = await world.admit('primary-dm');
    const self = await world.admit('reflection');
    await world.must(robin, 'memory', 'write', { writeId: 'w1', kind: 'fact', content: 'Robin keeps three beehives on the roof garden', sensitivity: 'personal' });
    await world.must(robin, 'memory', 'scratchpad_add', { text: 'ask about the hives' });
    await world.converse(robin, 'hi!', 'hello Robin', 'k1');
    world.clock.advance(ENDED_AFTER_MS);
    world.model.replies.set('memory_extraction', () => '{"memories":[]}');
    const report = await world.maintenance.run(await world.admit('maintenance'), { sessionLimit: 10, maxEntries: 100 });
    expect(report.ok && report.value.failures).toEqual([]);
    const formed = report.ok ? report.value.formation[0]?.episodes[0]?.episodeId : undefined;
    if (formed === undefined) throw new Error('no episode formed');
    await world.must(self, 'episode', 'author_meaning', { episodeId: formed, text: 'Robin said hello.', expectedRevision: 0 });
    await world.must(robin, 'journal', 'write', { path: 'people/robin.md', body: 'Robin keeps bees.' });
    await world.journal.recordReflection(self, { reflectionId: 'r1', templateId: 'evening', kind: 'companion_reflection', text: 'A warm day.' });
    await world.must(self, 'journal', 'letter_compose', { letterId: 'l1', subject: 'Spring', body: 'The hives are waking.' });
    await world.letterAdministration.deliverFromPartner({ letterId: 'p1', subject: 'Hi', body: 'Thinking of you.' });
    await world.must(self, 'journal', 'letter_read', { letterId: 'p1' });
    const backfill = await world.maintenance.run(await world.admit('maintenance'), { sessionLimit: 10, maxEntries: 100 });
    expect(backfill.ok && backfill.value.failures).toEqual([]);

    const fingerprint = await state.backup.fingerprint();
    const layout = await layoutFor(await tempRoots());
    const set = await openFileBackupStore(layout, 'set-1');
    if (!set.ok) throw new Error(JSON.stringify(set.error));
    const backup = createContinuityBackup({ components: [state.backup], clock: new FixedClock() });
    if (!backup.ok) throw new Error(JSON.stringify(backup.error));
    const made = await backup.value.backup(set.value);
    expect(made.ok && made.value.components[0]?.files.map((f) => f.path)).toEqual(expect.arrayContaining(['state/memories.jsonl', 'state/memory_embeddings.jsonl', 'state/letter_events.jsonl']));

    const targetUrl = await pgdb.database();
    const target = await pgdb.open(targetUrl);
    const restoreSet = await openFileBackupStore(layout, 'set-1');
    if (!restoreSet.ok) throw new Error(JSON.stringify(restoreSet.error));
    const targetBackup = createContinuityBackup({ components: [target.backup], clock: new FixedClock() });
    if (!targetBackup.ok) throw new Error(JSON.stringify(targetBackup.error));
    expect(kindOf(await targetBackup.value.restore(restoreSet.value))).toBe('ok');
    expect(await target.backup.fingerprint()).toEqual(fingerprint);

    const restored = await openMemory(targetUrl);
    const selfAccess = sourceAccessFor({ audience: { kind: 'self' }, admitted: [...SENSITIVITIES], worker: false }, null);
    const query = hashEmbedding('beehives roof garden');
    const before = await stores.memories.searchSemantic(selfAccess, SPACE, query, 5);
    const after = await restored.memories.searchSemantic(selfAccess, SPACE, query, 5);
    expect(after.ok && after.value.length).toBeGreaterThan(0);
    expect(after).toEqual(before);
    const episode = await restored.episodes.get(formed);
    expect(episode.ok && episode.value.meaning?.text).toBe('Robin said hello.');
    const meanings = await restored.episodes.meaningHistory(formed);
    expect(meanings.ok && meanings.value.length).toBe(1);
    const letterEvents = await restored.letters.events('p1', 10);
    expect(letterEvents.ok && letterEvents.value.map((e) => e.kind)).toEqual(['composed', 'read']);
    const cursor = await restored.formationCursors.get(report.ok ? (report.value.formation[0]?.sessionId ?? id('none')) : id('none'));
    expect(cursor.ok && cursor.value.seq).toBeGreaterThan(0);

    // Identity sequences were advanced past the restored rows, so new writes still insert.
    const next = memoryRecord(900, { kind: 'self' }, { kind: 'companion_internal' }, 'personal');
    const inserted = await restored.memories.insert({
      receipt: { idempotencyKey: next.provenance.idempotencyKey, requestDigest: 'd', memoryId: next.id, outcome: 'created', at: AT },
      record: next,
      vector: null,
      links: [],
      events: [{ memoryId: next.id, kind: 'created', author: { kind: 'companion' }, at: AT, detail: {} }],
      supersede: [],
    });
    expect(kindOf(inserted)).toBe('ok');
  });
});
