// ── Lite boot proof for the seam 3.11 composition root (docs/extraction.md, B6) ──
//
// Boots startCompanionRuntime over a real PostgreSQL (the donor test harness,
// pgvector image) with the packages/pi adapters: a pi-ai faux model behind
// companionProviderRuntimeOf / companionModelRegistryEntryOf and a
// deterministic embedding port behind companionEmbeddingProviderOf. It proves
// a turn through SubstrateAgent.handleMessage, the scheduler heartbeat, the
// registered background lanes and that no scaffolding schema is created.
// A Lite addition: listed in extraction/added-tests.tsv.

import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  type Context,
  type FauxResponseStep,
} from '@earendil-works/pi-ai';
import {
  companionEmbeddingProviderOf,
  companionModelRegistryEntryOf,
  companionProviderRuntimeOf,
  createPiModelRuntime,
} from '../../../../pi/src/index.ts';
import { ok } from '../../../../pi/src/result.ts';
import { createPostgresPool } from '../../persistence/postgres.js';
import {
  PGVECTOR_POSTGRES_TEST_IMAGE,
  startPostgresTestHarness,
  type PostgresTestHarness,
} from '../../test-support/postgres-test-harness.js';
import { EventBus } from '../../shared/event-bus.js';
import { loadInnerLifeConfig } from '../../system/config/inner-life-config.js';
import type { SubstrateConfig } from '../../system/config/runtime-config-contracts.js';
import type { ProviderRuntime } from '../../primitives/llm/provider-runtime.js';
import type { EmbeddingRuntimeProvider } from '../../faculties/memory/embedding.js';
import { startCompanionRuntime, type CompanionRuntime } from './companion-runtime.js';

const INTEGRATION_TIMEOUT_MS = 180_000;
const COMPANION_ID = '5e1f0c3a-7b2d-4c8e-9a10-2b3c4d5e6f70';
const COMPANION_NAME = 'Lumen';
const EMBEDDING_DIMS = 16;
const USER_TEXT = 'Good morning, how are you today?';
const SCRIPTED_REPLY = 'Good morning to you as well.';
const PACKAGE_DIR = join(import.meta.dirname, '..', '..', '..');
const SEED_DIR = join(PACKAGE_DIR, 'config');

let harness: PostgresTestHarness | null = null;
let databaseUrl = '';
let dataDir = '';
let runtime: CompanionRuntime | null = null;
const eventBus = new EventBus();
const modelContexts: Context[] = [];
const healthchecks: { timestamp: number; taskCount: number }[] = [];
const lifecycle: string[] = [];
let firstHealthcheck: Promise<void> = Promise.resolve();

/**
 * The scheduler tasks this config registers: the donor's registrations for the
 * shipped seeds (scheduler.seed.json: introspectionAudit, weightedThoughtOutreach
 * and blindReviewer disabled; settings.seed.json: emosimProactivity off) minus
 * the cut lanes, which the donor also registered here: the database backup
 * tasks, the tool-usage evaluator (model-usage ledger), world exploration and
 * the drift / second-arrow review lanes. The health detectors ran on their own
 * scheduler in the donor.
 */
const EXPECTED_TASK_IDS = [
  'automata-bus-reviewer',
  'background-maintenance',
  'background-work-supervisor',
  'biography-candidate-synthesis',
  'biography-companion-review',
  'concern-review-supervisor',
  'free-time:idle',
  'free-time:quiet-hours',
  'heartbeat',
  'memory.episode-synthesis.timer:09-00',
  'memory.episode-synthesis.timer:12-00',
  'memory.episode-synthesis.timer:15-00',
  'memory.episode-synthesis.timer:18-00',
  'post-turn-action-executor',
  'reflection:daily-review',
  'reflection:weekly-review',
  'social_desire.outreach',
  'temporal-wakeup:morning',
];

/** Tables only the cut stores' migration chains create (health, CogSec, custody, partner affect, model usage, wiki, workbench, shared schema). */
const SCAFFOLDING_TABLES = [
  'runtime_health_events', 'human_escalations', 'human_escalation_attempts',
  'cogsec_receipts', 'cogsec_blind_review_evidence', 'cogsec_blind_review_state',
  'custody_snapshots', 'custody_context_manifests', 'egress_delivery_records',
  'partner_affect_shadow_observations', 'partner_affect_shadow_suppressions',
  'model_usage_events', 'model_budget_operator_alerts', 'model_budget_operator_alert_delivery_events',
  'icp_conversation_cost_decisions', 'icp_conversation_cost_reservations',
  'wiki_document_chunks', 'analysis_workbench_traces',
  'shared_schema_migrations', 'companion_presence', 'companion_social_pot',
  'fleet_maintenance_baton', 'fleet_maintenance_checkpoints', 'fleet_maintenance_demands',
  'room_participation_leases', 'speaking_reservations', 'speaking_room_episodes',
  'speaking_egress_leases', 'speaking_episode_participation', 'shared_wiki_chunks', 'shared_wiki_proposals',
];

