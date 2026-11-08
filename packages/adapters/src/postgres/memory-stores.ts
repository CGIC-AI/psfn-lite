/**
 * Postgres implementations of the core memory ports: typed memories with
 * their receipts, links, events and embeddings; deletion proposals; the
 * scratchpad; and per-session processing cursors. Reads that take a
 * `SourceAccess` apply it in SQL before ordering and limits. Writes that
 * compare-and-set lock their rows inside one transaction.
 */
import type pg from 'pg';
import {
  conflict,
  notFound,
  ok,
  sourceKeys,
  subjectKey,
  type IdempotencyKey,
  type MemoryCandidate,
  type MemoryDeletionPort,
  type MemoryDeletionProposal,
  type MemoryEvent,
  type MemoryHit,
  type MemoryKind,
  type MemoryLink,
  type MemoryRecord,
  type MemoryStorePort,
  type MemoryWriteReceipt,
  type Result,
  type SourceAccess,
  type EmbeddingSpace,
  type ScratchpadNote,
  type ScratchpadPort,
  type SessionCursorPort,
} from '../core.ts';
import { guarded, records, transaction, type Queryable, type Row } from './database.ts';
import { SqlParams, anyTokenQuery, iterativeScan, memoryAccessSql, parseVector, putVector, spaceSql, vectorLiteral } from './memory-sql.ts';

const INSERT_CONFLICTS = { memory_write_receipts_pkey: 'idempotency_mismatch', memories_pkey: 'already_exists' } as const;

function memoryColumns(record: MemoryRecord): unknown[] {
  const { conversation, sourceClass } = sourceKeys(record.provenance.source);
  const subject = record.subject;
  return [
    record.id,
    record.kind,
    record.state,
    record.sensitivity,
    conversation,
    sourceClass,
    subjectKey(subject),
    subject.kind,
    subject.kind === 'contacts' ? subject.contactIds : [],
    subject.kind === 'room' ? subject.channelId : null,
    record.revision,
    record,
  ];
}

