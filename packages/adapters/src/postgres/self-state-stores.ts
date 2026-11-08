/**
 * Postgres implementations of the self-state ports: per-scope emotion state
 * (compare-and-set, with its observation recorded in the same transaction),
 * the appraisal log, self-reports, concerns with their event history, and
 * follow-ups. Primary keys and unique constraints carry the idempotency the
 * ports promise.
 */
import type pg from 'pg';
import {
  conflict,
  invalid,
  notFound,
  ok,
  OPEN_CONCERN_STATUSES,
  type ActiveConcern,
  type AppraisalEntry,
  type AppraisalLogPort,
  type ConcernEvent,
  type ConcernPort,
  type EmotionObservationRecord,
  type EmotionSelfReport,
  type EmotionStatePort,
  type EmotionStateRecord,
  type FollowUpPort,
  type PendingFollowUp,
  type SelfReportPort,
} from '../core.ts';
import { guarded, records, transaction } from './database.ts';

export interface SelfStateStores {
  readonly emotionStates: EmotionStatePort;
  readonly appraisals: AppraisalLogPort;
  readonly selfReports: SelfReportPort;
  readonly concerns: ConcernPort;
  readonly followUps: FollowUpPort;
}

export function createPostgresSelfStateStores(pool: pg.Pool): SelfStateStores {
  return {
    emotionStates: emotionStates(pool),
    appraisals: appraisals(pool),
    selfReports: selfReports(pool),
    concerns: concerns(pool),
    followUps: followUps(pool),
  };
}

function emotionStates(pool: pg.Pool): EmotionStatePort {
  return {
    get: (key) =>
      guarded(async () => {
        const found = await pool.query('SELECT record FROM emotion_states WHERE scope_key = $1', [key]);
        return ok(records<EmotionStateRecord>(found.rows)[0] ?? null);
      }),

    observation: (id) =>
      guarded(async () => {
        const found = await pool.query('SELECT record FROM emotion_observations WHERE observation_id = $1', [id]);
        return ok(records<EmotionObservationRecord>(found.rows)[0] ?? null);
      }),

    commit: ({ next, expectedRevision, observation }) =>
      transaction(
        pool,
        async (client) => {
          if (next.revision !== expectedRevision + 1) return invalid('emotion state revision must follow the expected one');
          if (observation !== null && observation.scopeKey !== next.key) return invalid('observation belongs to another scope');
          const current = await client.query<{ revision: number }>('SELECT revision FROM emotion_states WHERE scope_key = $1 FOR UPDATE', [next.key]);
          const actual = current.rows[0]?.revision ?? 0;
          if (actual !== expectedRevision) {
            return conflict('stale_revision', `emotion state ${next.key} moved`, { expectedRevision, actualRevision: actual });
          }
          if (expectedRevision === 0) {
            await client.query('INSERT INTO emotion_states (scope_key, revision, record) VALUES ($1, $2, $3)', [next.key, next.revision, next]);
          } else {
            await client.query('UPDATE emotion_states SET revision = $2, record = $3 WHERE scope_key = $1', [next.key, next.revision, next]);
          }
          if (observation !== null) {
            await client.query('INSERT INTO emotion_observations (observation_id, scope_key, record) VALUES ($1, $2, $3)', [
              observation.id,
              observation.scopeKey,
              observation,
            ]);
          }
          return ok(next);
        },
        // A racing first write loses on the state key (a stale revision); a recorded observation is already applied.
        { unique: { emotion_states_pkey: 'stale_revision', emotion_observations_pkey: 'already_exists' } },
      ),
  };
}