/** A sample of the kept stores' tables: each store migrated on connect. */
const KEPT_TABLES = [
  'l2_memories', 'l01_episodes', 'contacts', 'active_concerns', 'automata_runs', 'automata_bus_events',
  'agent_background_work_jobs', 'session_messages_projection', 'letters', 'reflections',
  'internal_state_snapshots', 'scheduler_scheduled_prompts', 'companion_availability_state',
  'biographical_claims', 'introspection_landmarks', 'social_desires', 'weighted_thoughts',
];

/** The last user text of a model request. */
function lastUserText(context: Context): string {
  for (const message of [...context.messages].reverse()) {
    if (message.role !== 'user') continue;
    return typeof message.content === 'string'
      ? message.content
      : message.content.map(part => (part.type === 'text' ? part.text : '')).join('');
  }
  return '';
}

/** Deterministic vectors: a fixed function of the text, never a stand-in for a missing provider. */
function vectorFor(text: string): number[] {
  const vector = new Array<number>(EMBEDDING_DIMS).fill(0);
  for (let index = 0; index < text.length; index += 1) {
    vector[index % EMBEDDING_DIMS]! += text.charCodeAt(index) / 1000;
  }
  vector[0]! += 1;
  return vector;
}

/**
 * The host's config: the scalar settings.json values (the donor applied them
 * with settings/runtime.ts copyDefinedConfigSettings; a Lite host does it
 * itself), then this host's model, embedding and database choices.
 */
function buildConfig(cardPath: string, registry: unknown): SubstrateConfig {
  const seedSettings = JSON.parse(readFileSync(join(SEED_DIR, 'settings.seed.json'), 'utf8')) as Record<string, unknown>;
  const scalarSettings = Object.fromEntries(
    Object.entries(seedSettings).filter(([, value]) => value === null || typeof value !== 'object'),
  );
  return {
    ...scalarSettings,
    primaryModel: 'faux-1',
    primaryProvider: 'faux',
    extractionModel: 'faux-1',
    extractionProvider: 'faux',
    primaryMaxTokens: 1024,
    extractionMaxTokens: 1024,
    characterCardPath: cardPath,
    dataDir,
    databasePath: join(dataDir, 'unused.db'),
    extractionInterval: 5,
    maintenanceIntervalMs: 300_000,
    defaultContextWindow: 128_000,
    extractionThresholdPct: 30,
    compactionThresholdPct: 70,
    modelRoster: {},
    modelRegistry: registry,
    companionId: COMPANION_ID,
    persistenceBackend: 'postgres',
    postgresDatabaseUrl: databaseUrl,
    embeddingProvider: 'api',
    embeddingApiModel: 'boot-test-embedding',
    embeddingApiDims: EMBEDDING_DIMS,
  } as SubstrateConfig;
}

