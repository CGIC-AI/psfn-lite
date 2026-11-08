/**
 * Postgres implementations of the core session ports: the turn ledger, the
 * session catalog, continuity notes, focus records and the derived transcript
 * projection. Compare-and-set checks run under row locks inside one
 * transaction, so a stale writer gets a conflict and writes nothing.
 */
import type pg from 'pg';
import {
  conflict,
  invalid,
  notFound,
  ok,
  type ArchiveHead,
  type ContinuityArtifact,
  type ContinuityPort,
  type ConversationHead,
  type FocusPort,
  type FocusRecord,
  type SessionCatalogPort,
  type SessionHead,
  type SessionId,
  type SessionRecord,
  type TranscriptHit,
  type TranscriptProjectionPort,
  type TurnId,
  type TurnLedgerPort,
  type TurnRecord,
} from '../core.ts';
import { guarded, records, transaction, type Queryable } from './database.ts';

export function createPostgresTurnLedger(pool: pg.Pool): TurnLedgerPort {
  const headOf = async (db: Queryable, sessionId: SessionId, lock: boolean): Promise<SessionHead> => {
    const found = await db.query<{ revision: number; open_turn_id: string | null }>(
      `SELECT revision, open_turn_id FROM session_heads WHERE session_id = $1${lock ? ' FOR UPDATE' : ''}`,
      [sessionId],
    );
    const row = found.rows[0];
    return { sessionId, revision: row?.revision ?? 0, openTurnId: (row?.open_turn_id ?? null) as TurnId | null };
  };

  return {
    head: (sessionId) => guarded(async () => ok(await headOf(pool, sessionId, false))),

    get: (turnId) =>
      guarded(async () => {
        const found = await pool.query('SELECT record FROM turns WHERE turn_id = $1', [turnId]);
        const record = records<TurnRecord>(found.rows)[0];
        return record === undefined ? notFound(`turn ${turnId}`) : ok(record);
      }),

    findByIdempotencyKey: (sessionId, key) =>
      guarded(async () => {
        const found = await pool.query('SELECT record FROM turns WHERE session_id = $1 AND idempotency_key = $2', [sessionId, key]);
        return ok(records<TurnRecord>(found.rows)[0] ?? null);
      }),

    open: (record) =>
      transaction(
        pool,
        async (client) => {
          await client.query('INSERT INTO session_heads (session_id, revision) VALUES ($1, 0) ON CONFLICT DO NOTHING', [record.sessionId]);
          const head = await headOf(client, record.sessionId, true);
          if (head.openTurnId !== null) return conflict('turn_already_open', `session ${record.sessionId} has an open turn`);
          if (head.revision !== record.baseRevision) {
            return conflict('stale_revision', 'session head moved', { expectedRevision: record.baseRevision, actualRevision: head.revision });
          }
          await client.query('INSERT INTO turns (turn_id, session_id, idempotency_key, record) VALUES ($1, $2, $3, $4)', [
            record.turnId,
            record.sessionId,
            record.idempotencyKey,
            record,
          ]);
          await client.query('UPDATE session_heads SET open_turn_id = $2 WHERE session_id = $1', [record.sessionId, record.turnId]);
          return ok(record);
        },
        { unique: { turns_pkey: 'already_exists', turns_idempotency_unique: 'idempotency_mismatch' } },
      ),

    settle: (input) =>
      transaction(pool, async (client) => {
        const found = await client.query('SELECT record FROM turns WHERE turn_id = $1 FOR UPDATE', [input.turnId]);
        const record = records<TurnRecord>(found.rows)[0];
        if (record === undefined) return notFound(`turn ${input.turnId}`);
        const head = await headOf(client, record.sessionId, true);
        if (head.revision !== input.expectedRevision || head.openTurnId !== input.turnId) {
          return conflict('stale_revision', 'session head moved', { expectedRevision: input.expectedRevision, actualRevision: head.revision });
        }
        const revision = head.revision + 1;
        const settled: TurnRecord = {
          ...record,
          settlement: { outcome: input.outcome, settledBy: input.settledBy, settledAt: input.settledAt, revision },
        };
        await client.query('UPDATE turns SET record = $2 WHERE turn_id = $1', [input.turnId, settled]);
        await client.query('UPDATE session_heads SET revision = $2, open_turn_id = NULL WHERE session_id = $1', [record.sessionId, revision]);
        return ok(settled);
      }),
  };
}

