/**
 * Postgres implementations of the core journal ports: journal notes with
 * runtime-stamped provenance, append-only reflection records, and the letter
 * bin with its lived history of events.
 */
import type pg from 'pg';
import {
  conflict,
  notFound,
  ok,
  sourceKeys,
  type JournalNote,
  type JournalNotePort,
  type Letter,
  type LetterEvent,
  type LetterPort,
  type ReflectionEntry,
  type ReflectionPort,
} from '../core.ts';
import { guarded, records, transaction, type Queryable } from './database.ts';
import { SqlParams, anyTokenQuery, journalAccessSql } from './memory-sql.ts';

function noteColumns(note: JournalNote): unknown[] {
  const source = note.provenance.scope === 'conversation' ? sourceKeys(note.provenance.source) : null;
  return [note.path, note.provenance.scope, source?.conversation ?? null, source?.sourceClass ?? null, note.revision, note];
}

export function createPostgresJournalNotes(pool: pg.Pool): JournalNotePort {
  return {
    get: (path) =>
      guarded(async () => {
        const found = await pool.query('SELECT record FROM journal_notes WHERE path = $1', [path]);
        const record = records<JournalNote>(found.rows)[0];
        return record === undefined ? notFound(`journal note ${path}`) : ok(record);
      }),

    list: (access, limit) =>
      guarded(async () => {
        const params = new SqlParams();
        const where = journalAccessSql(access, params);
        const found = await pool.query(`SELECT j.record FROM journal_notes j WHERE ${where} ORDER BY j.path LIMIT ${params.add(limit)}`, params.values);
        return ok(records<JournalNote>(found.rows));
      }),

    search: (access, query, limit) =>
      guarded(async () => {
        const tsquery = anyTokenQuery(query);
        if (tsquery === null) return ok([]);
        const params = new SqlParams();
        const q = params.add(tsquery);
        const where = journalAccessSql(access, params);
        const found = await pool.query(
          `SELECT j.record FROM journal_notes j, websearch_to_tsquery('simple'::regconfig, ${q}) q
            WHERE to_tsvector('simple'::regconfig, j.record ->> 'body') @@ q AND ${where}
            ORDER BY ts_rank(to_tsvector('simple'::regconfig, j.record ->> 'body'), q) DESC, j.path LIMIT ${params.add(limit)}`,
          params.values,
        );
        return ok(records<JournalNote>(found.rows));
      }),

    put: (note, expectedRevision) =>
      guarded(
        async () => {
          if (expectedRevision === null) {
            await pool.query('INSERT INTO journal_notes (path, scope, source_conversation, source_class, revision, record) VALUES ($1, $2, $3, $4, $5, $6)', noteColumns(note));
            return ok(note);
          }
          const saved = await pool.query(
            'UPDATE journal_notes SET scope = $2, source_conversation = $3, source_class = $4, revision = $5, record = $6 WHERE path = $1 AND revision = $7',
            [...noteColumns(note), expectedRevision],
          );
          return (saved.rowCount ?? 0) === 1 ? ok(note) : conflict('stale_revision', `journal note ${note.path} moved`);
        },
        { journal_notes_pkey: 'stale_revision' },
      ),
  };
}

export function createPostgresReflections(pool: pg.Pool): ReflectionPort {
  return {
    append: (entry) =>
      guarded(async () => {
        const inserted = await pool.query('INSERT INTO reflections (reflection_id, record) VALUES ($1, $2) ON CONFLICT (reflection_id) DO NOTHING', [entry.id, entry]);
        if ((inserted.rowCount ?? 0) === 1) return ok(entry);
        const found = await pool.query('SELECT record FROM reflections WHERE reflection_id = $1', [entry.id]);
        const existing = records<ReflectionEntry>(found.rows)[0];
        if (existing === undefined) return notFound(`reflection ${entry.id}`);
        return existing.text === entry.text && existing.kind === entry.kind ? ok(existing) : conflict('idempotency_mismatch', `reflection id ${entry.id} was used for another record`);
      }),

    list: (limit) =>
      guarded(async () => {
        const found = await pool.query('SELECT record FROM reflections ORDER BY seq DESC LIMIT $1', [limit]);
        return ok(records<ReflectionEntry>(found.rows));
      }),

    get: (id) =>
      guarded(async () => {
        const found = await pool.query('SELECT record FROM reflections WHERE reflection_id = $1', [id]);
        const record = records<ReflectionEntry>(found.rows)[0];
        return record === undefined ? notFound(`reflection ${id}`) : ok(record);
      }),
  };
}

async function insertLetterEvent(db: Queryable, event: LetterEvent): Promise<void> {
  await db.query('INSERT INTO letter_events (letter_id, record) VALUES ($1, $2)', [event.letterId, event]);
}

export function createPostgresLetters(pool: pg.Pool): LetterPort {
  return {
    create: (letter, event) =>
      transaction(pool, async (client) => {
        const inserted = await client.query(
          'INSERT INTO letters (letter_id, author, recipient, state, revision, record) VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (letter_id) DO NOTHING',
          [letter.id, letter.author, letter.recipient, letter.state, letter.revision, letter],
        );
        if ((inserted.rowCount ?? 0) === 1) {
          await insertLetterEvent(client, event);
          return ok({ letter, created: true as boolean });
        }
        const found = await client.query('SELECT record FROM letters WHERE letter_id = $1', [letter.id]);
        const existing = records<Letter>(found.rows)[0];
        return existing === undefined ? notFound(`letter ${letter.id}`) : ok({ letter: existing, created: false });
      }),

    get: (id) =>
      guarded(async () => {
        const found = await pool.query('SELECT record FROM letters WHERE letter_id = $1', [id]);
        const record = records<Letter>(found.rows)[0];
        return record === undefined ? notFound(`letter ${id}`) : ok(record);
      }),

    list: (filter) =>
      guarded(async () => {
        const found = await pool.query(
          `SELECT record FROM letters
            WHERE ($1::text IS NULL OR author = $1) AND ($2::text IS NULL OR recipient = $2) AND state = ANY($3::text[])
            ORDER BY seq LIMIT $4`,
          [filter.author, filter.recipient, filter.states, filter.limit],
        );
        return ok(records<Letter>(found.rows));
      }),

    record: (next, expectedRevision, event) =>
      transaction(pool, async (client) => {
        const found = await client.query('SELECT record FROM letters WHERE letter_id = $1 FOR UPDATE', [next.id]);
        const current = records<Letter>(found.rows)[0];
        if (current === undefined) return notFound(`letter ${next.id}`);
        if (current.revision !== expectedRevision) {
          return conflict('stale_revision', `letter ${next.id} moved`, { expectedRevision, actualRevision: current.revision });
        }
        await client.query('UPDATE letters SET author = $2, recipient = $3, state = $4, revision = $5, record = $6 WHERE letter_id = $1', [
          next.id,
          next.author,
          next.recipient,
          next.state,
          next.revision,
          next,
        ]);
        await insertLetterEvent(client, event);
        return ok(next);
      }),

    events: (letterId, limit) =>
      guarded(async () => {
        const found = await pool.query(
          'SELECT record FROM (SELECT seq, record FROM letter_events WHERE letter_id = $1 ORDER BY seq DESC LIMIT $2) recent ORDER BY seq',
          [letterId, limit],
        );
        return ok(records<LetterEvent>(found.rows));
      }),
  };
}
