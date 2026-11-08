/**
 * Opens durable state for one standalone process: the resolved storage
 * layout, the canonical JSONL archive, and one Postgres pool migrated to the
 * current schema with every store core needs. Nothing opens partially: a
 * failure closes what was already opened and is returned.
 */
import {
  createPostgresActivityStores,
  createPostgresPool,
  createPostgresSelfStateStores,
  migrate,
  openFileSessionArchive,
  postgresMemoryStores,
  postgresStores,
  resolveStorageLayout,
  type FileSessionArchive,
  type PostgresActivityStores,
  type PostgresMemoryStores,
  type PostgresState,
  type SelfStateStores,
  type StorageLayout,
} from './adapters.ts';
import { ok, type EmbeddingSpace, type Result } from './core.ts';
import type { LiteConfig } from './config.ts';

export interface LiteStorage {
  readonly layout: StorageLayout;
  readonly archive: FileSessionArchive;
  readonly state: Omit<PostgresState, 'schemaVersion' | 'close'>;
  readonly memory: PostgresMemoryStores;
  readonly selfState: SelfStateStores;
  readonly activity: PostgresActivityStores;
  readonly schemaVersion: number;
  close(): Promise<void>;
}

export async function openLiteStorage(input: {
  readonly storage: LiteConfig['storage'];
  readonly databaseUrl: string;
  readonly space: EmbeddingSpace;
  readonly onIdleError: (error: Error) => void;
}): Promise<Result<LiteStorage>> {
  const layout = await resolveStorageLayout({
    historyRoot: input.storage.historyRoot,
    workspaceRoot: input.storage.workspaceRoot,
    ...(input.storage.backupRoot === null ? {} : { backupRoot: input.storage.backupRoot }),
  });
  if (!layout.ok) return layout;
  const archive = await openFileSessionArchive(layout.value);
  if (!archive.ok) return archive;
  const pool = createPostgresPool({ connectionString: input.databaseUrl, onIdleError: input.onIdleError });
  const fail = async <T>(failure: Result<T>): Promise<Result<never>> => {
    await pool.end();
    await archive.value.close();
    return failure as Result<never>;
  };
  const applied = await migrate(pool);
  if (!applied.ok) return fail(applied);
  const memory = await postgresMemoryStores(pool, { space: input.space });
  if (!memory.ok) return fail(memory);
  return ok({
    layout: layout.value,
    archive: archive.value,
    state: postgresStores(pool),
    memory: memory.value,
    selfState: createPostgresSelfStateStores(pool),
    activity: createPostgresActivityStores(pool),
    schemaVersion: applied.value.at(-1)?.version ?? 0,
    async close() {
      await pool.end();
      await archive.value.close();
    },
  });
}