export function createPostgresSessionCatalog(pool: pg.Pool): SessionCatalogPort {
  return {
    get: (sessionId) =>
      guarded(async () => {
        const found = await pool.query('SELECT record FROM sessions WHERE session_id = $1', [sessionId]);
        const record = records<SessionRecord>(found.rows)[0];
        return record === undefined ? notFound(`session ${sessionId}`) : ok(record);
      }),

    create: (record) =>
      guarded(
        async () => {
          await pool.query('INSERT INTO sessions (session_id, last_activity_at, record) VALUES ($1, $2, $3)', [
            record.sessionId,
            record.lastActivityAt,
            record,
          ]);
          return ok(record);
        },
        { sessions_pkey: 'already_exists' },
      ),

    touch: (sessionId, at) =>
      guarded(async () => {
        const updated = await pool.query(
          `UPDATE sessions
              SET last_activity_at = $2::timestamptz, record = jsonb_set(record, '{lastActivityAt}', to_jsonb($3::text))
            WHERE session_id = $1 AND last_activity_at < $2::timestamptz`,
          // The ISO string is kept verbatim in the record; the column only orders.
          [sessionId, at, at],
        );
        if (updated.rowCount === 0) {
          const exists = await pool.query('SELECT 1 FROM sessions WHERE session_id = $1', [sessionId]);
          if (exists.rowCount === 0) return notFound(`session ${sessionId}`);
        }
        return ok(undefined);
      }),

    list: (limit, cursor) =>
      guarded(async () => {
        if (!Number.isInteger(limit) || limit < 0) return invalid('limit must be a non-negative integer');
        const found =
          cursor === null
            ? await pool.query('SELECT record FROM sessions ORDER BY last_activity_at DESC, session_id DESC LIMIT $1', [limit])
            : await pool.query(
                `SELECT record FROM sessions
                  WHERE (last_activity_at, session_id) < ($1::timestamptz, $2)
                  ORDER BY last_activity_at DESC, session_id DESC LIMIT $3`,
                [cursor.lastActivityAt, cursor.sessionId, limit],
              );
        return ok(records<SessionRecord>(found.rows));
      }),

    active: (conversation) =>
      guarded(async () => {
        const found = await pool.query<{ session_id: string; revision: number }>(
          'SELECT session_id, revision FROM conversation_heads WHERE conversation = $1',
          [conversation],
        );
        const row = found.rows[0];
        return ok(row === undefined ? null : { conversation, sessionId: row.session_id as SessionId, revision: row.revision });
      }),

    setActive: (conversation, sessionId, expectedRevision) =>
      guarded(async () => {
        const written =
          expectedRevision === 0
            ? await pool.query(
                'INSERT INTO conversation_heads (conversation, session_id, revision) VALUES ($1, $2, 1) ON CONFLICT DO NOTHING RETURNING revision',
                [conversation, sessionId],
              )
            : await pool.query(
                'UPDATE conversation_heads SET session_id = $2, revision = revision + 1 WHERE conversation = $1 AND revision = $3 RETURNING revision',
                [conversation, sessionId, expectedRevision],
              );
        if (written.rowCount === 0) return conflict('stale_revision', `conversation ${conversation} head moved`, { expectedRevision });
        const head: ConversationHead = { conversation, sessionId, revision: expectedRevision + 1 };
        return ok(head);
      }),
  };
}

export function createPostgresContinuity(pool: pg.Pool): ContinuityPort {
  return {
    append: (artifact) =>
      guarded(
        async () => {
          await pool.query('INSERT INTO continuity_artifacts (id, session_id, record) VALUES ($1, $2, $3)', [artifact.id, artifact.sessionId, artifact]);
          return ok(artifact);
        },
        { continuity_artifacts_id_unique: 'already_exists' },
      ),

    list: (sessionIds, limit) =>
      guarded(async () => {
        const found = await pool.query('SELECT record FROM continuity_artifacts WHERE session_id = ANY($1) ORDER BY seq DESC LIMIT $2', [
          sessionIds,
          limit,
        ]);
        return ok(records<ContinuityArtifact>(found.rows));
      }),
  };
}

