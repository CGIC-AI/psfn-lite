/**
 * Reserved migration numbers against a real database: a database migrated
 * while a lower lane's number was still missing moves forward when that
 * migration lands, and anything the code does not know still stops startup.
 */
import { createHash } from 'node:crypto';
import pg from 'pg';
import { describe, expect, it } from 'vitest';
import { loadMigrations, migrate, type Migration } from '../../packages/adapters/src/index.ts';
import { requireCurrentSchema } from '../../packages/adapters/src/postgres/migrations.ts';
import { dockerTestsOptedOut } from '../support/postgres-harness.ts';
import { usePostgres } from './pg-support.ts';

const errorOf = (result: { ok: boolean; error?: unknown }) => (result.ok ? 'ok' : result.error);

function synthetic(version: number, name: string, sql: string): Migration {
  return { version, name, sql, checksum: createHash('sha256').update(sql).digest('hex') };
}

describe.skipIf(dockerTestsOptedOut('migration gap'))('reserved migration numbers', () => {
  const pgdb = usePostgres();

  it('applies a lower-numbered migration that lands after a higher one, and still refuses unknown ones', async () => {
    const shipped = loadMigrations();
    const highest = shipped.at(-1)?.version ?? 0;
    // Two lanes reserve the next two numbers; the higher one is applied first and the lower lands late.
    const late = synthetic(highest + 1, 'late_lane', 'CREATE TABLE late_lane_probe (id integer PRIMARY KEY)');
    const early = synthetic(highest + 2, 'early_lane', 'CREATE TABLE early_lane_probe (id integer PRIMARY KEY)');
    const gapped = [...shipped, early];
    const merged = [...shipped, late, early];

    const url = await pgdb.database();
    const pool = new pg.Pool({ connectionString: url });
    try {
      const before = await migrate(pool, gapped);
      expect(before.ok && before.value.map((m) => m.version)).toEqual(gapped.map((m) => m.version));

      const after = await migrate(pool, merged);
      expect(after.ok && after.value.map((m) => m.version)).toEqual(merged.map((m) => m.version));
      expect((await pool.query("SELECT to_regclass('late_lane_probe') IS NOT NULL AS present")).rows[0]).toEqual({ present: true });
      const client = await pool.connect();
      try {
        expect(errorOf(await requireCurrentSchema(client, merged))).toBe('ok');
        // Code that has not seen the late migration refuses a database that has it.
        expect(errorOf(await requireCurrentSchema(client, gapped))).toMatchObject({ detail: expect.stringContaining('does not know') as unknown });
      } finally {
        client.release();
      }
      expect(errorOf(await migrate(pool, gapped))).toMatchObject({ kind: 'unavailable', detail: expect.stringContaining('does not know') as unknown });
      // Another lane's migration under the same number is not the same migration.
      const impostor = synthetic(late.version, 'other_lane', 'CREATE TABLE other_lane_probe (id integer)');
      expect(errorOf(await migrate(pool, [...shipped, impostor, early]))).toMatchObject({ detail: expect.stringContaining('does not know') as unknown });
    } finally {
      await pool.end();
    }
  });
});
