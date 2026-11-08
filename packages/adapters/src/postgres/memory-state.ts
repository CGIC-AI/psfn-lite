/**
 * The Postgres memory, episode and journal ports for one embedding space.
 * Opening them creates that space's HNSW indexes; the schema itself comes
 * from the shared migrations. Callers see only core port types.
 */
import type pg from 'pg';
import {
  ok,
  type EmbeddingSpace,
  type EpisodeStorePort,
  type JournalNotePort,
  type LetterPort,
  type MemoryDeletionPort,
  type MemoryStorePort,
  type ReflectionPort,
  type Result,
  type ScratchpadPort,
  type SessionCursorPort,
} from '../core.ts';
import { createPostgresPool } from './database.ts';
import { createPostgresEpisodeStore } from './episode-stores.ts';
import { createPostgresJournalNotes, createPostgresLetters, createPostgresReflections } from './journal-stores.ts';
import { ensureEmbeddingIndexes } from './memory-sql.ts';
import { createPostgresMemoryDeletions, createPostgresMemoryStore, createPostgresScratchpad, createPostgresSessionCursors } from './memory-stores.ts';
import { migrate } from './migrations.ts';

/** Named as `createMemoryStack` takes them, so a host can spread them in. */
export interface PostgresMemoryStores {
  readonly memories: MemoryStorePort;
  readonly deletions: MemoryDeletionPort;
  readonly scratchpad: ScratchpadPort;
  readonly extractionCursors: SessionCursorPort;
  readonly episodes: EpisodeStorePort;
  readonly formationCursors: SessionCursorPort;
  readonly journal: JournalNotePort;
  readonly reflections: ReflectionPort;
  readonly letters: LetterPort;
}

/** The memory ports over a pool whose schema is already migrated. */
export async function postgresMemoryStores(pool: pg.Pool, options: { readonly space: EmbeddingSpace }): Promise<Result<PostgresMemoryStores>> {
  const indexed = await ensureEmbeddingIndexes(pool, options.space);
  if (!indexed.ok) return indexed;
  return ok({
    memories: createPostgresMemoryStore(pool),
    deletions: createPostgresMemoryDeletions(pool),
    scratchpad: createPostgresScratchpad(pool),
    extractionCursors: createPostgresSessionCursors(pool, 'memory_extraction'),
    episodes: createPostgresEpisodeStore(pool),
    formationCursors: createPostgresSessionCursors(pool, 'episode_formation'),
    journal: createPostgresJournalNotes(pool),
    reflections: createPostgresReflections(pool),
    letters: createPostgresLetters(pool),
  });
}

export interface PostgresMemoryState extends PostgresMemoryStores {
  close(): Promise<void>;
}

/** Connects, applies migrations and opens the memory ports for `space`. */
export async function openPostgresMemoryState(options: {
  readonly connectionString: string;
  readonly onIdleError: (error: Error) => void;
  readonly space: EmbeddingSpace;
}): Promise<Result<PostgresMemoryState>> {
  const pool = createPostgresPool(options);
  const applied = await migrate(pool);
  const stores = applied.ok ? await postgresMemoryStores(pool, { space: options.space }) : applied;
  if (!stores.ok) {
    await pool.end();
    return stores;
  }
  return ok({ ...stores.value, close: () => pool.end() });
}