async function insertMemory(db: Queryable, record: MemoryRecord): Promise<void> {
  await db.query(
    `INSERT INTO memories (memory_id, kind, state, sensitivity, source_conversation, source_class, subject_key, subject_kind, subject_contacts, subject_channel, revision, record)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
    memoryColumns(record),
  );
}

async function replaceMemory(db: Queryable, record: MemoryRecord): Promise<void> {
  await db.query(
    `UPDATE memories SET kind = $2, state = $3, sensitivity = $4, source_conversation = $5, source_class = $6, subject_key = $7,
            subject_kind = $8, subject_contacts = $9, subject_channel = $10, revision = $11, record = $12
      WHERE memory_id = $1`,
    memoryColumns(record),
  );
}

async function insertEvent(db: Queryable, event: MemoryEvent): Promise<void> {
  await db.query('INSERT INTO memory_events (memory_id, record) VALUES ($1, $2)', [event.memoryId, event]);
}

async function insertReceipt(db: Queryable, receipt: MemoryWriteReceipt): Promise<void> {
  await db.query('INSERT INTO memory_write_receipts (idempotency_key, memory_id, record) VALUES ($1, $2, $3)', [receipt.idempotencyKey, receipt.memoryId, receipt]);
}

async function lockedMemory(db: Queryable, id: string): Promise<MemoryRecord | undefined> {
  const found = await db.query('SELECT record FROM memories WHERE memory_id = $1 FOR UPDATE', [id]);
  return records<MemoryRecord>(found.rows)[0];
}


function hits(rows: readonly Row[]): MemoryHit[] {
  return rows.map((row) => ({ record: row['record'] as MemoryRecord, score: Number(row['score']) }));
}

/**
 * Nearest visible current memories in one space. The ORDER BY expression is
 * the one the space's partial HNSW index is built on, so the planner can
 * walk the index while the access filter applies.
 */
export function memorySemanticQuery(
  access: SourceAccess,
  space: EmbeddingSpace,
  vector: readonly number[],
  limit: number,
): Result<{ readonly text: string; readonly values: unknown[] }> {
  const sql = spaceSql(space);
  if (!sql.ok) return sql;
  const literal = vectorLiteral(space, vector);
  if (!literal.ok) return literal;
  const params = new SqlParams();
  const v = params.add(literal.value);
  const where = memoryAccessSql(access, params);
  const distance = `e.embedding::${sql.value.cast} <=> ${v}::${sql.value.cast}`;
  const text = `SELECT m.record, 1 - (${distance}) AS score
     FROM memory_embeddings e JOIN memories m ON m.memory_id = e.memory_id
    WHERE e.space = ${sql.value.literal} AND ${where}
    ORDER BY ${distance} LIMIT ${params.add(limit)}`;
  return ok({ text, values: params.values });
}

export function createPostgresMemoryStore(pool: pg.Pool): MemoryStorePort {
  return {
    get: (id) =>
      guarded(async () => {
        const found = await pool.query('SELECT record FROM memories WHERE memory_id = $1', [id]);
        const record = records<MemoryRecord>(found.rows)[0];
        return record === undefined ? notFound(`memory ${id}`) : ok(record);
      }),

    receipt: (key: IdempotencyKey) =>
      guarded(async () => {
        const found = await pool.query('SELECT record FROM memory_write_receipts WHERE idempotency_key = $1', [key]);
        return ok(records<MemoryWriteReceipt>(found.rows)[0] ?? null);
      }),

    candidates: (subject, kind, space, limit) =>
      guarded(async () => {
        const found = await pool.query<{ record: MemoryRecord; vector: string | null }>(
          `SELECT m.record, e.embedding::text AS vector
             FROM memories m LEFT JOIN memory_embeddings e ON e.memory_id = m.memory_id AND e.space = $3
            WHERE m.state = 'current' AND m.subject_key = $1 AND m.kind = $2
            ORDER BY m.seq DESC LIMIT $4`,
          [subjectKey(subject), kind, space.name, limit],
        );
        return ok(found.rows.map((row): MemoryCandidate => ({ record: row.record, vector: parseVector(row.vector) })));
      }),

    searchLexical: (access, query, limit) =>
      guarded(async () => {
        const tsquery = anyTokenQuery(query);
        if (tsquery === null) return ok([]);
        const params = new SqlParams();
        const q = params.add(tsquery);
        const where = memoryAccessSql(access, params);
        const found = await pool.query(
          `SELECT m.record, ts_rank(to_tsvector('simple'::regconfig, m.record ->> 'content'), q) AS score
             FROM memories m, websearch_to_tsquery('simple'::regconfig, ${q}) q
            WHERE to_tsvector('simple'::regconfig, m.record ->> 'content') @@ q AND ${where}
            ORDER BY score DESC, m.seq DESC LIMIT ${params.add(limit)}`,
          params.values,
        );
        return ok(hits(found.rows));
      }),

    searchSemantic: (access, space, vector, limit) =>
      transaction(pool, async (client) => {
        const query = memorySemanticQuery(access, space, vector, limit);
        if (!query.ok) return query;
        await iterativeScan(client);
        const found = await client.query(query.value.text, query.value.values);
        return ok(hits(found.rows).sort((a, b) => b.score - a.score));
      }),

    aboutContact: (access, contactId, limit) =>
      guarded(async () => {
        const params = new SqlParams();
        const contact = params.add(contactId);
        const where = memoryAccessSql(access, params);
        const found = await pool.query(
          `SELECT m.record FROM memories m
            WHERE m.subject_kind = 'contacts' AND ${contact}::text = ANY(m.subject_contacts) AND ${where}
            ORDER BY m.seq DESC LIMIT ${params.add(limit)}`,
          params.values,
        );
        return ok(records<MemoryRecord>(found.rows));
      }),

    census: (access) =>
      guarded(async () => {
        const params = new SqlParams();
        const where = memoryAccessSql(access, params);
        const found = await pool.query<{ kind: MemoryKind; count: string }>(`SELECT m.kind, count(*) AS count FROM memories m WHERE ${where} GROUP BY m.kind`, params.values);
        return ok(Object.fromEntries(found.rows.map((r) => [r.kind, Number(r.count)])) as Partial<Record<MemoryKind, number>>);
      }),

    insert: (input) =>
      transaction(
        pool,
        async (client) => {
          const prior = await client.query('SELECT 1 FROM memory_write_receipts WHERE idempotency_key = $1', [input.receipt.idempotencyKey]);
          if ((prior.rowCount ?? 0) > 0) return conflict('idempotency_mismatch', 'this write key is already recorded');
          for (const s of input.supersede) {
            const old = await lockedMemory(client, s.id);
            if (old?.revision !== s.expectedRevision) return conflict('stale_revision', `memory ${s.id} moved`);
            await replaceMemory(client, { ...old, state: 'superseded', supersededBy: input.record.id, revision: old.revision + 1, updatedAt: input.record.createdAt });
          }
          await insertMemory(client, input.record);
          await insertReceipt(client, input.receipt);
          if (input.vector !== null) {
            const put = await putVector(client, 'memory_embeddings', 'memory_id', input.record.id, input.vector.space, input.vector.values);
            if (!put.ok) return put;
          }
          for (const link of input.links) {
            await client.query('INSERT INTO memory_links (from_id, to_id, record) VALUES ($1, $2, $3)', [link.fromId, link.toId, link]);
          }
          for (const event of input.events) await insertEvent(client, event);
          return ok(input.record);
        },
        { unique: INSERT_CONFLICTS },
      ),

    reinforce: (receipt, event) =>
      transaction(
        pool,
        async (client) => {
          const target = await lockedMemory(client, receipt.memoryId);
          if (target === undefined) return notFound(`memory ${receipt.memoryId}`);
          await insertReceipt(client, receipt);
          await insertEvent(client, event);
          return ok(undefined);
        },
        { unique: INSERT_CONFLICTS },
      ),

    update: (record, expectedRevision, event) =>
      transaction(pool, async (client) => {
        const current = await lockedMemory(client, record.id);
        if (current === undefined) return notFound(`memory ${record.id}`);
        if (current.revision !== expectedRevision) {
          return conflict('stale_revision', `memory ${record.id} moved`, { expectedRevision, actualRevision: current.revision });
        }
        // A vector describes the text it was computed from; changed text needs a fresh one.
        if (current.content !== record.content) await client.query('DELETE FROM memory_embeddings WHERE memory_id = $1', [record.id]);
        await replaceMemory(client, record);
        await insertEvent(client, event);
        return ok(record);
      }),

    putEmbedding: (memoryId, space, vector) =>
      guarded(async () => {
        const exists = await pool.query('SELECT 1 FROM memories WHERE memory_id = $1', [memoryId]);
        if ((exists.rowCount ?? 0) === 0) return notFound(`memory ${memoryId}`);
        return putVector(pool, 'memory_embeddings', 'memory_id', memoryId, space, vector);
      }),

    pendingEmbeddings: (space, limit) =>
      guarded(async () => {
        const found = await pool.query(
          `SELECT m.record FROM memories m
            WHERE m.state = 'current' AND NOT EXISTS (SELECT 1 FROM memory_embeddings e WHERE e.memory_id = m.memory_id AND e.space = $1)
            ORDER BY m.seq LIMIT $2`,
          [space.name, limit],
        );
        return ok(records<MemoryRecord>(found.rows));
      }),

    links: (memoryId) =>
      guarded(async () => {
        const found = await pool.query('SELECT record FROM memory_links WHERE from_id = $1 OR to_id = $1 ORDER BY seq', [memoryId]);
        return ok(records<MemoryLink>(found.rows));
      }),

    events: (memoryId, limit) =>
      guarded(async () => {
        const found = await pool.query(
          'SELECT record FROM (SELECT seq, record FROM memory_events WHERE memory_id = $1 ORDER BY seq DESC LIMIT $2) recent ORDER BY seq',
          [memoryId, limit],
        );
        return ok(records<MemoryEvent>(found.rows));
      }),

    staged: (limit) =>
      guarded(async () => {
        const found = await pool.query("SELECT record FROM memories WHERE state = 'staged' ORDER BY seq LIMIT $1", [limit]);
        return ok(records<MemoryRecord>(found.rows));
      }),
  };
}

export function createPostgresMemoryDeletions(pool: pg.Pool): MemoryDeletionPort {
  return {
    create: (proposal) =>
      guarded(
        async () => {
          await pool.query('INSERT INTO memory_deletion_proposals (proposal_id, memory_id, status, revision, record) VALUES ($1, $2, $3, $4, $5)', [
            proposal.proposalId,
            proposal.memoryId,
            proposal.status,
            proposal.revision,
            proposal,
          ]);
          return ok(proposal);
        },
        { memory_deletion_proposals_pkey: 'already_exists' },
      ),

    get: (proposalId) =>
      guarded(async () => {
        const found = await pool.query('SELECT record FROM memory_deletion_proposals WHERE proposal_id = $1', [proposalId]);
        const record = records<MemoryDeletionProposal>(found.rows)[0];
        return record === undefined ? notFound(`proposal ${proposalId}`) : ok(record);
      }),

    latestFor: (memoryId, status) =>
      guarded(async () => {
        const found = await pool.query('SELECT record FROM memory_deletion_proposals WHERE memory_id = $1 AND status = $2 ORDER BY seq DESC LIMIT 1', [memoryId, status]);
        return ok(records<MemoryDeletionProposal>(found.rows)[0] ?? null);
      }),

    save: (proposal, expectedRevision) =>
      guarded(async () => {
        const saved = await pool.query('UPDATE memory_deletion_proposals SET status = $2, revision = $3, record = $4 WHERE proposal_id = $1 AND revision = $5', [
          proposal.proposalId,
          proposal.status,
          proposal.revision,
          proposal,
          expectedRevision,
        ]);
        return (saved.rowCount ?? 0) === 1 ? ok(proposal) : conflict('stale_revision', `proposal ${proposal.proposalId} moved`);
      }),
  };
}

export function createPostgresScratchpad(pool: pg.Pool): ScratchpadPort {
  const conversationOf = (note: ScratchpadNote) => (note.scope.kind === 'conversation' ? note.scope.conversation : null);
  return {
    list: (conversation, now, limit) =>
      guarded(async () => {
        const found = await pool.query(
          'SELECT record FROM scratchpad_notes WHERE expires_at >= $2 AND (conversation IS NULL OR conversation = $1) ORDER BY seq LIMIT $3',
          [conversation, now, limit],
        );
        return ok(records<ScratchpadNote>(found.rows));
      }),

    get: (id) =>
      guarded(async () => {
        const found = await pool.query('SELECT record FROM scratchpad_notes WHERE note_id = $1', [id]);
        const record = records<ScratchpadNote>(found.rows)[0];
        return record === undefined ? notFound(`note ${id}`) : ok(record);
      }),

    put: (note, expectedRevision) =>
      guarded(
        async () => {
          if (expectedRevision === null) {
            await pool.query('INSERT INTO scratchpad_notes (note_id, conversation, expires_at, revision, record) VALUES ($1, $2, $3, $4, $5)', [
              note.id,
              conversationOf(note),
              note.expiresAt,
              note.revision,
              note,
            ]);
            return ok(note);
          }
          const saved = await pool.query(
            'UPDATE scratchpad_notes SET conversation = $2, expires_at = $3, revision = $4, record = $5 WHERE note_id = $1 AND revision = $6',
            [note.id, conversationOf(note), note.expiresAt, note.revision, note, expectedRevision],
          );
          return (saved.rowCount ?? 0) === 1 ? ok(note) : conflict('stale_revision', `note ${note.id} moved`);
        },
        { scratchpad_notes_pkey: 'stale_revision' },
      ),

    remove: (id, expectedRevision) =>
      guarded(async () => {
        const removed = await pool.query('DELETE FROM scratchpad_notes WHERE note_id = $1 AND revision = $2', [id, expectedRevision]);
        return (removed.rowCount ?? 0) === 1 ? ok(undefined) : conflict('stale_revision', `note ${id} moved`);
      }),
  };
}

export type CursorPurpose = 'memory_extraction' | 'episode_formation';

export function createPostgresSessionCursors(pool: pg.Pool, purpose: CursorPurpose): SessionCursorPort {
  return {
    get: (sessionId) =>
      guarded(async () => {
        const found = await pool.query<{ seq: number; revision: number }>('SELECT seq, revision FROM session_cursors WHERE purpose = $1 AND session_id = $2', [purpose, sessionId]);
        const row = found.rows[0];
        return ok({ seq: row?.seq ?? 0, revision: row?.revision ?? 0 });
      }),

    advance: (sessionId, seq, expectedRevision) =>
      guarded(async () => {
        const moved =
          expectedRevision === 0
            ? await pool.query('INSERT INTO session_cursors (purpose, session_id, seq, revision) VALUES ($1, $2, $3, 1) ON CONFLICT DO NOTHING', [purpose, sessionId, seq])
            : await pool.query('UPDATE session_cursors SET seq = $3, revision = revision + 1 WHERE purpose = $1 AND session_id = $2 AND revision = $4', [
                purpose,
                sessionId,
                seq,
                expectedRevision,
              ]);
        return (moved.rowCount ?? 0) === 1 ? ok(undefined) : conflict('stale_revision', `${purpose} cursor of ${sessionId} moved`);
      }),
  };
}