export function createPostgresFocus(pool: pg.Pool): FocusPort {
  return {
    open: (record) =>
      guarded(
        async () => {
          if (record.completion !== null) return invalid('a focus opens without a completion');
          await pool.query('INSERT INTO focus_records (focus_id, session_id, completed, record) VALUES ($1, $2, false, $3)', [
            record.focusId,
            record.sessionId,
            record,
          ]);
          return ok(record);
        },
        { focus_records_pkey: 'already_exists', focus_records_one_open: 'already_exists' },
      ),

    openFor: (sessionId) =>
      guarded(async () => {
        const found = await pool.query('SELECT record FROM focus_records WHERE session_id = $1 AND NOT completed', [sessionId]);
        return ok(records<FocusRecord>(found.rows)[0] ?? null);
      }),

    complete: (focusId, completion) =>
      guarded(async () => {
        const updated = await pool.query(
          `UPDATE focus_records SET completed = true, record = jsonb_set(record, '{completion}', $2::jsonb)
            WHERE focus_id = $1 AND NOT completed RETURNING record`,
          [focusId, JSON.stringify(completion)],
        );
        const record = records<FocusRecord>(updated.rows)[0];
        if (record !== undefined) return ok(record);
        const exists = await pool.query('SELECT 1 FROM focus_records WHERE focus_id = $1', [focusId]);
        return exists.rowCount === 0 ? notFound(`focus ${focusId}`) : conflict('stale_revision', `focus ${focusId} is already complete`);
      }),
  };
}

export function createPostgresTranscriptProjection(pool: pg.Pool): TranscriptProjectionPort {
  const watermarkOf = async (db: Queryable, sessionId: SessionId, lock: boolean): Promise<ArchiveHead> => {
    const found = await db.query<{ count: number; hash: string | null }>(
      `SELECT count, hash FROM transcript_watermarks WHERE session_id = $1${lock ? ' FOR UPDATE' : ''}`,
      [sessionId],
    );
    const row = found.rows[0];
    return { sessionId, count: row?.count ?? 0, hash: row?.hash ?? null };
  };

  return {
    watermark: (sessionId) => guarded(async () => ok(await watermarkOf(pool, sessionId, false))),

    project: (sessionId, entries, expected) =>
      transaction(pool, async (client) => {
        await client.query('INSERT INTO transcript_watermarks (session_id, count, hash) VALUES ($1, 0, NULL) ON CONFLICT DO NOTHING', [sessionId]);
        const current = await watermarkOf(client, sessionId, true);
        if (current.count !== expected.count || current.hash !== expected.hash) {
          return conflict('stale_revision', `projection of ${sessionId} moved`, { expectedRevision: expected.count, actualRevision: current.count });
        }
        let head = current;
        for (const archived of entries) {
          if (archived.entry.sessionId !== sessionId || archived.seq !== head.count + 1) {
            return invalid(`projected entries must continue ${sessionId} at seq ${String(head.count + 1)}`);
          }
          await client.query('INSERT INTO transcript_entries (session_id, seq, hash, entry) VALUES ($1, $2, $3, $4)', [
            sessionId,
            archived.seq,
            archived.hash,
            archived.entry,
          ]);
          head = { sessionId, count: archived.seq, hash: archived.hash };
        }
        await client.query('UPDATE transcript_watermarks SET count = $2, hash = $3 WHERE session_id = $1', [sessionId, head.count, head.hash]);
        return ok(head);
      }),

    reset: (sessionId) =>
      transaction(pool, async (client) => {
        await client.query('DELETE FROM transcript_entries WHERE session_id = $1', [sessionId]);
        await client.query('DELETE FROM transcript_watermarks WHERE session_id = $1', [sessionId]);
        return ok(undefined);
      }),

    search: (query, sessionIds, limit) =>
      guarded(async () => {
        const found = await pool.query<{ seq: number; entry: TranscriptHit['entry']; rank: number }>(
          `SELECT seq, entry, ts_rank(search, q)::float8 AS rank
             FROM transcript_entries, plainto_tsquery('simple'::regconfig, $1) AS q
            WHERE session_id = ANY($2) AND search @@ q
            ORDER BY rank DESC, session_id, seq
            LIMIT $3`,
          [query, sessionIds, limit],
        );
        return ok(found.rows.map((row) => ({ seq: row.seq, entry: row.entry, rank: row.rank })));
      }),
  };
}