function appraisals(pool: pg.Pool): AppraisalLogPort {
  return {
    append: (entry) =>
      guarded(async () => {
        const inserted = await pool.query(
          'INSERT INTO emotion_appraisals (appraisal_id, record) VALUES ($1, $2) ON CONFLICT (appraisal_id) DO NOTHING RETURNING record',
          [entry.id, entry],
        );
        if ((inserted.rowCount ?? 0) > 0) return ok(entry);
        const same = await pool.query<{ same: boolean; record: AppraisalEntry }>(
          'SELECT record = $2::jsonb AS same, record FROM emotion_appraisals WHERE appraisal_id = $1',
          [entry.id, JSON.stringify(entry)],
        );
        const row = same.rows[0];
        if (row === undefined) return conflict('stale_revision', `appraisal ${entry.id} raced a removal`);
        return row.same ? ok(row.record) : conflict('entry_mismatch', `appraisal ${entry.id} already exists with different content`);
      }),

    get: (id) =>
      guarded(async () => {
        const found = await pool.query('SELECT record FROM emotion_appraisals WHERE appraisal_id = $1', [id]);
        return ok(records<AppraisalEntry>(found.rows)[0] ?? null);
      }),

    recent: ({ limit, before }) =>
      guarded(async () => {
        if (before === null) {
          const found = await pool.query('SELECT record FROM emotion_appraisals ORDER BY seq DESC LIMIT $1', [limit]);
          return ok(records<AppraisalEntry>(found.rows));
        }
        const cursor = await pool.query<{ seq: string }>('SELECT seq FROM emotion_appraisals WHERE appraisal_id = $1', [before]);
        const seq = cursor.rows[0]?.seq;
        if (seq === undefined) return notFound(`appraisal ${before}`);
        const found = await pool.query('SELECT record FROM emotion_appraisals WHERE seq < $1 ORDER BY seq DESC LIMIT $2', [seq, limit]);
        return ok(records<AppraisalEntry>(found.rows));
      }),
  };
}

function selfReports(pool: pg.Pool): SelfReportPort {
  return {
    append: (report) =>
      guarded(async () => {
        await pool.query('INSERT INTO emotion_self_reports (report_id, scope_key, record) VALUES ($1, $2, $3)', [report.id, report.scopeKey, report]);
        return ok(report);
      }),

    get: (id) =>
      guarded(async () => {
        const found = await pool.query('SELECT record FROM emotion_self_reports WHERE report_id = $1', [id]);
        const record = records<EmotionSelfReport>(found.rows)[0];
        return record === undefined ? notFound(`self-report ${id}`) : ok(record);
      }),

    recent: (scopeKey, limit) =>
      guarded(async () => {
        const found = await pool.query('SELECT record FROM emotion_self_reports WHERE scope_key = $1 ORDER BY seq DESC LIMIT $2', [scopeKey, limit]);
        return ok(records<EmotionSelfReport>(found.rows));
      }),
  };
}

function concerns(pool: pg.Pool): ConcernPort {
  const insertEvent = (client: pg.PoolClient, event: ConcernEvent) =>
    client.query('INSERT INTO concern_events (concern_id, revision, record) VALUES ($1, $2, $3)', [event.concernId, event.revision, event]);

  return {
    get: (id) =>
      guarded(async () => {
        const found = await pool.query('SELECT record FROM concerns WHERE concern_id = $1', [id]);
        const record = records<ActiveConcern>(found.rows)[0];
        return record === undefined ? notFound(`concern ${id}`) : ok(record);
      }),

    list: ({ openOnly, limit, after }) =>
      guarded(async () => {
        const found = await pool.query(
          `SELECT record FROM concerns
            WHERE ($1::text[] IS NULL OR status = ANY($1))
              AND ($2::timestamptz IS NULL OR (updated_at, concern_id) < ($2::timestamptz, $3::text))
            ORDER BY updated_at DESC, concern_id DESC
            LIMIT $4`,
          [openOnly ? [...OPEN_CONCERN_STATUSES] : null, after?.updatedAt ?? null, after?.id ?? null, limit],
        );
        return ok(records<ActiveConcern>(found.rows));
      }),

    create: (concern, event) =>
      transaction(pool, async (client) => {
        if (concern.revision !== 1 || event.revision !== 1 || event.concernId !== concern.id) return invalid('a new concern starts at revision 1 with its event');
        await client.query('INSERT INTO concerns (concern_id, revision, status, updated_at, record) VALUES ($1, 1, $2, $3, $4)', [
          concern.id,
          concern.status,
          concern.updatedAt,
          concern,
        ]);
        await insertEvent(client, event);
        return ok(concern);
      }),

    update: (next, expectedRevision, event) =>
      transaction(pool, async (client) => {
        if (next.revision !== expectedRevision + 1 || event.revision !== next.revision || event.concernId !== next.id) {
          return invalid('a concern update must advance one revision with its event');
        }
        const current = await client.query<{ revision: number }>('SELECT revision FROM concerns WHERE concern_id = $1 FOR UPDATE', [next.id]);
        const actual = current.rows[0]?.revision;
        if (actual === undefined) return notFound(`concern ${next.id}`);
        if (actual !== expectedRevision) return conflict('stale_revision', `concern ${next.id} moved`, { expectedRevision, actualRevision: actual });
        await client.query('UPDATE concerns SET revision = $2, status = $3, updated_at = $4, record = $5 WHERE concern_id = $1', [
          next.id,
          next.revision,
          next.status,
          next.updatedAt,
          next,
        ]);
        await insertEvent(client, event);
        return ok(next);
      }),

    events: (id, limit) =>
      guarded(async () => {
        const found = await pool.query('SELECT record FROM concern_events WHERE concern_id = $1 ORDER BY revision LIMIT $2', [id, limit]);
        return ok(records<ConcernEvent>(found.rows));
      }),
  };
}

