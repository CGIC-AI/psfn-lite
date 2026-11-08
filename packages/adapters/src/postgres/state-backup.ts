/**
 * The structured-state component of a continuity backup. Every durable table
 * is exported from one consistent snapshot as JSONL rows in primary-key
 * order, together with the schema version it came from. The derived
 * transcript projection is left out: it is rebuilt from canonical history.
 *
 * Restore requires an empty database migrated to exactly the same schema,
 * inserts every row in one transaction (identity columns included, then
 * sequences advanced past them), and recomputes the fingerprint inside that
 * transaction: a mismatch rolls back, leaving the target empty and retryable.
 *
 * Every export, fingerprint and import runs with the session TimeZone pinned
 * to UTC, so timestamptz columns render identically whatever zone the source
 * or target server, database or role is configured with.
 */
import { createHash } from 'node:crypto';
import type pg from 'pg';
import { conflict, invalid, isRecord, ok, unavailable, type BackupComponentPort, type BackupFile, type Result } from '../core.ts';
import { transaction, type Queryable } from './database.ts';
import { AUTOMATA_BACKED_UP_TABLES } from './automata-tables.ts';
import { MEMORY_BACKED_UP_TABLES } from './memory-tables.ts';
import { requireCurrentSchema, type AppliedMigration } from './migrations.ts';

interface TableSpec {
  readonly name: string;
  readonly orderBy: string;
  readonly identity?: string;
}

/** Durable tables in foreign-key order. */
export const BACKED_UP_TABLES: readonly TableSpec[] = Object.freeze([
  { name: 'session_heads', orderBy: 'session_id' },
  { name: 'turns', orderBy: 'turn_id' },
  { name: 'sessions', orderBy: 'session_id' },
  { name: 'conversation_heads', orderBy: 'conversation' },
  { name: 'continuity_artifacts', orderBy: 'seq', identity: 'seq' },
  { name: 'focus_records', orderBy: 'focus_id' },
  { name: 'contacts', orderBy: 'contact_id' },
  { name: 'contact_identities', orderBy: 'channel_kind, external_id' },
  { name: 'contact_changes', orderBy: 'seq', identity: 'seq' },
  { name: 'contact_notes', orderBy: 'seq', identity: 'seq' },
  { name: 'core_blocks', orderBy: 'channel_id, name' },
  { name: 'prompt_layers', orderBy: 'layer_id' },
  { name: 'prompt_layer_versions', orderBy: 'layer_id, version' },
  { name: 'persona_versions', orderBy: 'version' },
  { name: 'value_entries', orderBy: 'version' },
  { name: 'north_star_state', orderBy: 'singleton' },
  { name: 'north_star_item_versions', orderBy: 'item_id, version' },
  { name: 'emotion_states', orderBy: 'scope_key' },
  { name: 'emotion_observations', orderBy: 'observation_id' },
  { name: 'emotion_appraisals', orderBy: 'seq', identity: 'seq' },
  { name: 'emotion_self_reports', orderBy: 'seq', identity: 'seq' },
  { name: 'concerns', orderBy: 'concern_id' },
  { name: 'concern_events', orderBy: 'concern_id, revision' },
  { name: 'follow_ups', orderBy: 'follow_up_id' },
  ...MEMORY_BACKED_UP_TABLES,
  ...AUTOMATA_BACKED_UP_TABLES,
]);

const SCHEMA_FILE = 'schema.json';

async function tableRows(db: Queryable, table: TableSpec): Promise<string[]> {
  const found = await db.query<{ row: string }>(`SELECT to_jsonb(t)::text AS row FROM ${table.name} t ORDER BY ${table.orderBy}`);
  return found.rows.map((r) => r.row);
}

/** Pins how timestamptz renders for the rest of the current transaction. */
async function renderInUtc(db: Queryable): Promise<void> {
  await db.query("SET LOCAL TimeZone TO 'UTC'");
}

async function fingerprintOf(db: Queryable, applied: readonly AppliedMigration[]): Promise<string> {
  const hash = createHash('sha256').update(schemaText(applied)).update('\n');
  for (const table of BACKED_UP_TABLES) {
    hash.update(`#${table.name}\n`);
    for (const row of await tableRows(db, table)) hash.update(`${row}\n`);
  }
  return hash.digest('hex');
}

function schemaText(applied: readonly AppliedMigration[]): string {
  return JSON.stringify(applied.map((m) => ({ version: m.version, name: m.name, checksum: m.checksum })));
}

