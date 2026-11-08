/**
 * Postgres implementation of the core episode port: episodes, every version
 * of the companion's meaning, per-space embeddings and arcs. Filtered reads
 * apply `episodeReadable` in SQL. Machine saves never write meaning or touch
 * an episode that carries it beyond promotion, a merge is one transaction,
 * and meaning is written compare-and-set on its own revision.
 */
import type pg from 'pg';
import {
  conflict,
  frozenEpisodeChange,
  invalid,
  notFound,
  ok,
  sourceKeys,
  type Episode,
  type EpisodeArc,
  type EpisodeHit,
  type EpisodeMeaning,
  type EpisodeStorePort,
} from '../core.ts';
import { guarded, records, transaction, type Queryable, type Row } from './database.ts';
import { SqlParams, anyTokenQuery, episodeAccessSql, iterativeScan, putVector, spaceSql, vectorLiteral } from './memory-sql.ts';

/**
 * Must match the `episodes_search` index expression exactly. The companion's
 * meaning is companion-private and deliberately not indexed, so it can never
 * decide whether or how high a shared search ranks an episode.
 */
const SEARCH_TEXT = `coalesce(e.record -> 'machineSignals' ->> 'summary', '')`;

function episodeColumns(episode: Episode): unknown[] {
  const { conversation, sourceClass } = sourceKeys(episode.source);
  return [
    episode.id,
    episode.lifecycle,
    conversation,
    sourceClass,
    episode.source.kind === 'self' ? null : episode.source.channelId,
    episode.participantContactIds,
    episode.occurredFrom,
    episode.occurredTo,
    episode.revision,
    episode,
  ];
}

async function replaceEpisode(db: Queryable, episode: Episode): Promise<void> {
  await db.query(
    `UPDATE episodes SET lifecycle = $2, source_conversation = $3, source_class = $4, source_channel = $5, participants = $6,
            occurred_from = $7, occurred_to = $8, revision = $9, record = $10
      WHERE episode_id = $1`,
    episodeColumns(episode),
  );
}

async function lockedEpisode(db: Queryable, id: string): Promise<Episode | undefined> {
  const found = await db.query('SELECT record FROM episodes WHERE episode_id = $1 FOR UPDATE', [id]);
  return records<Episode>(found.rows)[0];
}

function hits(rows: readonly Row[]): EpisodeHit[] {
  return rows.map((row) => ({ episode: row['record'] as Episode, score: Number(row['score']) }));
}

async function arcById(db: Queryable, arcId: string): Promise<EpisodeArc | undefined> {
  const found = await db.query('SELECT record FROM episode_arcs WHERE arc_id = $1', [arcId]);
  return records<EpisodeArc>(found.rows)[0];
}

