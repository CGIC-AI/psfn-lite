/**
 * Self-state continuity over the real adapters: Postgres self-state stores
 * next to the JSONL archive and the continuity stores, driven through the real
 * core services. Covers a crash and a harness change, the store contracts on
 * the database, and a full backup restored into a fresh history root and
 * database.
 */
import type pg from 'pg';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createHistoryBackupComponent,
  createPostgresPool,
  createPostgresSelfStateStores,
  openFileBackupStore,
  type FileSessionArchive,
  type PostgresState,
  type SelfStateStores,
  type StorageLayout,
} from '../../packages/adapters/src/index.ts';
import {
  EMPTY_APPRAISAL_GATE,
  NEUTRAL_AFFECT,
  createContinuityBackup,
  type ActiveConcern,
  type AppraisalEntry,
  type BackupStorePort,
  type EmotionReading,
  type EmotionStateRecord,
  type PendingFollowUp,
  type TurnId,
} from '../../packages/core/src/index.ts';
import { FakeApprovals, FakeModel } from '../core/continuity-fakes.ts';
import { registerPeople, standardTokens, wireWorld, type WorldPorts } from '../core/continuity-world.ts';
import { FakeAuthenticator, FixedClock, SequentialIds, TOOL_TRANSPORT } from '../core/fakes.ts';
import { FakeEstimator, FakeReflections, reading, steady } from '../core/self-state-fakes.ts';
import { wireSelfState } from '../core/self-state-world.ts';
import { dockerTestsOptedOut } from '../support/postgres-harness.ts';
import { layoutFor, openArchive, tempRoots } from './fs-support.ts';
import { usePostgres } from './pg-support.ts';

const errorOf = (result: { ok: boolean; error?: unknown }) => (result.ok ? 'ok' : result.error);
const contentOf = <T>(result: { ok: boolean; value?: { content: unknown } }): T => {
  if (!result.ok || result.value === undefined) throw new Error(`expected ok, got ${JSON.stringify(result)}`);
  return result.value.content as T;
};

interface Host {
  readonly clock: FixedClock;
  readonly ids: SequentialIds;
  readonly authenticator: FakeAuthenticator;
  readonly estimator: FakeEstimator;
  readonly appraiser: FakeModel;
  readonly reflections: FakeReflections;
}

function host(): Host {
  const authenticator = new FakeAuthenticator();
  standardTokens(authenticator);
  authenticator.tokens.set('primary-dm-mcp', { ...(authenticator.tokens.get('primary-dm') as object), surface: TOOL_TRANSPORT });
  return { clock: new FixedClock(), ids: new SequentialIds(), authenticator, estimator: new FakeEstimator(), appraiser: new FakeModel(), reflections: new FakeReflections() };
}

