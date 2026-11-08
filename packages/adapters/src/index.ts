/**
 * PSFN Lite storage adapters. Each implements a core-owned port; nothing here
 * holds policy. Canonical lived history is filesystem JSONL; structured state
 * is Postgres (with pgvector available for later retrieval work).
 */
export { canonicalJson } from './canonical-json.ts';
export { openFileBackupStore } from './fs/backup-store.ts';
export { createHistoryBackupComponent } from './fs/history-backup.ts';
export { resolveStorageLayout, type StorageLayout, type StorageRootsInput } from './fs/layout.ts';
export { openFileSessionArchive, type ArchiveDamage, type ArchiveRepair, type FileSessionArchive } from './fs/session-archive.ts';
export { createPostgresPool } from './postgres/database.ts';
export { loadMigrations, migrate, type AppliedMigration, type Migration } from './postgres/migrations.ts';
export { BACKED_UP_TABLES } from './postgres/state-backup.ts';
export { openPostgresState, postgresStores, type PostgresState } from './postgres/state.ts';
export { createPostgresSelfStateStores, type SelfStateStores } from './postgres/self-state-stores.ts';
export { openPostgresMemoryState, postgresMemoryStores, type PostgresMemoryState, type PostgresMemoryStores } from './postgres/memory-state.ts';
