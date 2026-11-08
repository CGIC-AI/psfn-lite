/**
 * Postgres access shared by the stores: a pool, transactions that roll back
 * on any failure result, and translation of driver errors into core results.
 * Connection strings carry credentials, so they are never logged or included
 * in an error.
 */
import pg from 'pg';
import { conflict, unavailable, type ConflictReason, type Result } from '../core.ts';

export type Queryable = Pick<pg.PoolClient, 'query'>;

export interface PoolOptions {
  readonly connectionString: string;
  /** Receives errors raised by idle pooled connections. Required so they are never unhandled. */
  readonly onIdleError: (error: Error) => void;
  readonly max?: number;
}

export function createPostgresPool(options: PoolOptions): pg.Pool {
  const pool = new pg.Pool({ connectionString: options.connectionString, max: options.max ?? 10 });
  pool.on('error', options.onIdleError);
  return pool;
}

const CAPABILITY = 'postgres';

/** Constraint name → conflict reason for unique violations a store expects. */
export type UniqueConflicts = Readonly<Record<string, ConflictReason>>;

function driverCode(error: unknown): string | undefined {
  return error instanceof Error && 'code' in error && typeof error.code === 'string' ? error.code : undefined;
}

function constraintOf(error: unknown): string | undefined {
  return error instanceof Error && 'constraint' in error && typeof error.constraint === 'string' ? error.constraint : undefined;
}

/** Maps a thrown driver error to a result: expected unique violations become conflicts, the rest unavailable. */
export function fromDriverError(error: unknown, unique: UniqueConflicts = {}): Result<never> {
  const code = driverCode(error);
  if (code === '23505') {
    const constraint = constraintOf(error) ?? 'unique';
    return conflict(unique[constraint] ?? 'already_exists', `unique constraint ${constraint} rejected the write`);
  }
  if (code === '40001' || code === '40P01') return conflict('stale_revision', 'concurrent write; retry');
  const message = error instanceof Error ? error.message : String(error);
  return unavailable(CAPABILITY, code === undefined ? message : `${code}: ${message}`);
}

/** Runs a read or single statement, translating driver errors. */
export async function guarded<T>(run: () => Promise<Result<T>>, unique?: UniqueConflicts): Promise<Result<T>> {
  try {
    return await run();
  } catch (error) {
    return fromDriverError(error, unique);
  }
}

/** Runs `work` in one transaction; commits only when it returns ok, otherwise rolls back. */
export async function transaction<T>(
  pool: pg.Pool,
  work: (client: pg.PoolClient) => Promise<Result<T>>,
  options: { readonly unique?: UniqueConflicts; readonly mode?: 'read write' | 'repeatable read only' } = {},
): Promise<Result<T>> {
  let client: pg.PoolClient;
  try {
    client = await pool.connect();
  } catch (error) {
    return fromDriverError(error);
  }
  let broken = false;
  try {
    await client.query(options.mode === 'repeatable read only' ? 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY' : 'BEGIN');
    const result = await work(client);
    await client.query(result.ok ? 'COMMIT' : 'ROLLBACK');
    return result;
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {
      broken = true;
    }
    return fromDriverError(error, options.unique);
  } finally {
    client.release(broken);
  }
}

export interface Row {
  readonly [column: string]: unknown;
}

/** The JSONB `record` column of each row, typed by the caller's core contract. */
export function records<T>(rows: readonly Row[], column = 'record'): T[] {
  return rows.map((row) => row[column] as T);
}
