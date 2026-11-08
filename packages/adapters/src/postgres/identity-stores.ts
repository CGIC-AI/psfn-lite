/**
 * Postgres implementations of the core identity ports: orientation blocks,
 * append-only prompt layers, the versioned persona card, the values journal
 * and the North Star set with its item history. Versions are primary keys, so
 * two writers racing for the same next version cannot both succeed.
 */
import type pg from 'pg';
import {
  CORE_BLOCK_LIMITS,
  CORE_BLOCK_NAMES,
  conflict,
  invalid,
  notFound,
  ok,
  type CoreBlock,
  type CoreBlockPort,
  type CoreBlockScope,
  type NorthStarItem,
  type NorthStarPort,
  type NorthStarState,
  type PersonaPort,
  type PersonaVersion,
  type PromptLayer,
  type PromptLayerPort,
  type PromptLayerVersion,
  type Result,
  type ValueEntry,
  type ValuesJournalPort,
} from '../core.ts';
import { guarded, records, transaction, type Queryable } from './database.ts';

export function createPostgresCoreBlocks(pool: pg.Pool): CoreBlockPort {
  const read = async (db: Queryable, scope: CoreBlockScope): Promise<readonly CoreBlock[]> => {
    const found = await db.query<{ record: CoreBlock }>('SELECT record FROM core_blocks WHERE channel_id = $1', [scope.channelId]);
    const stored = new Map(found.rows.map((row) => [row.record.name, row.record]));
    return CORE_BLOCK_NAMES.map(
      (name) => stored.get(name) ?? { name, scope, text: '', maxChars: CORE_BLOCK_LIMITS[name], revision: 0, author: null, updatedAt: null },
    );
  };

  return {
    read: (scope) => guarded(async () => ok(await read(pool, scope))),

    write: (input) =>
      transaction(pool, async (client) => {
        const names = input.changes.map((c) => c.name);
        if (new Set(names).size !== names.length) return invalid('each block may change at most once per write');
        const current = await client.query<{ name: string; revision: number }>(
          'SELECT name, revision FROM core_blocks WHERE channel_id = $1 AND name = ANY($2) FOR UPDATE',
          [input.scope.channelId, names],
        );
        const revisions = new Map(current.rows.map((row) => [row.name, row.revision]));
        for (const change of input.changes) {
          const actual = revisions.get(change.name) ?? 0;
          if (actual !== change.expectedRevision) {
            return conflict('stale_revision', `block ${change.name} moved`, { expectedRevision: change.expectedRevision, actualRevision: actual });
          }
        }
        for (const change of input.changes) {
          const block: CoreBlock = {
            name: change.name,
            scope: input.scope,
            text: change.text,
            maxChars: CORE_BLOCK_LIMITS[change.name],
            revision: change.expectedRevision + 1,
            author: input.author,
            updatedAt: input.at,
          };
          await client.query(
            `INSERT INTO core_blocks (channel_id, name, revision, record) VALUES ($1, $2, $3, $4)
               ON CONFLICT (channel_id, name) DO UPDATE SET revision = EXCLUDED.revision, record = EXCLUDED.record`,
            [input.scope.channelId, change.name, block.revision, block],
          );
        }
        return ok(await read(client, input.scope));
      }),
  };
}

export function createPostgresPromptLayers(pool: pg.Pool): PromptLayerPort {
  const LAYER_SQL = `SELECT l.layer_id, l.name, l.type, v.record
                       FROM prompt_layers l
                       JOIN prompt_layer_versions v ON v.layer_id = l.layer_id AND v.version = l.current_version`;
  const toLayer = (row: { layer_id: string; name: string; type: PromptLayer['type']; record: PromptLayerVersion }): PromptLayer => ({
    id: row.layer_id,
    name: row.name,
    type: row.type,
    version: row.record.version,
    checksum: row.record.checksum,
    enabled: row.record.enabled,
    content: row.record.content,
  });
  const getLayer = async (db: Queryable, layerId: string): Promise<Result<PromptLayer>> => {
    const found = await db.query<Parameters<typeof toLayer>[0]>(`${LAYER_SQL} WHERE l.layer_id = $1`, [layerId]);
    const row = found.rows[0];
    return row === undefined ? notFound(`layer ${layerId}`) : ok(toLayer(row));
  };

  return {
    list: () =>
      guarded(async () => {
        const found = await pool.query<Parameters<typeof toLayer>[0]>(`${LAYER_SQL} ORDER BY l.layer_id`);
        return ok(found.rows.map(toLayer));
      }),

    get: (layerId) => guarded(() => getLayer(pool, layerId)),

    history: (layerId, limit) =>
      guarded(async () => {
        const found = await pool.query('SELECT record FROM prompt_layer_versions WHERE layer_id = $1 ORDER BY version DESC LIMIT $2', [layerId, limit]);
        return ok(records<PromptLayerVersion>(found.rows));
      }),

    version: (layerId, version) =>
      guarded(async () => {
        const found = await pool.query('SELECT record FROM prompt_layer_versions WHERE layer_id = $1 AND version = $2', [layerId, version]);
        const record = records<PromptLayerVersion>(found.rows)[0];
        return record === undefined ? notFound(`layer ${layerId} v${String(version)}`) : ok(record);
      }),

    commit: (next, expectedVersion, create) =>
      transaction(
        pool,
        async (client) => {
          if (next.version !== expectedVersion + 1) return conflict('stale_revision', `layer ${next.layerId} version must follow ${String(expectedVersion)}`);
          const current = await client.query<{ current_version: number }>('SELECT current_version FROM prompt_layers WHERE layer_id = $1 FOR UPDATE', [
            next.layerId,
          ]);
          const actual = current.rows[0]?.current_version ?? 0;
          if (actual !== expectedVersion) {
            return conflict('stale_revision', `layer ${next.layerId} moved`, { expectedRevision: expectedVersion, actualRevision: actual });
          }
          if (expectedVersion === 0) {
            if (create === undefined) return notFound(`layer ${next.layerId}`);
            await client.query('INSERT INTO prompt_layers (layer_id, name, type, current_version) VALUES ($1, $2, $3, 1)', [
              next.layerId,
              create.name,
              create.type,
            ]);
            await client.query('INSERT INTO prompt_layer_versions (layer_id, version, record) VALUES ($1, 1, $2)', [next.layerId, next]);
          } else {
            await client.query('INSERT INTO prompt_layer_versions (layer_id, version, record) VALUES ($1, $2, $3)', [next.layerId, next.version, next]);
            await client.query('UPDATE prompt_layers SET current_version = $2 WHERE layer_id = $1', [next.layerId, next.version]);
          }
          return getLayer(client, next.layerId);
        },
        { unique: { prompt_layers_pkey: 'stale_revision', prompt_layer_versions_pkey: 'stale_revision' } },
      ),
  };
}

