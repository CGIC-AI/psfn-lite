import { spawnSync } from 'node:child_process';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HARNESS_START_TIMEOUT_MS, dockerTestsOptedOut, startPostgresHarness, type PostgresHarness } from './postgres-harness.ts';

const optedOut = dockerTestsOptedOut('postgres harness');

describe.skipIf(optedOut)('postgres test harness', () => {
  let harness: PostgresHarness | undefined;

  beforeAll(async () => {
    harness = await startPostgresHarness();
  }, HARNESS_START_TIMEOUT_MS);

  afterAll(() => {
    harness?.stop();
  });

  it('serves the pinned pgvector image in isolated databases and removes only its own container', async () => {
    if (harness === undefined) throw new Error('harness did not start');
    expect(harness.containerName).toMatch(/^lite-pg-[0-9a-f]{12}$/);
    const url = await harness.createDatabase();
    const client = new pg.Client({ connectionString: url });
    await client.connect();
    try {
      await client.query('CREATE EXTENSION vector');
      const version = await client.query<{ extversion: string }>("SELECT extversion FROM pg_extension WHERE extname = 'vector'");
      expect(version.rows[0]?.extversion).toBe('0.8.2');
    } finally {
      await client.end();
    }

    const name = harness.containerName;
    harness.stop();
    harness = undefined;
    const inspect = spawnSync('docker', ['container', 'inspect', name], { encoding: 'utf8' });
    expect(inspect.status).not.toBe(0);
  });
});