export function createPostgresEpisodeStore(pool: pg.Pool): EpisodeStorePort {
  return {
    get: (id) =>
      guarded(async () => {
        const found = await pool.query('SELECT record FROM episodes WHERE episode_id = $1', [id]);
        const record = records<Episode>(found.rows)[0];
        return record === undefined ? notFound(`episode ${id}`) : ok(record);
      }),

    createIfAbsent: (episode) =>
      guarded(async () => {
        const fresh: Episode = { ...episode, meaning: null };
        const inserted = await pool.query(
          `INSERT INTO episodes (episode_id, lifecycle, source_conversation, source_class, source_channel, participants, occurred_from, occurred_to, revision, record)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) ON CONFLICT (episode_id) DO NOTHING`,
          episodeColumns(fresh),
        );
        if ((inserted.rowCount ?? 0) === 1) return ok({ episode: fresh, created: true as boolean });
        const existing = await pool.query('SELECT record FROM episodes WHERE episode_id = $1', [episode.id]);
        const record = records<Episode>(existing.rows)[0];
        return record === undefined ? notFound(`episode ${episode.id}`) : ok({ episode: record, created: false });
      }),

    saveMachine: (episode, expectedRevision) =>
      transaction(pool, async (client) => {
        const current = await lockedEpisode(client, episode.id);
        if (current === undefined) return notFound(`episode ${episode.id}`);
        if (current.revision !== expectedRevision) {
          return conflict('stale_revision', `episode ${episode.id} moved`, { expectedRevision, actualRevision: current.revision });
        }
        const frozen = frozenEpisodeChange(current, episode);
        if (frozen !== null) return conflict('stale_revision', frozen);
        // Machine passes never write meaning: whatever the companion wrote is carried over unchanged.
        const saved: Episode = { ...episode, meaning: current.meaning };
        await replaceEpisode(client, saved);
        await client.query('DELETE FROM episode_embeddings WHERE episode_id = $1', [episode.id]);
        return ok(saved);
      }),

    merge: (survivor, expectedSurvivorRevision, absorbed, at) =>
      transaction(pool, async (client) => {
        const ids = [survivor.id, ...absorbed.map((a) => a.id)];
        if (new Set(ids).size !== ids.length) return invalid('a merge names each episode once');
        // Lock every row in a stable order, then check all of them before writing any.
        const found = await client.query('SELECT record FROM episodes WHERE episode_id = ANY($1::text[]) ORDER BY episode_id FOR UPDATE', [ids]);
        const current = new Map(records<Episode>(found.rows).map((e) => [e.id, e]));
        const expected = new Map<string, number>([[survivor.id, expectedSurvivorRevision], ...absorbed.map((a) => [a.id, a.expectedRevision] as const)]);
        for (const [id, revision] of expected) {
          const row = current.get(id);
          if (row === undefined) return notFound(`episode ${id}`);
          if (row.revision !== revision) return conflict('stale_revision', `episode ${id} moved`, { expectedRevision: revision, actualRevision: row.revision });
          if (row.meaning !== null) return conflict('stale_revision', `episode ${id} carries companion meaning and cannot be merged`);
          if (row.lifecycle === 'merged') return conflict('stale_revision', `episode ${id} was already merged`);
        }
        const saved: Episode = { ...survivor, meaning: null };
        await replaceEpisode(client, saved);
        await client.query('DELETE FROM episode_embeddings WHERE episode_id = $1', [survivor.id]);
        for (const { id } of absorbed) {
          const row = current.get(id) as Episode;
          await replaceEpisode(client, { ...row, lifecycle: 'merged', mergedInto: survivor.id, revision: row.revision + 1, updatedAt: at });
          await client.query('DELETE FROM episode_embeddings WHERE episode_id = $1', [id]);
        }
        return ok(saved);
      }),

    setMeaning: (episodeId, meaning, expectedMeaningRevision) =>
      transaction(pool, async (client) => {
        const current = await lockedEpisode(client, episodeId);
        if (current === undefined) return notFound(`episode ${episodeId}`);
        // A merge that committed after the caller's read would leave the meaning on a record no read returns.
        if (current.lifecycle === 'merged') return conflict('stale_revision', `episode ${episodeId} was merged`);
        const actual = current.meaning?.revision ?? 0;
        if (actual !== expectedMeaningRevision) {
          return conflict('stale_revision', `meaning of episode ${episodeId} moved`, { expectedRevision: expectedMeaningRevision, actualRevision: actual });
        }
        // The episode revision moves too, so a machine change planned against the old record fails its compare-and-set.
        const saved: Episode = { ...current, meaning, revision: current.revision + 1 };
        await replaceEpisode(client, saved);
        await client.query('INSERT INTO episode_meanings (episode_id, revision, record) VALUES ($1, $2, $3)', [episodeId, meaning.revision, meaning]);
        return ok(saved);
      }),

    meaningHistory: (episodeId) =>
      guarded(async () => {
        const found = await pool.query('SELECT record FROM episode_meanings WHERE episode_id = $1 ORDER BY revision', [episodeId]);
        return ok(records<EpisodeMeaning>(found.rows));
      }),

    searchLexical: (access, query, limit) =>
      guarded(async () => {
        const tsquery = anyTokenQuery(query);
        if (tsquery === null) return ok([]);
        const params = new SqlParams();
        const q = params.add(tsquery);
        const where = episodeAccessSql(access, params);
        const found = await pool.query(
          `SELECT e.record, ts_rank(to_tsvector('simple'::regconfig, ${SEARCH_TEXT}), q) AS score
             FROM episodes e, websearch_to_tsquery('simple'::regconfig, ${q}) q
            WHERE to_tsvector('simple'::regconfig, ${SEARCH_TEXT}) @@ q AND ${where}
            ORDER BY score DESC, e.seq DESC LIMIT ${params.add(limit)}`,
          params.values,
        );
        return ok(hits(found.rows));
      }),

    searchSemantic: (access, space, vector, limit) =>
      transaction(pool, async (client) => {
        const sql = spaceSql(space);
        if (!sql.ok) return sql;
        const literal = vectorLiteral(space, vector);
        if (!literal.ok) return literal;
        await iterativeScan(client);
        const params = new SqlParams();
        const v = params.add(literal.value);
        const where = episodeAccessSql(access, params);
        const distance = `x.embedding::${sql.value.cast} <=> ${v}::${sql.value.cast}`;
        const found = await client.query(
          `SELECT e.record, 1 - (${distance}) AS score
             FROM episode_embeddings x JOIN episodes e ON e.episode_id = x.episode_id
            WHERE x.space = ${sql.value.literal} AND ${where}
            ORDER BY ${distance} LIMIT ${params.add(limit)}`,
          params.values,
        );
        return ok(hits(found.rows).sort((a, b) => b.score - a.score));
      }),

    timeline: (access, from, to, limit) =>
      guarded(async () => {
        const params = new SqlParams();
        const range = `e.occurred_to >= ${params.add(from)} AND e.occurred_from <= ${params.add(to)}`;
        const where = episodeAccessSql(access, params);
        const found = await pool.query(`SELECT e.record FROM episodes e WHERE ${range} AND ${where} ORDER BY e.occurred_from, e.seq LIMIT ${params.add(limit)}`, params.values);
        return ok(records<Episode>(found.rows));
      }),

    withParticipant: (access, contactId, limit) =>
      guarded(async () => {
        const params = new SqlParams();
        const contact = params.add(contactId);
        const where = episodeAccessSql(access, params);
        const found = await pool.query(
          `SELECT e.record FROM episodes e WHERE ${contact}::text = ANY(e.participants) AND ${where} ORDER BY e.occurred_from DESC, e.seq DESC LIMIT ${params.add(limit)}`,
          params.values,
        );
        return ok(records<Episode>(found.rows));
      }),

    inConversation: (conversation, limit) =>
      guarded(async () => {
        const found = await pool.query(
          "SELECT record FROM episodes WHERE lifecycle <> 'merged' AND source_conversation = $1 ORDER BY occurred_from, seq LIMIT $2",
          [conversation, limit],
        );
        return ok(records<Episode>(found.rows));
      }),

    canonicalSince: (since, limit) =>
      guarded(async () => {
        const found = await pool.query("SELECT record FROM episodes WHERE lifecycle = 'canonical' AND occurred_to >= $1 ORDER BY occurred_from, seq LIMIT $2", [
          since,
          limit,
        ]);
        return ok(records<Episode>(found.rows));
      }),

    putEmbedding: (episodeId, space, vector) =>
      guarded(async () => {
        const exists = await pool.query('SELECT 1 FROM episodes WHERE episode_id = $1', [episodeId]);
        if ((exists.rowCount ?? 0) === 0) return notFound(`episode ${episodeId}`);
        return putVector(pool, 'episode_embeddings', 'episode_id', episodeId, space, vector);
      }),

    pendingEmbeddings: (space, limit) =>
      guarded(async () => {
        const found = await pool.query(
          `SELECT e.record FROM episodes e
            WHERE e.lifecycle <> 'merged' AND NOT EXISTS (SELECT 1 FROM episode_embeddings x WHERE x.episode_id = e.episode_id AND x.space = $1)
            ORDER BY e.seq LIMIT $2`,
          [space.name, limit],
        );
        return ok(records<Episode>(found.rows));
      }),

    arcsContaining: (episodeId) =>
      guarded(async () => {
        const found = await pool.query(
          'SELECT a.record FROM episode_arcs a WHERE EXISTS (SELECT 1 FROM episode_arc_members m WHERE m.arc_id = a.arc_id AND m.episode_id = $1) ORDER BY a.arc_id',
          [episodeId],
        );
        return ok(records<EpisodeArc>(found.rows));
      }),

    getArc: (arcId) =>
      guarded(async () => {
        const arc = await arcById(pool, arcId);
        return arc === undefined ? notFound(`arc ${arcId}`) : ok(arc);
      }),

    saveArc: (arc, expectedRevision) =>
      transaction(
        pool,
        async (client) => {
          if (expectedRevision === null) {
            await client.query('INSERT INTO episode_arcs (arc_id, revision, record) VALUES ($1, $2, $3)', [arc.id, arc.revision, arc]);
          } else {
            const saved = await client.query('UPDATE episode_arcs SET revision = $2, record = $3 WHERE arc_id = $1 AND revision = $4', [
              arc.id,
              arc.revision,
              arc,
              expectedRevision,
            ]);
            if ((saved.rowCount ?? 0) !== 1) return conflict('stale_revision', `arc ${arc.id} moved`);
            await client.query('DELETE FROM episode_arc_members WHERE arc_id = $1', [arc.id]);
          }
          for (const [position, episodeId] of arc.episodeIds.entries()) {
            await client.query('INSERT INTO episode_arc_members (arc_id, episode_id, position) VALUES ($1, $2, $3)', [arc.id, episodeId, position]);
          }
          return ok(arc);
        },
        { unique: { episode_arcs_pkey: 'stale_revision' } },
      ),
  };
}
