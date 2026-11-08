/**
 * Per-file throwaway Postgres for adapter integration tests. One container per
 * test file, one fresh database per test, every opened state closed after the
 * test and the container removed after the file.
 */
import { afterAll, afterEach, beforeAll } from 'vitest';
import { openPostgresState, type PostgresState } from '../../packages/adapters/src/index.ts';
import { HARNESS_START_TIMEOUT_MS, startPostgresHarness, type PostgresHarness } from '../support/postgres-harness.ts';

export function usePostgres() {
  let harness: PostgresHarness | undefined;
  const opened: PostgresState[] = [];
  const idleErrors: Error[] = [];

  beforeAll(async () => {
    harness = await startPostgresHarness();
  }, HARNESS_START_TIMEOUT_MS);

  afterEach(async () => {
    for (const state of opened.splice(0)) await state.close();
    if (idleErrors.length > 0) throw new Error(`idle pool errors: ${idleErrors.map((e) => e.message).join('; ')}`);
  });

  afterAll(() => {
    harness?.stop();
  });

  const database = async (): Promise<string> => {
    if (harness === undefined) throw new Error('postgres harness did not start');
    return harness.createDatabase();
  };

  /** Opens (and migrates) the state in `url`, closed automatically after the test. */
  const open = async (url: string): Promise<PostgresState> => {
    const state = await openPostgresState({ connectionString: url, onIdleError: (error) => idleErrors.push(error) });
    if (!state.ok) throw new Error(JSON.stringify(state.error));
    opened.push(state.value);
    return state.value;
  };

  /** Closes a state early, as a crash or restart would, so a successor can reopen it. */
  const close = async (state: PostgresState): Promise<void> => {
    const index = opened.indexOf(state);
    if (index !== -1) opened.splice(index, 1);
    await state.close();
  };

  return { database, open, close, fresh: async () => open(await database()) };
}