export function createPostgresStateBackupComponent(pool: pg.Pool, name = 'state'): BackupComponentPort {
  const snapshot = <T>(work: (client: pg.PoolClient, applied: readonly AppliedMigration[]) => Promise<Result<T>>) =>
    transaction(
      pool,
      async (client) => {
        await renderInUtc(client);
        const applied = await requireCurrentSchema(client);
        if (!applied.ok) return applied;
        return work(client, applied.value);
      },
      { mode: 'repeatable read only' },
    );

  return {
    name,

    fingerprint: () =>
      snapshot(async (client, applied) => ok(await fingerprintOf(client, applied))),

    isEmpty: () =>
      snapshot(async (client) => {
        for (const table of BACKED_UP_TABLES) {
          const found = await client.query(`SELECT 1 FROM ${table.name} LIMIT 1`);
          if ((found.rowCount ?? 0) > 0) return ok(false);
        }
        return ok(true);
      }),

    exportTo: (store, prefix) =>
      snapshot(async (client, applied) => {
        const files: BackupFile[] = [];
        const schema = await store.write(`${prefix}${SCHEMA_FILE}`, Buffer.from(`${schemaText(applied)}\n`));
        if (!schema.ok) return schema;
        files.push(schema.value);
        for (const table of BACKED_UP_TABLES) {
          const rows = await tableRows(client, table);
          const written = await store.write(`${prefix}${table.name}.jsonl`, Buffer.from(rows.map((r) => `${r}\n`).join('')));
          if (!written.ok) return written;
          files.push(written.value);
        }
        return ok(files);
      }),

    async importFrom(store, files, expectedFingerprint) {
      const prefix = `${name}/`;
      const byPath = new Map(files.map((f) => [f.path, f]));
      const expected = [SCHEMA_FILE, ...BACKED_UP_TABLES.map((t) => `${t.name}.jsonl`)].map((f) => `${prefix}${f}`);
      if (byPath.size !== expected.length || !expected.every((p) => byPath.has(p))) {
        return invalid(`state backup must contain exactly ${expected.join(', ')}`);
      }
      const schemaBytes = await store.read(`${prefix}${SCHEMA_FILE}`);
      if (!schemaBytes.ok) return schemaBytes;
      const tables: { spec: TableSpec; rows: unknown[] }[] = [];
      for (const spec of BACKED_UP_TABLES) {
        const data = await store.read(`${prefix}${spec.name}.jsonl`);
        if (!data.ok) return data;
        const parsed = parseRows(Buffer.from(data.value).toString('utf8'));
        if (!parsed.ok) return parsed;
        tables.push({ spec, rows: parsed.value });
      }
      return transaction(pool, async (client) => {
        await renderInUtc(client);
        const applied = await requireCurrentSchema(client);
        if (!applied.ok) return applied;
        if (Buffer.from(schemaBytes.value).toString('utf8').trim() !== schemaText(applied.value)) {
          return invalid('backup schema version does not match this database; migrate to the same version first');
        }
        for (const { spec, rows } of tables) {
          await client.query(`LOCK TABLE ${spec.name} IN EXCLUSIVE MODE`);
          const existing = await client.query(`SELECT 1 FROM ${spec.name} LIMIT 1`);
          if ((existing.rowCount ?? 0) > 0) return conflict('already_exists', `${spec.name} is not empty; restore only into an empty database`);
          if (rows.length === 0) continue;
          await client.query(
            `INSERT INTO ${spec.name} OVERRIDING SYSTEM VALUE SELECT * FROM jsonb_populate_recordset(NULL::${spec.name}, $1::jsonb)`,
            [JSON.stringify(rows)],
          );
          if (spec.identity !== undefined) {
            await client.query(
              `SELECT setval(pg_get_serial_sequence('${spec.name}', '${spec.identity}'), (SELECT max(${spec.identity}) FROM ${spec.name}))`,
            );
          }
        }
        // Same client, same transaction: sees the uncommitted rows. A mismatch rolls everything back.
        if ((await fingerprintOf(client, applied.value)) !== expectedFingerprint) {
          return unavailable(`backup:${name}`, 'imported rows do not reproduce the backup fingerprint; nothing was committed');
        }
        return ok(undefined);
      });
    },
  };
}

function parseRows(text: string): Result<unknown[]> {
  const rows: unknown[] = [];
  for (const line of text.split('\n')) {
    if (line === '') continue;
    try {
      const row: unknown = JSON.parse(line);
      if (!isRecord(row)) return unavailable('backup_set', 'state row is not an object');
      rows.push(row);
    } catch {
      return unavailable('backup_set', 'state row is not JSON');
    }
  }
  return ok(rows);
}
