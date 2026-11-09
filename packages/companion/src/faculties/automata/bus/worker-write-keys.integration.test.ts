/**
 * Lite (operator automata rule 1) over the real Postgres Bus store: a worker
 * write repeated by a later attempt of the same task, in a process started
 * after the first attempt's process exited, is still one Bus event. Store,
 * run registry and writer are the production ones; the query and index
 * surfaces are stubbed as in worker-execution-restart.integration.test.ts.
 */
import { readFileSync } from 'node:fs';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createPostgresPool, runPostgresMigrations } from '../../../persistence/postgres.js';
import { POSTGRES_AUTOMATA_MIGRATIONS } from '../../../persistence/postgres/migrations.js';
import { POSTGRES_VECTOR_EXTENSION_MIGRATION } from '../../../persistence/postgres/vector-extension-migration.js';
import { PostgresAutomataRunStore } from '../../../persistence/postgres/automata-run-store.js';
import { SENSITIVITY_LEVELS } from '../../../system/trust/types.js';
import {
  PGVECTOR_POSTGRES_TEST_IMAGE,
  startPostgresTestHarness,
  type PostgresTestHarness,
} from '../../../test-support/postgres-test-harness.js';
import { NO_AUTOMATA_REDELIVERY } from '../../../test-support/automata-run-redelivery.js';
import { parseAutomataOwnerPolicy } from '../registry-contract.js';
import { AutomataRunRegistry } from '../run-registry.js';
import type { AutomataBusProductionRuntime } from './production-runtime.js';
import {
  automataBusWorkerBoundsFromOwnerPolicy,
  CanonicalAutomataBusWriter,
  createProductionAutomataBusWorkerAccess,
} from './production-worker-adapter.js';
import { PostgresAutomataBusRuntimeStore } from './runtime-store.js';
import { buildAutomataBusWorkerScope } from './worker-access-formation.js';
import { createAutomataBusTool } from './worker-access-tool.js';

const INTEGRATION_TIMEOUT_MS = 120_000;
const COMPANION = 'companion-public-example-a';
const TASK = 'task-public-example';

let harness: PostgresTestHarness | null = null;

beforeAll(async () => {
  harness = await startPostgresTestHarness({ image: PGVECTOR_POSTGRES_TEST_IMAGE });
}, INTEGRATION_TIMEOUT_MS);

afterAll(async () => {
  await harness?.stop();
}, INTEGRATION_TIMEOUT_MS);

function ownerPolicy() {
  return parseAutomataOwnerPolicy(JSON.parse(readFileSync(
    new URL('../../../../config/automata-policy.seed.json', import.meta.url),
    'utf8',
  )));
}

function stubRuntime(): AutomataBusProductionRuntime {
  return {
    canonical: { getCurrentByEventIds: async () => [] },
    indexing: { indexCurrentFinding: async () => ({ status: 'indexed' }) },
  } as unknown as AutomataBusProductionRuntime;
}

async function startProcess(databaseUrl: string) {
  const policy = ownerPolicy();
  const runStore = await PostgresAutomataRunStore.connect(databaseUrl, COMPANION);
  const registry = await AutomataRunRegistry.hydrate({ redelivery: NO_AUTOMATA_REDELIVERY, companionId: COMPANION, policy, store: runStore });
  const pool = createPostgresPool(databaseUrl, { applicationName: 'automata-write-keys', allowExitOnIdle: true, max: 2 });
  const store = new PostgresAutomataBusRuntimeStore(pool, COMPANION, registry);
  const runtime = stubRuntime();
  const access = createProductionAutomataBusWorkerAccess({
    companionId: COMPANION,
    registry,
    store,
    runtime,
    writer: new CanonicalAutomataBusWriter({ companionId: COMPANION, store, runtime }),
    bounds: automataBusWorkerBoundsFromOwnerPolicy({ query: policy.bus.query, recentRunLimit: policy.recentRunLimit }),
  });
  /** One attempt of the task: a fresh run, as the donor registers a retry. */
  const attempt = async (runId: string, generation: number, sourceRunId?: string) => {
    await registry.register({
      runId,
      automatonClass: 'subagent.bounded',
      workerId: runId,
      workerGeneration: generation,
      taskId: TASK,
      taskLabel: 'Research',
      taskSummary: 'Research the route',
      ...(sourceRunId ? { sourceRunId } : {}),
      sessionIds: [`subagent:${runId}`],
    });
    await registry.transition(runId, { status: 'running', reason: 'agent_initialized' });
    return createAutomataBusTool({
      access,
      scope: buildAutomataBusWorkerScope(access, { automatonClass: 'subagent.bounded', runId, taskId: TASK }),
    });
  };
  const history = async () => await store.readHistory({
    companionId: COMPANION,
    audience: 'eligible-automata',
    maxSensitivity: SENSITIVITY_LEVELS.at(-1)!,
  });
  return {
    attempt,
    history,
    close: async () => {
      await store.close();
      await registry.close();
    },
  };
}

async function withDatabase<T>(operation: (databaseUrl: string) => Promise<T>): Promise<T> {
  if (!harness) throw new Error('Automata write-key Postgres harness is unavailable');
  const database = await harness.createDatabase();
  const owner: Pool = createPostgresPool(database.databaseUrl, { applicationName: 'automata-write-keys-migrations', allowExitOnIdle: true, max: 1 });
  try {
    await runPostgresMigrations(owner, [POSTGRES_VECTOR_EXTENSION_MIGRATION, ...POSTGRES_AUTOMATA_MIGRATIONS]);
  } finally {
    await owner.end();
  }
  return await operation(database.databaseUrl);
}

describe('Lite operator automata rule 1 over Postgres', () => {
  it('keeps one Bus event for a write repeated by the next attempt in a restarted process', async () => {
    await withDatabase(async databaseUrl => {
      const note = { action: 'note', text: 'Route docs live under docs/routes.' };
      const first = await startProcess(databaseUrl);
      const attempt1 = await first.attempt('subagent-attempt-1', 1);
      await attempt1.execute('call-1', note);
      await attempt1.execute('call-2', note);
      await attempt1.execute('call-3', { action: 'note', text: 'The route tests need docker.' });
      await first.close();

      const second = await startProcess(databaseUrl);
      const attempt2 = await second.attempt('subagent-attempt-2', 2, 'subagent-attempt-1');
      const replay = await attempt2.execute('call-1', note);
      expect(replay.content.map(block => ('text' in block ? block.text : '')).join('')).toContain('"inserted": false');
      const events = await second.history();
      expect(events).toHaveLength(2);
      expect(events.map(event => event.context.runId)).toEqual(['subagent-attempt-1', 'subagent-attempt-1']);
      await second.close();
    });
  }, INTEGRATION_TIMEOUT_MS);
});