function followUps(pool: pg.Pool): FollowUpPort {
  return {
    create: (followUp) =>
      guarded<{ readonly followUp: PendingFollowUp; readonly created: boolean }>(async () => {
        if (followUp.revision !== 1) return invalid('a new follow-up starts at revision 1');
        const inserted = await pool.query(
          'INSERT INTO follow_ups (follow_up_id, revision, state, due_at, record) VALUES ($1, 1, $2, $3, $4) ON CONFLICT (follow_up_id) DO NOTHING',
          [followUp.id, followUp.state, followUp.dueAt, followUp],
        );
        if ((inserted.rowCount ?? 0) > 0) return ok({ followUp, created: true });
        const found = await pool.query('SELECT record FROM follow_ups WHERE follow_up_id = $1', [followUp.id]);
        const existing = records<PendingFollowUp>(found.rows)[0];
        return existing === undefined ? conflict('stale_revision', `follow-up ${followUp.id} raced a removal`) : ok({ followUp: existing, created: false });
      }),

    get: (id) =>
      guarded(async () => {
        const found = await pool.query('SELECT record FROM follow_ups WHERE follow_up_id = $1', [id]);
        const record = records<PendingFollowUp>(found.rows)[0];
        return record === undefined ? notFound(`follow-up ${id}`) : ok(record);
      }),

    list: ({ state, dueAtOrBefore, limit, after }) =>
      guarded(async () => {
        const found = await pool.query(
          `SELECT record FROM follow_ups
            WHERE ($1::text IS NULL OR state = $1)
              AND ($2::timestamptz IS NULL OR due_at <= $2)
              AND ($3::timestamptz IS NULL OR (due_at, follow_up_id) > ($3::timestamptz, $4::text))
            ORDER BY due_at, follow_up_id
            LIMIT $5`,
          [state, dueAtOrBefore, after?.dueAt ?? null, after?.id ?? null, limit],
        );
        return ok(records<PendingFollowUp>(found.rows));
      }),

    update: (next, expectedRevision) =>
      transaction(pool, async (client) => {
        if (next.revision !== expectedRevision + 1) return invalid('a follow-up update must advance one revision');
        const current = await client.query<{ revision: number }>('SELECT revision FROM follow_ups WHERE follow_up_id = $1 FOR UPDATE', [next.id]);
        const actual = current.rows[0]?.revision;
        if (actual === undefined) return notFound(`follow-up ${next.id}`);
        if (actual !== expectedRevision) return conflict('stale_revision', `follow-up ${next.id} moved`, { expectedRevision, actualRevision: actual });
        await client.query('UPDATE follow_ups SET revision = $2, state = $3, record = $4 WHERE follow_up_id = $1', [next.id, next.revision, next.state, next]);
        return ok(next);
      }),
  };
}
