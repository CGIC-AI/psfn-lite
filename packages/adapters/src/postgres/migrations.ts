/**
 * Versioned SQL migrations. Files named `NNNN_name.sql` beside this module are
 * applied in version order, each in its own transaction, under an advisory
 * lock so concurrent starts cannot race. Every applied migration's checksum is
 * recorded and re-verified on each run, matched by version: an edited or
 * unknown applied migration stops startup instead of running against a schema
 * the code does not describe.
 *
 * Parallel lanes reserve migration numbers, so a lower number can land after
 * a higher one has been applied (a database at [1, 3] meets code that knows
 * [1, 2, 3]). The missing migration is then applied, so such a database moves
 * forward instead of being stranded. That is safe only because reserved-lane
 * migrations touch disjoint tables; a migration that depends on another must
 * take a higher number than it.
 */
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import type pg from 'pg';
import { ok, unavailable, type Result } from '../core.ts';
import { fromDriverError } from './database.ts';

export interface Migration {
  readonly version: number;
  readonly name: string;
  readonly checksum: string;
  readonly sql: string;
}

export interface AppliedMigration {
  readonly version: number;
  readonly name: string;
  readonly checksum: string;
}

const MIGRATIONS_DIR = new URL('./migrations/', import.meta.url);
const FILE_PATTERN = /^(\d{4})_([a-z0-9_]+)\.sql$/;
/** Arbitrary constant naming this schema's migration lock. */
const MIGRATION_LOCK_KEY = 7_340_001;

export function loadMigrations(dir: URL = MIGRATIONS_DIR): Migration[] {
  const migrations = readdirSync(dir)
    .filter((name) => name.endsWith('.sql'))
    .map((file) => {
      const match = FILE_PATTERN.exec(file);
      if (match === null) throw new Error(`migration file ${file} must be named NNNN_name.sql`);
      const sql = readFileSync(new URL(file, dir), 'utf8');
      return {
        version: Number(match[1]),
        name: match[2] as string,
        checksum: createHash('sha256').update(sql).digest('hex'),
        sql,
      };
    })
    .sort((a, b) => a.version - b.version);
  // Versions are unique and increasing from 0001. Parallel lanes reserve numbers, so a gap
  // can exist until the earlier lane lands; applied migrations are matched by version.
  migrations.forEach((migration, index) => {
    const previous = index === 0 ? 0 : (migrations[index - 1]?.version ?? 0);
    if (migration.version <= previous || (index === 0 && migration.version !== 1)) {
      throw new Error(`migrations must start at 0001 with unique increasing numbers; found ${String(migration.version)}`);
    }
  });
  return migrations;
}

/** Applies pending migrations and verifies applied ones. Returns the applied list afterwards. */
export async function migrate(pool: pg.Pool, migrations: readonly Migration[] = loadMigrations()): Promise<Result<readonly AppliedMigration[]>> {
  let client: pg.PoolClient;
  try {
    client = await pool.connect();
  } catch (error) {
    return fromDriverError(error);
  }
  try {
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_KEY]);
    try {
      await client.query(
        `CREATE TABLE IF NOT EXISTS schema_migrations (
           version integer PRIMARY KEY,
           name text NOT NULL,
           checksum text NOT NULL,
           applied_at timestamptz NOT NULL DEFAULT now()
         )`,
      );
      const applied = await readApplied(client);
      const drift = verifyApplied(applied, migrations);
      if (!drift.ok) return drift;
      const done = new Set(applied.map((m) => m.version));
      for (const migration of migrations.filter((m) => !done.has(m.version))) {
        await client.query('BEGIN');
        try {
          await client.query(migration.sql);
          await client.query('INSERT INTO schema_migrations (version, name, checksum) VALUES ($1, $2, $3)', [
            migration.version,
            migration.name,
            migration.checksum,
          ]);
          await client.query('COMMIT');
        } catch (error) {
          await client.query('ROLLBACK');
          return unavailable('postgres_migrations', `migration ${String(migration.version)}_${migration.name} failed: ${describe(error)}`);
        }
      }
      return ok(await readApplied(client));
    } finally {
      await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_KEY]);
    }
  } catch (error) {
    return fromDriverError(error);
  } finally {
    client.release();
  }
}

/** Confirms the database is at exactly the schema this code knows, without changing it. */
export async function requireCurrentSchema(
  client: pg.ClientBase,
  migrations: readonly Migration[] = loadMigrations(),
): Promise<Result<readonly AppliedMigration[]>> {
  const exists = await client.query<{ present: boolean }>("SELECT to_regclass('schema_migrations') IS NOT NULL AS present");
  if (exists.rows[0]?.present !== true) return unavailable('postgres_migrations', 'schema is not migrated');
  const applied = await readApplied(client);
  const drift = verifyApplied(applied, migrations);
  if (!drift.ok) return drift;
  if (applied.length !== migrations.length) return unavailable('postgres_migrations', 'schema has pending migrations');
  return ok(applied);
}

async function readApplied(client: pg.ClientBase): Promise<AppliedMigration[]> {
  const result = await client.query<AppliedMigration>('SELECT version, name, checksum FROM schema_migrations ORDER BY version');
  return result.rows;
}

function verifyApplied(applied: readonly AppliedMigration[], migrations: readonly Migration[]): Result<void> {
  const byVersion = new Map(migrations.map((m) => [m.version, m]));
  for (const row of applied) {
    const known = byVersion.get(row.version);
    if (known?.name !== row.name) {
      return unavailable('postgres_migrations', `database has migration ${String(row.version)}_${row.name} that this code does not know`);
    }
    if (known.checksum !== row.checksum) {
      return unavailable('postgres_migrations', `applied migration ${String(row.version)}_${row.name} was modified after it ran`);
    }
  }
  return ok(undefined);
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
