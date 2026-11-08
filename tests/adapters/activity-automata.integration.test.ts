/**
 * Activity, bounded workers, free time and self-scheduled time over the real
 * Postgres stores, driven through the real core stack. Covers a restart in
 * the middle of quiet time and of a worker attempt, the store contracts under
 * real transactions, and a backup of the new state restored into a fresh
 * database.
 */
import type pg from 'pg';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createPostgresActivityStores,
  createPostgresPool,
  openFileBackupStore,
  openPostgresMemoryState,
  type PostgresActivityStores,
  type PostgresMemoryState,
} from '../../packages/adapters/src/index.ts';
import {
  createContinuityBackup,
  ok,
  type ActivityId,
  type ActivityRecord,
  type FreeTimeBlock,
  type FreeTimeLaneStatus,
  type ReflectionTemplate,
  type TrustedTurnScope,
  type WorkerEffect,
  type WorkerRun,
  type WorkerRunId,
} from '../../packages/core/src/index.ts';
import { activityWorld, fakeHosts, WORKER_LEASE_MS } from '../core/activity-world.ts';
import { FixedClock } from '../core/fakes.ts';
import { SPACE } from '../core/memory-fakes.ts';
import { kindOf } from '../core/memory-world.ts';
import { dockerTestsOptedOut } from '../support/postgres-harness.ts';
import { layoutFor, tempRoots } from './fs-support.ts';
import { usePostgres } from './pg-support.ts';

const pools: pg.Pool[] = [];
const memoryStates: PostgresMemoryState[] = [];
const idleErrors: Error[] = [];

afterEach(async () => {
  for (const pool of pools.splice(0)) await pool.end();
  for (const state of memoryStates.splice(0)) await state.close();
  if (idleErrors.length > 0) throw new Error(`idle pool errors: ${idleErrors.map((e) => e.message).join('; ')}`);
});

/** A host process: its own pools over the database, as a restart would open them. */
async function connect(url: string): Promise<{ readonly pool: pg.Pool; readonly stores: PostgresActivityStores; readonly memory: PostgresMemoryState }> {
  const pool = createPostgresPool({ connectionString: url, onIdleError: (error) => idleErrors.push(error) });
  pools.push(pool);
  const memory = await openPostgresMemoryState({ connectionString: url, onIdleError: (error) => idleErrors.push(error), space: SPACE });
  if (!memory.ok) throw new Error(JSON.stringify(memory.error));
  memoryStates.push(memory.value);
  return { pool, stores: createPostgresActivityStores(pool), memory: memory.value };
}

/** Ends a host's pools early, as a crash would. */
async function stop(host: { readonly pool: pg.Pool; readonly memory: PostgresMemoryState }) {
  pools.splice(pools.indexOf(host.pool), 1);
  memoryStates.splice(memoryStates.indexOf(host.memory), 1);
  await host.pool.end();
  await host.memory.close();
}

async function tick(w: Awaited<ReturnType<typeof activityWorld>>, scope: TrustedTurnScope) {
  const ran = await w.scheduler.tick(scope);
  if (!ran.ok) throw new Error(JSON.stringify(ran.error));
  return ran.value;
}

const SPAWN = { spawnId: 'spawn-1', label: 'research', task: 'Collect sources on tide pools', actions: ['memory.write', 'memory.search'], maxTurns: 3, maxSensitivity: 'personal' };

