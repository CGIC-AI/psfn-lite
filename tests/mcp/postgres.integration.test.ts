/**
 * The MCP surface over the real Postgres memory, activity and automata
 * stores: the same bound callers, the same core dispatcher, and the SQL
 * access predicate keeping another audience's rows out of results, counts
 * and lookups.
 */
import type pg from 'pg';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createPostgresActivityStores,
  createPostgresPool,
  openPostgresMemoryState,
  type PostgresMemoryState,
} from '../../packages/adapters/src/index.ts';
import { SPACE } from '../core/memory-fakes.ts';
import { usePostgres } from '../adapters/pg-support.ts';
import { dockerTestsOptedOut } from '../support/postgres-harness.ts';
import { invoke, mcpWorld, mustInvoke } from './mcp-world.ts';

const pools: pg.Pool[] = [];
const memoryStates: PostgresMemoryState[] = [];
const idleErrors: Error[] = [];

afterEach(async () => {
  for (const pool of pools.splice(0)) await pool.end();
  for (const state of memoryStates.splice(0)) await state.close();
  if (idleErrors.length > 0) throw new Error(`idle pool errors: ${idleErrors.map((e) => e.message).join('; ')}`);
});

async function postgresWorld(url: string) {
  const pool = createPostgresPool({ connectionString: url, onIdleError: (error) => idleErrors.push(error) });
  pools.push(pool);
  const memory = await openPostgresMemoryState({ connectionString: url, onIdleError: (error) => idleErrors.push(error), space: SPACE });
  if (!memory.ok) throw new Error(JSON.stringify(memory.error));
  memoryStates.push(memory.value);
  return mcpWorld(createPostgresActivityStores(pool), memory.value);
}

describe.skipIf(dockerTestsOptedOut('mcp-postgres'))('MCP over the real adapters', () => {
  const pgdb = usePostgres();

  it('serves memory, journal, activity, workers and free time with audience filtering in SQL', async () => {
    const url = await pgdb.database();
    await pgdb.open(url);
    const w = await postgresWorld(url);
    const friend = await w.as('friend');
    const acquaintance = await w.as('acquaintance');
    const primary = await w.as('primary');

    const secret = 'Sam is quietly applying for a new job';
    const written = await mustInvoke<{ memoryId: string }>(friend, 'memory', { action: 'write', writeId: 'pg-1', kind: 'event', content: secret, sensitivity: 'personal' });
    expect((await invoke(friend, 'memory', { action: 'get', memoryId: written.memoryId })).text).toContain('new job');
    const census = await mustInvoke(acquaintance, 'memory', { action: 'census' });
    const search = await invoke(acquaintance, 'memory', { action: 'search', query: 'new job' });
    expect(search.text).not.toContain('new job');
    expect(JSON.stringify(census)).not.toContain('new job');
    expect(await invoke(acquaintance, 'memory', { action: 'get', memoryId: written.memoryId })).toMatchObject({ isError: true, payload: { error: { kind: 'not_found' } } });

    await mustInvoke(primary, 'journal', { action: 'write', path: 'garden/plan.md', body: 'Tomatoes first.' });
    expect(await mustInvoke(primary, 'journal', { action: 'read', path: 'garden/plan.md' })).toMatchObject({ body: 'Tomatoes first.' });
    expect((await invoke(friend, 'journal', { action: 'read', path: 'garden/plan.md' })).payload).toMatchObject({ error: { kind: 'not_found' } });

    const activity = await mustInvoke<{ id: string; revision: number }>(primary, 'activity', { action: 'start', purpose: 'plan the beds' });
    await mustInvoke(primary, 'activity', { action: 'update', activityId: activity.id, expectedRevision: activity.revision, note: 'three beds' });
    expect(JSON.stringify(await mustInvoke(primary, 'activity', { action: 'recent' }))).toContain('plan the beds');
    expect(JSON.stringify(await mustInvoke(friend, 'activity', { action: 'recent' }))).not.toContain('plan the beds');

    const spawned = await mustInvoke<{ run: { id: string; status: string } }>(primary, 'automata', {
      action: 'spawn',
      spawnId: 'pg-spawn',
      label: 'research',
      task: 'Find frost dates',
      actions: ['memory.search'],
      maxTurns: 2,
      maxSensitivity: 'personal',
    });
    expect(spawned.run.status).toBe('running');
    expect(await mustInvoke(primary, 'automata', { action: 'inspect', runId: spawned.run.id })).toMatchObject({ run: { id: spawned.run.id } });
    expect((await invoke(friend, 'automata', { action: 'inspect', runId: spawned.run.id })).payload).toMatchObject({ error: { kind: 'not_found' } });

    await w.inSelfTurn(async (self) => {
      expect(await mustInvoke<unknown[]>(self, 'free_time', { action: 'status' })).not.toHaveLength(0);
      await mustInvoke(self, 'free_time', { action: 'rest', minutes: 30 });
    });
    expect((await invoke(friend, 'free_time', { action: 'status' })).payload).toMatchObject({ error: { kind: 'denied', reason: 'audience_not_admitted' } });
    expect(w.errors).toEqual([]);
  });
});
