/**
 * The two writes every JSONB-record table in the activity and scheduler
 * stores shares: an idempotent insert that reports whether it created the row,
 * and a compare-and-set update that advances exactly one revision. Table and
 * column names come from the store modules, never from callers.
 */
import type pg from 'pg';
import { conflict, invalid, notFound, ok, type Result } from '../core.ts';
import { guarded, records } from './database.ts';

export interface RecordTable {
  readonly table: string;
  readonly key: string;
  /** Names the record in errors, e.g. `worker run`. */
  readonly what: string;
}

/** Column → value for the non-key columns a write keeps in step with the record. */
export type Columns = Readonly<Record<string, unknown>>;

/** Inserts the record; an existing key returns the stored record with `created: false`. */
export function insertOnce<T>(pool: pg.Pool, spec: RecordTable, id: string, record: T, columns: Columns): Promise<Result<{ readonly record: T; readonly created: boolean }>> {
  return guarded<{ readonly record: T; readonly created: boolean }>(async () => {
    const names = Object.keys(columns);
    const placeholders = names.map((_, i) => `$${String(i + 3)}`);
    const inserted = await pool.query(
      `INSERT INTO ${spec.table} (${spec.key}, record${names.map((n) => `, ${n}`).join('')}) VALUES ($1, $2${placeholders.map((p) => `, ${p}`).join('')})
       ON CONFLICT (${spec.key}) DO NOTHING`,
      [id, record, ...Object.values(columns)],
    );
    if ((inserted.rowCount ?? 0) > 0) return ok({ record, created: true });
    const found = await pool.query(`SELECT record FROM ${spec.table} WHERE ${spec.key} = $1`, [id]);
    const existing = records<T>(found.rows)[0];
    return existing === undefined ? conflict('stale_revision', `${spec.what} ${id} raced a removal`) : ok({ record: existing, created: false });
  });
}

/** Inserts the record; an existing key is an `already_exists` conflict. */
export async function insertNew<T>(pool: pg.Pool, spec: RecordTable, id: string, record: T, columns: Columns): Promise<Result<T>> {
  const inserted = await insertOnce(pool, spec, id, record, columns);
  if (!inserted.ok) return inserted;
  return inserted.value.created ? ok(record) : conflict('already_exists', `${spec.what} ${id} already exists`);
}

/** Replaces the record only if its stored revision is `expectedRevision` and `next` advances it by one. */
export function updateAt<T extends { readonly revision: number }>(
  pool: pg.Pool,
  spec: RecordTable,
  id: string,
  next: T,
  expectedRevision: number,
  columns: Columns,
): Promise<Result<T>> {
  return guarded(async () => {
    if (next.revision !== expectedRevision + 1) return invalid(`a ${spec.what} update must advance one revision`);
    const names = Object.keys(columns);
    const sets = names.map((n, i) => `, ${n} = $${String(i + 5)}`).join('');
    const updated = await pool.query(`UPDATE ${spec.table} SET revision = $2, record = $3${sets} WHERE ${spec.key} = $1 AND revision = $4`, [
      id,
      next.revision,
      next,
      expectedRevision,
      ...Object.values(columns),
    ]);
    if ((updated.rowCount ?? 0) > 0) return ok(next);
    const current = await pool.query<{ revision: number }>(`SELECT revision FROM ${spec.table} WHERE ${spec.key} = $1`, [id]);
    const actual = current.rows[0]?.revision;
    if (actual === undefined) return notFound(`${spec.what} ${id}`);
    return conflict('stale_revision', `${spec.what} ${id} moved`, { expectedRevision, actualRevision: actual });
  });
}

/** One record by key, or not_found. */
export function getOne<T>(pool: pg.Pool, spec: RecordTable, id: string): Promise<Result<T>> {
  return guarded(async () => {
    const found = await pool.query(`SELECT record FROM ${spec.table} WHERE ${spec.key} = $1`, [id]);
    const record = records<T>(found.rows)[0];
    return record === undefined ? notFound(`${spec.what} ${id}`) : ok(record);
  });
}
