/**
 * Postgres implementations of the activity log and the bounded-worker ports:
 * worker runs (compare-and-set, with the lease end kept as a column so
 * recovery finds expired attempts by index) and their effect receipts, whose
 * primary key on run and effect key is the idempotency fence.
 */
import type pg from 'pg';
import {
  conflict,
  ok,
  type ActivityLogPort,
  type ActivityRecord,
  type WorkerEffect,
  type WorkerEffectPort,
  type WorkerRun,
  type WorkerRunPort,
} from '../core.ts';
import { guarded, records } from './database.ts';
import { getOne, insertNew, updateAt, type RecordTable } from './record-rows.ts';

const ACTIVITIES: RecordTable = { table: 'activities', key: 'activity_id', what: 'activity' };
const RUNS: RecordTable = { table: 'worker_runs', key: 'run_id', what: 'worker run' };

export function createPostgresActivityLog(pool: pg.Pool): ActivityLogPort {
  return {
    insert: (record) => insertNew(pool, ACTIVITIES, record.id, record, { revision: record.revision, status: record.status, started_at: record.startedAt }),
    get: (id) => getOne<ActivityRecord>(pool, ACTIVITIES, id),
    list: (limit, after) =>
      guarded(async () => {
        const found = await pool.query(
          `SELECT record FROM activities
            WHERE ($1::timestamptz IS NULL OR (started_at, activity_id) < ($1::timestamptz, $2::text))
            ORDER BY started_at DESC, activity_id DESC
            LIMIT $3`,
          [after?.startedAt ?? null, after?.id ?? null, limit],
        );
        return ok(records<ActivityRecord>(found.rows));
      }),
    update: (next, expectedRevision) => updateAt(pool, ACTIVITIES, next.id, next, expectedRevision, { status: next.status }),
  };
}

const runColumns = (run: WorkerRun) => ({ status: run.status, lease_until: run.lease?.until ?? null });

export function createPostgresWorkerRuns(pool: pg.Pool): WorkerRunPort {
  return {
    insert: (run) =>
      insertNew(pool, RUNS, run.id, run, { revision: run.revision, created_at: run.createdAt, activity_id: run.activityId, ...runColumns(run) }),
    get: (id) => getOne<WorkerRun>(pool, RUNS, id),
    list: ({ statuses, limit, after }) =>
      guarded(async () => {
        const found = await pool.query(
          `SELECT record FROM worker_runs
            WHERE ($1::text[] IS NULL OR status = ANY($1))
              AND ($2::timestamptz IS NULL OR (created_at, run_id) < ($2::timestamptz, $3::text))
            ORDER BY created_at DESC, run_id DESC
            LIMIT $4`,
          [statuses === null ? null : [...statuses], after?.createdAt ?? null, after?.id ?? null, limit],
        );
        return ok(records<WorkerRun>(found.rows));
      }),
    expired: (now, limit) =>
      guarded(async () => {
        const found = await pool.query(
          `SELECT record FROM worker_runs WHERE status = 'running' AND lease_until < $1::timestamptz ORDER BY lease_until, run_id LIMIT $2`,
          [now, limit],
        );
        return ok(records<WorkerRun>(found.rows));
      }),
    update: (next, expectedRevision) => updateAt(pool, RUNS, next.id, next, expectedRevision, runColumns(next)),
  };
}

export function createPostgresWorkerEffects(pool: pg.Pool): WorkerEffectPort {
  return {
    begin: (effect) =>
      guarded<{ readonly effect: WorkerEffect; readonly created: boolean }>(async () => {
        const inserted = await pool.query(
          `INSERT INTO worker_effects (run_id, effect_key, phase, started_at, record) VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (run_id, effect_key) DO NOTHING`,
          [effect.runId, effect.effectKey, effect.phase, effect.startedAt, effect],
        );
        if ((inserted.rowCount ?? 0) > 0) return ok({ effect, created: true });
        const found = await pool.query('SELECT record FROM worker_effects WHERE run_id = $1 AND effect_key = $2', [effect.runId, effect.effectKey]);
        const existing = records<WorkerEffect>(found.rows)[0];
        return existing === undefined ? conflict('stale_revision', `effect ${effect.effectKey} raced a removal`) : ok({ effect: existing, created: false });
      }),
    settle: (next) =>
      guarded(async () => {
        // Only a `started` receipt moves; a settled one is never rewritten.
        const updated = await pool.query(
          `UPDATE worker_effects SET phase = $3, record = $4 WHERE run_id = $1 AND effect_key = $2 AND phase = 'started'`,
          [next.runId, next.effectKey, next.phase, next],
        );
        return (updated.rowCount ?? 0) > 0 ? ok(next) : conflict('stale_revision', `effect ${next.effectKey} is not awaiting an outcome`);
      }),
    list: (runId) =>
      guarded(async () => {
        const found = await pool.query('SELECT record FROM worker_effects WHERE run_id = $1 ORDER BY started_at, effect_key', [runId]);
        return ok(records<WorkerEffect>(found.rows));
      }),
  };
}
