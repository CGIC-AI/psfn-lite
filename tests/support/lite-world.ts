/**
 * The standalone host over a throwaway Postgres and a temporary data
 * directory: the extracted companion core exactly as the CLI starts it, with
 * a faux model, deterministic embeddings and a fixed text-emotion classifier
 * as the only host-port fakes. Runtimes opened here are closed after each
 * test, the data directories removed, and the container after the file.
 */
import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { afterAll, afterEach, beforeAll } from 'vitest';
import {
  createLiteRuntime,
  parseLiteConfig,
  runCli,
  type CliIo,
  type LiteDiagnostic,
  type LiteRuntime,
  type LiteRuntimeOverrides,
} from '../../apps/standalone/src/index.ts';
import { ok, type EmbeddingPort } from '../../packages/pi/src/index.ts';
import { fauxModel, type Script } from './faux-model.ts';
import { HARNESS_START_TIMEOUT_MS, startPostgresHarness, type PostgresHarness } from './postgres-harness.ts';

export const DATABASE_URL_ENV = 'LITE_TEST_DATABASE_URL';
export const COMPANION_NAME = 'Lumen';
export const EMBEDDING_DIMS = 16;
/** Starting the companion core (migrations of every kept store) takes a while. */
export const RUNTIME_TIMEOUT_MS = 180_000;

/** Deterministic vectors: a fixed function of the text, never a stand-in for a missing provider. */
export function vectorFor(text: string): number[] {
  const vector = new Array<number>(EMBEDDING_DIMS).fill(0);
  for (let index = 0; index < text.length; index += 1) vector[index % EMBEDDING_DIMS]! += text.charCodeAt(index) / 1000;
  vector[0]! += 1;
  return vector;
}

export const deterministicEmbeddings: EmbeddingPort = { embed: (texts) => Promise.resolve(ok(texts.map(vectorFor))) };

export function liteConfigDocument(dataDir: string, companionId: string) {
  return {
    companionId,
    dataDir,
    characterCardPath: join(dataDir, 'character-card.json'),
    operator: { userId: 'robin', displayName: 'Robin' },
    contacts: [{ key: 'sam', displayName: 'Sam', trust: 'regular' }],
    postgres: { urlEnv: DATABASE_URL_ENV },
    model: { provider: 'faux', modelId: 'faux-1', apiKeyEnv: null, maxOutputTokens: 1024 },
    embedding: { model: 'test-embedding', dimensions: EMBEDDING_DIMS, provider: { kind: 'disabled' } },
    sessionIntegrity: { kind: 'unsigned' },
    mcp: null as Record<string, unknown> | null,
    lifecycle: null as Record<string, unknown> | null,
  };
}

export type LiteConfigDocument = ReturnType<typeof liteConfigDocument>;

export interface Install {
  readonly dataDir: string;
  readonly configPath: string;
  readonly document: LiteConfigDocument;
  readonly env: Record<string, string>;
}

export function useLiteWorld() {
  let harness: PostgresHarness | undefined;
  const opened: LiteRuntime[] = [];
  const dirs: string[] = [];

  beforeAll(async () => {
    harness = await startPostgresHarness();
  }, HARNESS_START_TIMEOUT_MS);
  afterEach(async () => {
    for (const runtime of opened.splice(0)) await runtime.close();
    for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
  }, RUNTIME_TIMEOUT_MS);
  afterAll(() => {
    harness?.stop();
  });

  /** The data directory the core's PostgreSQL stores expect: the donor's extension schema provisioned (as the donor's test harness did). */
  const database = async (): Promise<string> => {
    if (harness === undefined) throw new Error('postgres harness did not start');
    const url = await harness.createDatabase();
    const client = new pg.Client({ connectionString: url });
    await client.connect();
    try {
      await client.query('CREATE SCHEMA IF NOT EXISTS extensions');
    } finally {
      await client.end();
    }
    return url;
  };

  /** A fresh database, data directory (seeded by the real `init`), character card and config file. */
  const install = async (edit: (document: LiteConfigDocument) => void = () => undefined): Promise<Install> => {
    const dataDir = await mkdtemp(join(tmpdir(), 'lite-world-'));
    dirs.push(dataDir);
    const document = liteConfigDocument(dataDir, crypto.randomUUID());
    edit(document);
    const configPath = join(dataDir, 'lite.json');
    await writeFile(configPath, JSON.stringify(document, null, 2));
    await writeFile(document.characterCardPath, JSON.stringify({
      spec: 'chara_card_v2',
      spec_version: '2.0',
      data: { name: COMPANION_NAME, description: 'Test identity.', personality: 'Calm.', scenario: 'Test.', first_mes: 'Hello.', mes_example: '', creator: 'lite-test', tags: [] },
    }));
    const env = { [DATABASE_URL_ENV]: await database() };
    const seeded = await cli({ dataDir, configPath, document, env }, ['init', '--config', configPath]);
    if (seeded.code !== 0) throw new Error(`init failed: ${seeded.stderr}`);
    return { dataDir, configPath, document, env };
  };

  const overridesFor = (script: Script): { readonly overrides: LiteRuntimeOverrides; readonly model: ReturnType<typeof fauxModel> } => {
    const model = fauxModel(script);
    return {
      model,
      overrides: {
        model: model.runtime,
        embeddings: deterministicEmbeddings,
        textEmotionClassifier: { preload: () => Promise.resolve(), classify: () => Promise.resolve([{ label: 'neutral', score: 1 }]) },
      },
    };
  };

  /** A runtime built exactly as the CLI builds it, closed after the test unless closed earlier. */
  const start = async (install: Install, script: Script) => {
    const { overrides, model } = overridesFor(script);
    const config = parseLiteConfig(install.document);
    if (!config.ok) throw new Error(JSON.stringify(config.error));
    const diagnostics: LiteDiagnostic[] = [];
    const runtime = await createLiteRuntime({
      config: config.value,
      secrets: { databaseUrl: install.env[DATABASE_URL_ENV] ?? '', modelApiKey: null, embeddingApiKey: null },
      env: install.env,
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
      overrides,
    });
    if (!runtime.ok) throw new Error(JSON.stringify(runtime.error));
    opened.push(runtime.value);
    return { runtime: runtime.value, model, diagnostics };
  };

  /** Closes a runtime early, as a stop or restart would. */
  const stop = async (runtime: LiteRuntime) => {
    const index = opened.indexOf(runtime);
    if (index !== -1) opened.splice(index, 1);
    await runtime.close();
  };

  /** Runs the real CLI entry with captured streams. */
  const cli = async (
    install: Install,
    argv: readonly string[],
    input: { readonly script?: Script; readonly lines?: () => AsyncIterable<string>; readonly onInterrupt?: CliIo['onInterrupt'] } = {},
  ) => {
    let stdout = '';
    let stderr = '';
    const io: CliIo = {
      stdout: (text) => {
        stdout += text;
      },
      stderr: (text) => {
        stderr += text;
      },
      env: install.env,
      readFile: (path) => readFile(path, 'utf8'),
      lines: input.lines ?? (async function* () {}),
      onInterrupt: input.onInterrupt ?? (() => () => undefined),
    };
    const code = await runCli(argv, io, input.script === undefined ? {} : overridesFor(input.script).overrides);
    return { code, stdout, stderr };
  };

  return { install, start, stop, cli, database };
}

/** A fresh random transport credential (never a fixed test secret). */
export function newCredential(): string {
  return randomBytes(32).toString('base64url');
}
