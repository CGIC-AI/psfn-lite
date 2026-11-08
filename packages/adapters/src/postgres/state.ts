/**
 * Opens the structured continuity state: connects, applies migrations, and
 * returns every Postgres-backed core port. The stores are typed by core
 * contracts only; callers never see a concrete store class.
 */
import type pg from 'pg';
import {
  ok,
  type BackupComponentPort,
  type ContactStorePort,
  type ContinuityPort,
  type CoreBlockPort,
  type FocusPort,
  type NorthStarPort,
  type PersonaPort,
  type PromptLayerPort,
  type Result,
  type SessionCatalogPort,
  type TranscriptProjectionPort,
  type TurnLedgerPort,
  type ValuesJournalPort,
} from '../core.ts';
import { createPostgresContactStore } from './contact-store.ts';
import { createPostgresPool } from './database.ts';
import {
  createPostgresCoreBlocks,
  createPostgresNorthStar,
  createPostgresPersona,
  createPostgresPromptLayers,
  createPostgresValuesJournal,
} from './identity-stores.ts';
import { migrate } from './migrations.ts';
import {
  createPostgresContinuity,
  createPostgresFocus,
  createPostgresSessionCatalog,
  createPostgresTranscriptProjection,
  createPostgresTurnLedger,
} from './session-stores.ts';
import { createPostgresStateBackupComponent } from './state-backup.ts';

export interface PostgresState {
  readonly ledger: TurnLedgerPort;
  readonly sessions: SessionCatalogPort;
  readonly continuity: ContinuityPort;
  readonly focus: FocusPort;
  readonly projection: TranscriptProjectionPort;
  readonly contacts: ContactStorePort;
  readonly blocks: CoreBlockPort;
  readonly layers: PromptLayerPort;
  readonly persona: PersonaPort;
  readonly values: ValuesJournalPort;
  readonly northStar: NorthStarPort;
  readonly backup: BackupComponentPort;
  readonly schemaVersion: number;
  close(): Promise<void>;
}

export function postgresStores(pool: pg.Pool): Omit<PostgresState, 'schemaVersion' | 'close'> {
  return {
    ledger: createPostgresTurnLedger(pool),
    sessions: createPostgresSessionCatalog(pool),
    continuity: createPostgresContinuity(pool),
    focus: createPostgresFocus(pool),
    projection: createPostgresTranscriptProjection(pool),
    contacts: createPostgresContactStore(pool),
    blocks: createPostgresCoreBlocks(pool),
    layers: createPostgresPromptLayers(pool),
    persona: createPostgresPersona(pool),
    values: createPostgresValuesJournal(pool),
    northStar: createPostgresNorthStar(pool),
    backup: createPostgresStateBackupComponent(pool),
  };
}

export async function openPostgresState(options: {
  readonly connectionString: string;
  readonly onIdleError: (error: Error) => void;
}): Promise<Result<PostgresState>> {
  const pool = createPostgresPool(options);
  const applied = await migrate(pool);
  if (!applied.ok) {
    await pool.end();
    return applied;
  }
  return ok({
    ...postgresStores(pool),
    schemaVersion: applied.value.at(-1)?.version ?? 0,
    close: () => pool.end(),
  });
}