describe.skipIf(dockerTestsOptedOut('activity-automata'))('activity and automata over the real adapters', () => {
  const pgdb = usePostgres();

  it('keeps a decline and a held worker attempt across a restart, without re-asking or re-running', async () => {
    const url = await pgdb.database();
    await pgdb.open(url);
    const first = await connect(url);
    const before = await activityWorld(first.stores, first.memory);
    const self = await before.admit('free-time');
    before.internalTurns.script = async (request) => {
      if (request.prompt.startsWith('Free time is open')) await before.must(request.scope, 'free_time', 'rest', { blockId: request.reference.id });
      return ok({ status: 'completed', reply: null });
    };
    await tick(before, self);
    expect(before.internalTurns.requests).toHaveLength(1);
    const spawned = await before.must<{ run: WorkerRun }>(await before.admit('primary-dm'), 'automata', 'spawn', SPAWN);
    expect(spawned.run.status).toBe('running');
    await stop(first);

    // A new process with fresh hosts: nothing is in memory except what Postgres kept.
    const second = await connect(url);
    const hosts = fakeHosts();
    const after = await activityWorld(second.stores, second.memory, { hosts, owner: 'host-b' });
    const selfAgain = await after.admit('free-time');
    after.clock.advance(WORKER_LEASE_MS + 1);
    const recovered = await tick(after, selfAgain);
    expect(recovered.workers.ok && recovered.workers.value).toMatchObject({ requeued: [spawned.run.id] });
    const requeued = await second.stores.workerRuns.get(spawned.run.id);
    expect(requeued.ok && requeued.value).toMatchObject({ status: 'queued', reason: 'lease_expired_requeued', attempts: 1, lease: null });
    // Its conversation never comes back to drive it, so after the grace window it settles instead of waiting forever.
    for (let i = 0; i < 10; i += 1) {
      after.clock.advance(30 * 60_000);
      await tick(after, selfAgain);
    }
    expect(hosts.internalTurns.requests).toHaveLength(0);
    expect(hosts.templateModel.calls).toHaveLength(0);
    expect(hosts.workerHost.sessions).toHaveLength(0);
    const status = await after.must<FreeTimeLaneStatus[]>(selfAgain, 'free_time', 'status');
    expect(status.map((s) => [s.lane, s.gate, s.rest?.madeBy])).toEqual([
      ['quiet_hours', { kind: 'ineligible', reason: 'silenced' }, 'companion'],
      ['idle', { kind: 'ineligible', reason: 'silenced' }, 'companion'],
    ]);
    expect(status.find((s) => s.lane === 'idle')?.recent.map((b) => b.state)).toEqual(['rested']);
    const run = await second.stores.workerRuns.get(spawned.run.id);
    expect(run.ok && run.value).toMatchObject({ status: 'failed', outcome: 'failed', reason: 'not_resumed', attempts: 1, lease: null });
    const activity = await second.stores.activities.get(spawned.run.activityId);
    expect(activity.ok && activity.value.status).toBe('failed');
  });

  it('enforces the store contracts under real transactions', async () => {
    const url = await pgdb.database();
    await pgdb.open(url);
    const { stores } = await connect(url);
    const w = await activityWorld(stores, (await connect(url)).memory);
    const primary = await w.admit('primary-dm');
    const { run } = await w.must<{ run: WorkerRun }>(primary, 'automata', 'spawn', SPAWN);

    const activity = await stores.activities.get(run.activityId);
    if (!activity.ok) throw new Error(JSON.stringify(activity.error));
    expect(kindOf(await stores.activities.insert(activity.value))).toBe('conflict');
    expect(await stores.activities.update({ ...activity.value, revision: activity.value.revision + 2 }, activity.value.revision)).toMatchObject({ ok: false, error: { kind: 'invalid' } });
    const stale = await stores.activities.update({ ...activity.value, revision: 9 }, 8);
    expect(stale.ok || stale.error).toMatchObject({ kind: 'conflict', reason: 'stale_revision' });
    expect(kindOf(await stores.workerRuns.insert(run))).toBe('conflict');
    const missing = await stores.workerRuns.update({ ...run, id: 'worker_run:missing' as WorkerRunId, revision: run.revision + 1 }, run.revision);
    expect(kindOf(missing)).toBe('not_found');

    const effect: WorkerEffect = { runId: run.id, effectKey: 'e-1', tool: 'memory', action: 'write', requestDigest: 'd', attempt: 1, phase: 'started', result: null, error: null, startedAt: '2030-01-01T00:00:00.000Z', settledAt: null };
    expect(await stores.workerEffects.begin(effect)).toEqual({ ok: true, value: { effect, created: true } });
    expect(await stores.workerEffects.begin({ ...effect, requestDigest: 'other' })).toMatchObject({ ok: true, value: { effect: { requestDigest: 'd' }, created: false } });
    const applied = { ...effect, phase: 'applied' as const, result: { memoryId: 'm-1' }, settledAt: '2030-01-01T00:00:01.000Z' };
    expect(await stores.workerEffects.settle(applied)).toEqual({ ok: true, value: applied });
    const resettled = await stores.workerEffects.settle({ ...applied, phase: 'rejected' });
    expect(resettled.ok || resettled.error).toMatchObject({ kind: 'conflict', reason: 'stale_revision' });

    const later = { kind: 'companion_rested', until: '2030-01-01T06:00:00.000Z', decidedAt: '2030-01-01T00:00:00.000Z' } as const;
    await stores.restState.extend('idle', later);
    const shorter = await stores.restState.extend('idle', { kind: 'system_failure', until: '2030-01-01T01:00:00.000Z', decidedAt: '2030-01-01T00:30:00.000Z', reason: 'x' });
    expect(shorter).toEqual({ ok: true, value: later });

    const template: ReflectionTemplate = { id: 'evening', name: 'evening', prompt: 'p', schedule: { kind: 'manual' }, enabled: true, nextRunAt: null, lastRun: null, pendingRun: null, updatedAt: '2030-01-01T00:00:00.000Z', revision: 1 };
    expect((await stores.reflectionTemplates.put(template, 0)).ok).toBe(true);
    const racing = await stores.reflectionTemplates.put(template, 0);
    expect(racing.ok || racing.error).toMatchObject({ kind: 'conflict', reason: 'stale_revision' });

    const block: FreeTimeBlock = {
      id: 'free_time_block-x',
      lane: 'idle',
      state: 'invited',
      options: [],
      invitedAt: '2030-01-01T00:00:00.000Z',
      localDay: '2030-01-01',
      decidedAt: null,
      choice: null,
      activityId: null,
      outcome: null,
      failure: null,
      revision: 1,
    };
    expect((await stores.freeTimeBlocks.create(block)).ok).toBe(true);
    // A block can only point at an activity that exists.
    expect(kindOf(await stores.freeTimeBlocks.update({ ...block, activityId: 'activity:missing' as ActivityId, revision: 2 }, 1))).toBe('unavailable');
    expect(kindOf(await stores.freeTimeBlocks.update({ ...block, lane: 'quiet_hours', revision: 2 }, 1))).toBe('unavailable');
    // One open block across every lane: a second invitation, even on the other lane, is refused by the index.
    const second = await stores.freeTimeBlocks.create({ ...block, id: 'free_time_block-y', lane: 'quiet_hours', invitedAt: '2030-01-01T00:01:00.000Z' });
    expect(second.ok || second.error).toMatchObject({ kind: 'conflict', reason: 'turn_already_open' });
    expect(kindOf(await stores.freeTimeBlocks.create(block))).toBe('conflict');
    expect((await stores.freeTimeBlocks.update({ ...block, state: 'lapsed', revision: 2 }, 1)).ok).toBe(true);
    expect((await stores.freeTimeBlocks.create({ ...block, id: 'free_time_block-y', invitedAt: '2030-01-01T00:02:00.000Z' })).ok).toBe(true);

    for (const n of [1, 2, 3]) {
      await w.must(primary, 'concern', 'reminder_create', { kind: 'check_in', title: `t${String(n)}`, content: 'c', dueAt: `2030-01-0${String(n)}T12:00:00.000Z` });
    }
    const page = await stores.careReminders.list({ states: ['pending'], dueAtOrBefore: '2030-01-02T12:00:00.000Z', limit: 1, after: null });
    const firstDue = page.ok ? page.value[0] : undefined;
    if (firstDue === undefined) throw new Error('no reminder page');
    const next = await stores.careReminders.list({ states: ['pending'], dueAtOrBefore: '2030-01-02T12:00:00.000Z', limit: 5, after: { dueAt: firstDue.dueAt, id: firstDue.id } });
    expect(next.ok && next.value.map((r) => r.title)).toEqual(['t2']);
  });

  it('restores activity, worker, free-time and schedule state from a backup into a fresh database', async () => {
    const url = await pgdb.database();
    const state = await pgdb.open(url);
    const source = await connect(url);
    const w = await activityWorld(source.stores, source.memory);
    const primary = await w.admit('primary-dm');
    const self = await w.admit('free-time');

    // A worker that wrote through its effect fence and finished.
    await w.must(primary, 'automata', 'spawn', SPAWN);
    const session = w.workerHost.latest();
    expect((await session.beginTurn()).ok).toBe(true);
    const wrote = await session.call('write-1', { tool: 'memory', action: 'write', args: { writeId: 'w-1', kind: 'fact', content: 'Tide pools hold anemones', sensitivity: 'personal' } });
    expect(wrote.ok).toBe(true);
    const finished = await session.finish({ outcome: 'completed', summary: 'Found sources', artifacts: [{ kind: 'note', ref: 'n-1' }], reason: null, usage: { modelCalls: 1, inputTokens: 1, outputTokens: 1 } });
    expect(finished.ok).toBe(true);
    // Free time chosen and reflected on; a decline afterwards.
    w.internalTurns.script = async (request) => {
      if (request.prompt.startsWith('Free time is open')) await w.must(request.scope, 'free_time', 'choose', { blockId: request.reference.id, optionId: 'reflect' });
      return ok({ status: 'completed', reply: 'The tide came in slowly.' });
    };
    await tick(w, self);
    await w.must(self, 'free_time', 'rest', {});
    await w.must(self, 'free_time', 'schedule_prompt', { scheduleId: 's-1', name: 'garden', prompt: 'Revisit the garden notes', at: '2030-01-02T09:00', timeZone: 'Europe/Berlin' });
    await w.must(self, 'free_time', 'update_template', { templateId: 'evening', expectedRevision: 0, name: 'evening', prompt: 'What mattered?', schedule: { kind: 'daily', localTime: '21:00', timeZone: 'UTC' } });
    await w.must(primary, 'concern', 'reminder_create', { kind: 'occasion', title: 'Birthday', content: 'Wish them well', schedule: 'daily', dueAt: '2030-01-05T09:00:00.000Z' });

    const snapshot = async (stores: PostgresActivityStores, memory: PostgresMemoryState) => {
      const activities = await stores.activities.list(50, null);
      const runs = await stores.workerRuns.list({ statuses: null, limit: 50, after: null });
      const effects = runs.ok ? await Promise.all(runs.value.map((r) => stores.workerEffects.list(r.id))) : [];
      return {
        activities,
        runs,
        effects,
        rest: [await stores.restState.read('idle'), await stores.restState.read('quiet_hours')],
        blocks: [await stores.freeTimeBlocks.recent('idle', 10), await stores.freeTimeBlocks.recent('quiet_hours', 10)],
        prompts: await stores.scheduledPrompts.list({ states: null, dueAtOrBefore: null, limit: 10, after: null }),
        templates: await stores.reflectionTemplates.list(10),
        reminders: await stores.careReminders.list({ states: null, dueAtOrBefore: null, limit: 10, after: null }),
        reflections: await memory.reflections.list(10),
      };
    };
    const original = await snapshot(source.stores, source.memory);
    expect(original.activities.ok && original.activities.value.map((a: ActivityRecord) => a.status).sort()).toEqual(['completed', 'completed']);
    expect(original.effects.flatMap((e) => (e.ok ? e.value.map((x) => x.phase) : []))).toEqual(['applied']);
    expect(original.reflections.ok && original.reflections.value.map((r) => r.text)).toEqual(['The tide came in slowly.']);
    expect(original.rest.every((r) => r.ok && r.value?.kind === 'companion_rested')).toBe(true);

    const fingerprint = await state.backup.fingerprint();
    const layout = await layoutFor(await tempRoots());
    const set = await openFileBackupStore(layout, 'set-1');
    if (!set.ok) throw new Error(JSON.stringify(set.error));
    const backup = createContinuityBackup({ components: [state.backup], clock: new FixedClock() });
    if (!backup.ok) throw new Error(JSON.stringify(backup.error));
    const made = await backup.value.backup(set.value);
    expect(made.ok && made.value.components[0]?.files.map((f) => f.path)).toEqual(
      expect.arrayContaining(['state/activities.jsonl', 'state/worker_runs.jsonl', 'state/worker_effects.jsonl', 'state/rest_states.jsonl', 'state/free_time_blocks.jsonl', 'state/scheduled_prompts.jsonl', 'state/reflection_templates.jsonl', 'state/care_reminders.jsonl']),
    );

    const targetUrl = await pgdb.database();
    const target = await pgdb.open(targetUrl);
    const restoreSet = await openFileBackupStore(layout, 'set-1');
    if (!restoreSet.ok) throw new Error(JSON.stringify(restoreSet.error));
    const targetBackup = createContinuityBackup({ components: [target.backup], clock: new FixedClock() });
    if (!targetBackup.ok) throw new Error(JSON.stringify(targetBackup.error));
    expect(kindOf(await targetBackup.value.restore(restoreSet.value))).toBe('ok');
    expect(await target.backup.fingerprint()).toEqual(fingerprint);
    const restored = await connect(targetUrl);
    expect(await snapshot(restored.stores, restored.memory)).toEqual(original);
  });
});