function realPorts(h: Host, archive: FileSessionArchive, state: PostgresState): WorldPorts {
  return {
    clock: h.clock,
    ids: h.ids,
    authenticator: h.authenticator,
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

function companion(h: Host, archive: FileSessionArchive, state: PostgresState, stores: SelfStateStores) {
  const ports = realPorts(h, archive, state);
  const base = { ...ports, ...wireWorld(ports) };
  return { ...base, ...wireSelfState(base, { ...stores, estimator: h.estimator, appraiser: h.appraiser, reflections: h.reflections }) };
}

async function backupStore(layout: StorageLayout, setName: string): Promise<BackupStorePort> {
  const opened = await openFileBackupStore(layout, setName);
  if (!opened.ok) throw new Error(JSON.stringify(opened.error));
  return opened.value;
}

function continuityBackup(archive: FileSessionArchive, state: PostgresState) {
  const created = createContinuityBackup({ components: [createHistoryBackupComponent(archive), state.backup], clock: new FixedClock() });
  if (!created.ok) throw new Error(JSON.stringify(created.error));
  return created.value;
}

/** Everything the self-state stores hold that a companion can reach, for before/after comparison. */
async function snapshotOf(stores: SelfStateStores, keys: readonly string[], observationIds: readonly string[]) {
  const concerns = await stores.concerns.list({ openOnly: false, limit: 50, after: null });
  const ids = concerns.ok ? concerns.value.map((c) => c.id) : [];
  return {
    states: await Promise.all(keys.map((k) => stores.emotionStates.get(k))),
    observations: await Promise.all(observationIds.map((id) => stores.emotionStates.observation(id))),
    appraisals: await stores.appraisals.recent({ limit: 50, before: null }),
    reports: await Promise.all(keys.map((k) => stores.selfReports.recent(k, 50))),
    concerns,
    events: await Promise.all(ids.map((id) => stores.concerns.events(id, 50))),
    followUps: await stores.followUps.list({ state: null, dueAtOrBefore: null, limit: 50, after: null }),
  };
}

describe.skipIf(dockerTestsOptedOut('self-state'))('self-state over the real adapters', () => {
  const pgdb = usePostgres();
  const pools: pg.Pool[] = [];
  const idleErrors: Error[] = [];

  afterEach(async () => {
    for (const pool of pools.splice(0)) await pool.end();
    if (idleErrors.length > 0) throw new Error(`idle pool errors: ${idleErrors.map((e) => e.message).join('; ')}`);
  });

  /** Self-state stores on their own pool; `pgdb.open` has already migrated the database. */
  const storesFor = (url: string) => {
    const pool = createPostgresPool({ connectionString: url, onIdleError: (error) => idleErrors.push(error) });
    pools.push(pool);
    return { pool, stores: createPostgresSelfStateStores(pool) };
  };

  it('keeps emotion state, the appraisal gate, concerns and follow-ups across a crash and a harness change', async () => {
    const layout = await layoutFor(await tempRoots());
    const url = await pgdb.database();
    const h = host();

    const firstArchive = await openArchive(layout);
    const firstState = await pgdb.open(url);
    const firstStores = storesFor(url);
    const first = companion(h, firstArchive, firstState, firstStores.stores);
    const people = await registerPeople(first.admin);
    const robin = await first.admit('primary-dm');
    await first.talk(robin, 'hello', 'hi Robin', 'k1', steady());
    const moved = await first.talk(robin, 'I lost my job', 'I am here with you', 'k2', reading(-0.8, 0.4, -0.2));
    expect(moved.observed).toMatchObject({ gate: 'appraisal_due', appraisal: { status: 'written' } });
    const concern = contentOf<ActiveConcern>(
      await first.call(robin, 'concern', 'create', { text: 'Robin is looking for work', evidenceRefs: [{ kind: 'turn', ref: moved.turnId }] }),
    );
    await first.call(robin, 'concern', 'follow_up_create', { content: 'Ask about the interviews', dueAt: '2030-01-03T10:00:00.000Z' });
    await first.selfReport(robin, 'I feel protective of Robin today');
    const before = contentOf<EmotionReading>(await first.call(robin, 'emotion', 'read'));
    const beforeAppraisals = contentOf<AppraisalEntry[]>(await first.call(robin, 'emotion', 'appraisals'));
    expect(h.appraiser.calls).toHaveLength(1);

    // The process dies: every store goes away.
    await firstArchive.close();
    await pgdb.close(firstState);
    await firstStores.pool.end();
    pools.splice(pools.indexOf(firstStores.pool), 1);

    // A different harness (the tool transport) picks the companion up over the same durable state.
    const archive = await openArchive(layout);
    const state = await pgdb.open(url);
    const successor = companion(h, archive, state, storesFor(url).stores);
    const viaMcp = await successor.admit('primary-dm-mcp');
    expect(contentOf<EmotionReading>(await successor.call(viaMcp, 'emotion', 'read'))).toEqual(before);
    expect(contentOf<AppraisalEntry[]>(await successor.call(viaMcp, 'emotion', 'appraisals'))).toEqual(beforeAppraisals);
    const listed = contentOf<ActiveConcern[]>(await successor.call(viaMcp, 'concern', 'list'));
    expect(listed).toEqual([concern]);
    expect(contentOf<PendingFollowUp[]>(await successor.call(viaMcp, 'concern', 'follow_up_list')).map((f) => f.content)).toEqual(['Ask about the interviews']);

    const estimatorCalls = h.estimator.calls.length;
    const replay = await successor.emotion.observeTurn(viaMcp, { turnId: moved.turnId, toolCallCount: 0 });
    expect(replay.ok && replay.value).toMatchObject({ status: 'replayed', inference: { estimator: 0, model: 0 } });
    expect(h.estimator.calls).toHaveLength(estimatorCalls);
    const stable = await successor.talk(viaMcp, 'thanks for listening', 'any time', 'k3', steady());
    expect(stable.observed).toMatchObject({ gate: 'no_movement', inference: { estimator: 1, model: 0 } });
    expect(h.appraiser.calls).toHaveLength(1);
    expect(before.scope).toEqual({ kind: 'direct', contactId: people.primary });
  });

  it('enforces compare-and-set and idempotency on the database', async () => {
    const url = await pgdb.database();
    await pgdb.open(url);
    const { stores } = storesFor(url);
    const record: EmotionStateRecord = {
      scope: { kind: 'self' },
      key: 'self',
      snapshot: NEUTRAL_AFFECT,
      updatedAt: '2030-01-01T00:00:00.000Z',
      lastTrusted: null,
      gate: EMPTY_APPRAISAL_GATE,
      selfModel: null,
      revision: 1,
    };
    const observation = { id: 'turn:t-1', scopeKey: 'self', kind: 'turn' as const, trusted: false, impulse: null, confidence: 0.1, producer: 'x', gate: 'untrusted_telemetry' as const, at: record.updatedAt };
    const [a, b] = await Promise.all([
      stores.emotionStates.commit({ next: record, expectedRevision: 0, observation: null }),
      stores.emotionStates.commit({ next: record, expectedRevision: 0, observation: null }),
    ]);
    expect([a, b].map((r) => (r.ok ? 'ok' : r.error.kind === 'conflict' && r.error.reason)).sort()).toEqual(['ok', 'stale_revision']);
    const second = { ...record, revision: 2 };
    expect(errorOf(await stores.emotionStates.commit({ next: second, expectedRevision: 1, observation }))).toBe('ok');
    expect(errorOf(await stores.emotionStates.commit({ next: { ...second, revision: 3 }, expectedRevision: 2, observation }))).toMatchObject({ reason: 'already_exists' });
    expect(await stores.emotionStates.get('self')).toEqual({ ok: true, value: second });

    const entry: AppraisalEntry = {
      id: 'appraisal:t-1',
      scopeKey: 'self',
      source: { kind: 'self' },
      sessionId: 's-1' as never,
      turnId: 't-1' as TurnId,
      summary: 'a reading',
      vad: { valence: 0.5, arousal: 0, dominance: 0 },
      delta: 0.5,
      author: { kind: 'machine', producer: 'emotion.appraisal' },
      at: record.updatedAt,
    };
    expect(await stores.appraisals.append(entry)).toEqual({ ok: true, value: entry });
    expect(await stores.appraisals.append(entry)).toEqual({ ok: true, value: entry });
    expect(errorOf(await stores.appraisals.append({ ...entry, summary: 'another' }))).toMatchObject({ reason: 'entry_mismatch' });

    const followUp: PendingFollowUp = {
      id: 'follow_up:1',
      target: { kind: 'self' },
      content: 'x',
      dueAt: '2030-01-02T00:00:00.000Z',
      state: 'pending',
      concernId: null,
      author: { kind: 'companion' },
      createdAt: record.updatedAt,
      activatedAt: null,
      revision: 1,
    };
    expect(await stores.followUps.create(followUp)).toEqual({ ok: true, value: { followUp, created: true } });
    expect(await stores.followUps.create({ ...followUp, createdAt: '2031-01-01T00:00:00.000Z' })).toEqual({ ok: true, value: { followUp, created: false } });
    expect(errorOf(await stores.followUps.update({ ...followUp, revision: 4 }, 2))).toMatchObject({ kind: 'invalid' });
    expect(errorOf(await stores.followUps.update({ ...followUp, revision: 3 }, 2))).toMatchObject({ reason: 'stale_revision' });
    expect(errorOf(await stores.followUps.update({ ...followUp, revision: 2 }, 1))).toBe('ok');
    expect(errorOf(await stores.followUps.update({ ...followUp, revision: 2 }, 1))).toMatchObject({ reason: 'stale_revision' });
  });

  it('filters and pages lists in the database by state, due time, status and cursor', async () => {
    const url = await pgdb.database();
    await pgdb.open(url);
    const { pool, stores } = storesFor(url);
    const base = Date.parse('2030-01-01T00:00:00.000Z');
    const at = (seconds: number) => new Date(base + seconds * 1000).toISOString();

    const followUp = (i: number): PendingFollowUp => ({
      id: `follow_up:${String(i).padStart(3, '0')}`,
      target: { kind: 'self' },
      content: `f${String(i)}`,
      // Pairs share a due time, so the id breaks ties in the cursor.
      dueAt: at(Math.floor(i / 2)),
      state: 'pending',
      concernId: null,
      author: { kind: 'companion' },
      createdAt: at(0),
      activatedAt: null,
      revision: 1,
    });
    for (let i = 0; i < 120; i += 1) {
      const made = followUp(i);
      expect(errorOf(await stores.followUps.create(made))).toBe('ok');
      if (i % 3 === 0) expect(errorOf(await stores.followUps.update({ ...made, state: 'activated', activatedAt: at(1), revision: 2 }, 1))).toBe('ok');
    }
    const pageAll = async (query: { state: 'pending' | null; dueAtOrBefore: string | null }) => {
      const seen: PendingFollowUp[] = [];
      for (;;) {
        const last = seen.at(-1);
        const page = await stores.followUps.list({ ...query, limit: 7, after: last === undefined ? null : { dueAt: last.dueAt, id: last.id } });
        if (!page.ok) throw new Error(JSON.stringify(page.error));
        seen.push(...page.value);
        if (page.value.length < 7) return seen;
      }
    };
    const pending = await pageAll({ state: 'pending', dueAtOrBefore: null });
    expect(pending.map((f) => f.id)).toEqual(Array.from({ length: 120 }, (_, i) => i).filter((i) => i % 3 !== 0).map((i) => followUp(i).id));
    expect(pending.every((f) => f.state === 'pending')).toBe(true);
    const duePending = await pageAll({ state: 'pending', dueAtOrBefore: at(10) });
    expect(duePending.map((f) => f.content)).toEqual(['f1', 'f2', 'f4', 'f5', 'f7', 'f8', 'f10', 'f11', 'f13', 'f14', 'f16', 'f17', 'f19', 'f20']);
    expect(await pageAll({ state: null, dueAtOrBefore: null })).toHaveLength(120);

    const concern = (i: number, status: ActiveConcern['status']): ActiveConcern => ({
      id: `concern-${String(i).padStart(3, '0')}`,
      text: `c${String(i)}`,
      status,
      priority: 'medium',
      sensitivity: 'public',
      owner: 'companion',
      author: { kind: 'companion' },
      formedIn: { kind: 'self' },
      contactId: null,
      evidenceRefs: [],
      formationVad: null,
      resolution: null,
      nextReviewAt: null,
      createdAt: at(0),
      updatedAt: at(Math.floor(i / 2)),
      revision: 1,
    });
    for (let i = 0; i < 60; i += 1) {
      const made = concern(i, 'active');
      const event = { concernId: made.id, revision: 1, kind: 'created' as const, from: null, to: 'active' as const, evidenceRefs: [], outcome: null, resolution: null, author: made.author, at: made.updatedAt };
      expect(errorOf(await stores.concerns.create(made, event))).toBe('ok');
      if (i % 4 === 0) {
        const closed = { ...made, status: 'dismissed' as const, revision: 2 };
        expect(errorOf(await stores.concerns.update(closed, 1, { ...event, revision: 2, kind: 'transitioned', from: 'active', to: 'dismissed' }))).toBe('ok');
      }
    }
    const openConcerns: ActiveConcern[] = [];
    for (;;) {
      const last = openConcerns.at(-1);
      const page = await stores.concerns.list({ openOnly: true, limit: 9, after: last === undefined ? null : { updatedAt: last.updatedAt, id: last.id } });
      if (!page.ok) throw new Error(JSON.stringify(page.error));
      openConcerns.push(...page.value);
      if (page.value.length < 9) break;
    }
    const expectedOpen = Array.from({ length: 60 }, (_, i) => 59 - i).filter((i) => i % 4 !== 0).map((i) => concern(i, 'active').id);
    expect(openConcerns.map((c) => c.id)).toEqual(expectedOpen);
    const everyConcern = await stores.concerns.list({ openOnly: false, limit: 100, after: null });
    expect(everyConcern.ok && everyConcern.value).toHaveLength(60);
    // The status column is checked against the record, so a filter can never disagree with it.
    await expect(pool.query("UPDATE concerns SET status = 'active' WHERE concern_id = 'concern-000'")).rejects.toThrow(/check constraint/);

    const entry = (i: number): AppraisalEntry => ({
      id: `appraisal:t-${String(i)}`,
      scopeKey: 'self',
      source: { kind: 'self' },
      sessionId: 's-1' as never,
      turnId: `t-${String(i)}` as TurnId,
      summary: `a${String(i)}`,
      vad: { valence: 0, arousal: 0, dominance: 0 },
      delta: 0.5,
      author: { kind: 'machine', producer: 'emotion.appraisal' },
      at: at(i),
    });
    for (let i = 0; i < 12; i += 1) expect(errorOf(await stores.appraisals.append(entry(i)))).toBe('ok');
    const first = await stores.appraisals.recent({ limit: 5, before: null });
    expect(first.ok && first.value.map((e) => e.summary)).toEqual(['a11', 'a10', 'a9', 'a8', 'a7']);
    const next = await stores.appraisals.recent({ limit: 5, before: 'appraisal:t-7' });
    expect(next.ok && next.value.map((e) => e.summary)).toEqual(['a6', 'a5', 'a4', 'a3', 'a2']);
    expect(errorOf(await stores.appraisals.recent({ limit: 5, before: 'appraisal:missing' }))).toMatchObject({ kind: 'not_found' });
  });

  it('restores self-state from a full backup into a fresh database and carries on from it', async () => {
    const sourceLayout = await layoutFor(await tempRoots());
    const h = host();
    const archive = await openArchive(sourceLayout);
    const sourceUrl = await pgdb.database();
    const sourceState = await pgdb.open(sourceUrl);
    const sourceStores = storesFor(sourceUrl).stores;
    const world = companion(h, archive, sourceState, sourceStores);
    const people = await registerPeople(world.admin);
    const robin = await world.admit('primary-dm');
    const sam = await world.admit('friend-dm');
    await world.talk(robin, 'hello', 'hi', 'k1', steady());
    const moved = await world.talk(robin, 'my sister is ill', 'I am sorry', 'k2', reading(-0.7, 0.5, -0.3));
    await world.talk(sam, 'hike on saturday?', 'gladly', 'k3', reading(0.4, 0.3, 0.1));
    const concern = contentOf<ActiveConcern>(await world.call(robin, 'concern', 'create', { text: "Robin's sister is ill", evidenceRefs: [{ kind: 'turn', ref: moved.turnId }] }));
    await world.talk(robin, 'she is recovering', 'wonderful news', 'k4', reading(0.9, -0.2, 0.4));
    const resolved = contentOf<{ concern: ActiveConcern; relief: { status: string } }>(
      await world.call(robin, 'concern', 'resolve', { concernId: concern.id, expectedRevision: 1, outcome: 'recovering well' }),
    );
    expect(resolved.relief).toEqual({ status: 'applied' });
    await world.call(robin, 'concern', 'follow_up_create', { content: 'Ask how her sister is', dueAt: '2030-01-05T10:00:00.000Z' });
    await world.selfReport(sam, 'Looking forward to the hike');

    const keys = [`direct:${people.primary}`, `direct:${people.friend}`];
    const observationIds = [`turn:${moved.turnId}`, `relief:${resolved.concern.resolution?.generationId ?? ''}`];
    const original = await snapshotOf(sourceStores, keys, observationIds);
    expect(original.observations.every((o) => o.ok && o.value !== null)).toBe(true);

    const made = await continuityBackup(archive, sourceState).backup(await backupStore(sourceLayout, 'set-1'));
    expect(errorOf(made)).toBe('ok');

    const restoredArchive = await openArchive(await layoutFor(await tempRoots()));
    const restoredUrl = await pgdb.database();
    const restoredState = await pgdb.open(restoredUrl);
    expect(errorOf(await continuityBackup(restoredArchive, restoredState).restore(await backupStore(sourceLayout, 'set-1')))).toBe('ok');
    const restoredStores = storesFor(restoredUrl).stores;
    expect(await snapshotOf(restoredStores, keys, observationIds)).toEqual(original);

    // The restored companion carries on: no turn is observed twice and new appraisals append after the restored ones.
    const restored = companion(h, restoredArchive, restoredState, restoredStores);
    const again = await restored.admit('primary-dm');
    const estimatorCalls = h.estimator.calls.length;
    const replay = await restored.emotion.observeTurn(again, { turnId: moved.turnId, toolCallCount: 0 });
    expect(replay.ok && replay.value).toMatchObject({ status: 'replayed', inference: { estimator: 0 } });
    expect(h.estimator.calls).toHaveLength(estimatorCalls);
    const next = await restored.talk(again, 'actually she is back in hospital', 'oh no', 'k5', reading(-1, 0.6, -0.5));
    expect(next.observed).toMatchObject({ gate: 'appraisal_due', appraisal: { status: 'written' } });
    const appraisals = contentOf<AppraisalEntry[]>(await restored.call(again, 'emotion', 'appraisals'));
    const sourceAppraisals = contentOf<AppraisalEntry[]>(await world.call(robin, 'emotion', 'appraisals'));
    expect(appraisals).toEqual([next.observed.appraisal?.status === 'written' ? next.observed.appraisal.entry : null, ...sourceAppraisals]);
    expect(sourceAppraisals.map((a) => a.turnId)).toContain(moved.turnId);
  });
});