beforeAll(async () => {
  harness = await startPostgresTestHarness({ image: PGVECTOR_POSTGRES_TEST_IMAGE });
  databaseUrl = (await harness.createDatabase()).databaseUrl;
  dataDir = mkdtempSync(join(tmpdir(), 'lite-boot-'));
  mkdirSync(join(dataDir, 'workspace'), { recursive: true });

  // The pi-ai faux model answers every request; the turn gets the scripted
  // reply, background lanes an empty JSON object.
  const faux = fauxProvider({ models: [{ id: 'faux-1', contextWindow: 128_000, maxTokens: 1024 }] });
  const respond: FauxResponseStep = (context) => {
    faux.appendResponses([respond]);
    modelContexts.push(context);
    return fauxAssistantMessage(lastUserText(context).includes(USER_TEXT) ? SCRIPTED_REPLY : '{}');
  };
  faux.setResponses([respond]);
  const models = createModels();
  models.setProvider(faux.provider);
  const piRuntime = createPiModelRuntime({ models, model: faux.getModel(), apiKey: null, maxOutputTokens: 1024 });
  if (!piRuntime.ok) throw new Error('faux model runtime is invalid');
  const registry = {
    models: [companionModelRegistryEntryOf(piRuntime.value)],
  };

  // The owner files: the shipped seeds, with the Automata reviewer pointed at
  // the host model (the seed names a registry slot this host does not have).
  for (const file of ['scheduler', 'trust-policy', 'subagent-roles', 'settings']) {
    copyFileSync(join(SEED_DIR, `${file}.seed.json`), join(dataDir, `${file}.json`));
  }
  const automataPolicy = JSON.parse(readFileSync(join(SEED_DIR, 'automata-policy.seed.json'), 'utf8')) as {
    bus: { reviewer: { model: string } };
  };
  automataPolicy.bus.reviewer.model = 'host-model';
  writeFileSync(join(dataDir, 'automata-policy.json'), JSON.stringify(automataPolicy));
  const cardPath = join(dataDir, 'character-card.json');
  writeFileSync(cardPath, JSON.stringify({
    spec: 'chara_card_v2',
    spec_version: '2.0',
    data: {
      name: COMPANION_NAME,
      description: 'Boot test identity.',
      personality: 'Calm.',
      scenario: 'Boot test.',
      first_mes: 'Hello.',
      mes_example: '',
      creator: 'boot-test',
      tags: [],
    },
  }));

  const config = buildConfig(cardPath, registry);
  const innerLife = loadInnerLifeConfig({
    dataDir,
    seedDir: SEED_DIR,
    modelRegistry: registry as never,
  });

  firstHealthcheck = new Promise(resolve => {
    eventBus.on('schedule.healthcheck', event => {
      healthchecks.push({ timestamp: event.timestamp, taskCount: event.taskCount });
      resolve();
    });
  });
  eventBus.on('system.init', () => { lifecycle.push('system.init'); });
  eventBus.on('system.ready', () => { lifecycle.push('system.ready'); });

  runtime = await startCompanionRuntime({
    config,
    innerLife,
    eventBus,
    providerRuntime: companionProviderRuntimeOf(piRuntime.value) as unknown as ProviderRuntime,
    embeddingProvider: companionEmbeddingProviderOf(
      { embed: texts => Promise.resolve(ok(texts.map(vectorFor))) },
      { model: 'boot-test-embedding', dimensions: EMBEDDING_DIMS },
    ) as EmbeddingRuntimeProvider,
    textEmotionClassifier: {
      preload: () => Promise.resolve(),
      classify: () => Promise.resolve([{ label: 'neutral', score: 1 }]),
    },
    env: { CONFIG_DIR: SEED_DIR },
  });
}, INTEGRATION_TIMEOUT_MS);

afterAll(async () => {
  await runtime?.stop();
  await harness?.stop();
  if (dataDir) rmSync(dataDir, { recursive: true, force: true });
}, INTEGRATION_TIMEOUT_MS);

describe('startCompanionRuntime (Lite boot over PostgreSQL)', () => {
  it('reaches system.ready after system.init', () => {
    expect(lifecycle).toEqual(['system.init', 'system.ready']);
  });

  it('answers a turn through SubstrateAgent.handleMessage with the scripted model', async () => {
    const response = await runtime!.agentLoop.handleMessage({
      id: 'boot-msg-1',
      channelId: 'terminal:boot',
      channelType: 'terminal',
      authorId: 'boot-user',
      authorName: 'Boot User',
      content: USER_TEXT,
      timestamp: new Date(),
    });
    expect(response.content).toBe(SCRIPTED_REPLY);
    const turnCall = modelContexts.find(context => lastUserText(context).includes(USER_TEXT));
    expect(turnCall?.systemPrompt).toContain(COMPANION_NAME);
  }, INTEGRATION_TIMEOUT_MS);

  it('runs the scheduler heartbeat from the started scheduler', async () => {
    // No manual tick: the heartbeat (never run, so due) fires on the
    // scheduler's own first wake after start().
    await firstHealthcheck;
    expect(runtime!.scheduler.getTask('heartbeat')).toMatchObject({ type: 'every', intervalMs: 1_800_000 });
    expect(healthchecks[0]?.taskCount).toBe(EXPECTED_TASK_IDS.length);
  }, INTEGRATION_TIMEOUT_MS);

  it('registers the background lanes', () => {
    const ids = runtime!.scheduler.listTasks().map(task => task.id).sort();
    expect(ids).toEqual(EXPECTED_TASK_IDS);
  });

  it('creates no scaffolding schema or table', async () => {
    const pool = createPostgresPool(databaseUrl, { applicationName: 'lite-boot-inspect', max: 1 });
    try {
      const schemas = await pool.query<{ nspname: string }>(
        "SELECT nspname FROM pg_namespace WHERE nspname NOT LIKE 'pg_%' AND nspname <> 'information_schema' ORDER BY 1",
      );
      const tables = await pool.query<{ schema: string; name: string }>(
        "SELECT table_schema AS schema, table_name AS name FROM information_schema.tables WHERE table_schema NOT IN ('pg_catalog', 'information_schema') ORDER BY 1, 2",
      );
      expect(schemas.rows.map(row => row.nspname)).toEqual(['extensions', 'public']);
      const names = new Set(tables.rows.map(row => row.name));
      expect(SCAFFOLDING_TABLES.filter(name => names.has(name))).toEqual([]);
      expect(KEPT_TABLES.filter(name => !names.has(name))).toEqual([]);
    } finally {
      await pool.end();
    }
  });
});