export function createPostgresPersona(pool: pg.Pool): PersonaPort {
  return {
    current: () =>
      guarded(async () => {
        const found = await pool.query('SELECT record FROM persona_versions ORDER BY version DESC LIMIT 1');
        return ok(records<PersonaVersion>(found.rows)[0] ?? null);
      }),

    commit: (next, expectedVersion) =>
      transaction(
        pool,
        async (client) => {
          if (next.version !== expectedVersion + 1) return conflict('stale_revision', `persona version must follow ${String(expectedVersion)}`);
          const latest = await client.query<{ version: number }>('SELECT coalesce(max(version), 0)::int AS version FROM persona_versions');
          const actual = latest.rows[0]?.version ?? 0;
          if (actual !== expectedVersion) return conflict('stale_revision', 'persona moved', { expectedRevision: expectedVersion, actualRevision: actual });
          await client.query('INSERT INTO persona_versions (version, record) VALUES ($1, $2)', [next.version, next]);
          return ok(next);
        },
        { unique: { persona_versions_pkey: 'stale_revision' } },
      ),
  };
}

export function createPostgresValuesJournal(pool: pg.Pool): ValuesJournalPort {
  return {
    list: (limit) =>
      guarded(async () => {
        const found = await pool.query('SELECT record FROM value_entries ORDER BY version DESC LIMIT $1', [limit]);
        return ok(records<ValueEntry>(found.rows));
      }),

    get: (version) =>
      guarded(async () => {
        const found = await pool.query('SELECT record FROM value_entries WHERE version = $1', [version]);
        const record = records<ValueEntry>(found.rows)[0];
        return record === undefined ? notFound(`value v${String(version)}`) : ok(record);
      }),

    latestVersion: () =>
      guarded(async () => {
        const found = await pool.query<{ version: number }>('SELECT coalesce(max(version), 0)::int AS version FROM value_entries');
        return ok(found.rows[0]?.version ?? 0);
      }),

    append: (entry) =>
      guarded(
        async () => {
          await pool.query('INSERT INTO value_entries (version, record) VALUES ($1, $2)', [entry.version, entry]);
          return ok(entry);
        },
        { value_entries_pkey: 'already_exists' },
      ),
  };
}

export function createPostgresNorthStar(pool: pg.Pool): NorthStarPort {
  return {
    read: () =>
      guarded(async () => {
        const found = await pool.query<{ revision: number; items: NorthStarItem[] }>('SELECT revision, items FROM north_star_state');
        const row = found.rows[0];
        const state: NorthStarState = row === undefined ? { items: [], revision: 0 } : { items: row.items, revision: row.revision };
        return ok(state);
      }),

    save: (items, expectedRevision, reason) =>
      transaction(
        pool,
        async (client) => {
          const revision = expectedRevision + 1;
          const written =
            expectedRevision === 0
              ? await client.query('INSERT INTO north_star_state (singleton, revision, items) VALUES (true, 1, $1) ON CONFLICT DO NOTHING', [
                  JSON.stringify(items),
                ])
              : await client.query('UPDATE north_star_state SET revision = $2, items = $1 WHERE revision = $3', [
                  JSON.stringify(items),
                  revision,
                  expectedRevision,
                ]);
          if (written.rowCount === 0) return conflict('stale_revision', 'North Star moved', { expectedRevision });
          for (const item of items) {
            const inserted = await client.query(
              `INSERT INTO north_star_item_versions (item_id, version, saved_revision, reason, record) VALUES ($1, $2, $3, $4, $5)
                 ON CONFLICT (item_id, version) DO NOTHING`,
              [item.id, item.version, revision, reason, item],
            );
            if (inserted.rowCount === 0) {
              // An unchanged item keeps its version; a changed item must carry a new one.
              const same = await client.query('SELECT 1 FROM north_star_item_versions WHERE item_id = $1 AND version = $2 AND record = $3::jsonb', [
                item.id,
                item.version,
                JSON.stringify(item),
              ]);
              if (same.rowCount === 0) return conflict('entry_mismatch', `North Star item ${item.id} changed without a new version`);
            }
          }
          const state: NorthStarState = { items, revision };
          return ok(state);
        },
      ),
  };
}
