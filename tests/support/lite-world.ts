/**
 * The standalone host over a throwaway Postgres and a temporary data
 * directory: the extracted companion core exactly as the CLI starts it, with
 * a faux model, deterministic embeddings and a fixed text-emotion classifier
 * as the only host-port fakes.
 *
 * The donor runs one companion runtime per process: its PostgreSQL store
 * readiness ledger is process-lifetime and sealed at Ready
 * (persistence/postgres/runtime-readiness.ts:375-380), so a second
 * `startCompanionRuntime` in the same process is refused. A test file
 * therefore starts at most one runtime (vitest runs each file in its own
 * module graph); the runtime, the data directories and the container are
 * removed after the file.
 */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll } from 'vitest';
import {
  createLiteRuntime,
  parseLiteConfig,
  runCli,
  type CliIo,
  type LiteDiagnostic,
  type LiteRuntime,
  type LiteRuntimeOverrides,
} from '../../apps/standalone/src/index.ts';
import { deterministicEmbeddings } from './embeddings.ts';
import { DATABASE_URL_ENV, liteConfigDocument, provisionDatabase, writeCharacterCard, type LiteConfigDocument } from './lite-install.ts';
import { fauxModel, type Script } from './faux-model.ts';
import { HARNESS_START_TIMEOUT_MS, startPostgresHarness, type PostgresHarness } from './postgres-harness.ts';

export { COMPANION_NAME, DATABASE_URL_ENV, liteConfigDocument, newCredential, type LiteConfigDocument } from './lite-install.ts';
export { EMBEDDING_DIMS, deterministicEmbeddings, vectorFor } from './embeddings.ts';
/** Starting the companion core (migrations of every kept store) takes a while. */
export const RUNTIME_TIMEOUT_MS = 180_000;

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
  afterAll(async () => {
    for (const runtime of opened.splice(0)) await runtime.close();
    for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
    harness?.stop();
  }, RUNTIME_TIMEOUT_MS);

  /** The data directory the core's PostgreSQL stores expect: the donor's extension schema provisioned (as the donor's test harness did). */
  const database = async (): Promise<string> => {
    if (harness === undefined) throw new Error('postgres harness did not start');
    return provisionDatabase(await harness.createDatabase());
  };

  /** A fresh database, data directory (seeded by the real `init`), character card and config file. */
  const install = async (edit: (document: LiteConfigDocument) => void = () => undefined): Promise<Install> => {
    const dataDir = await mkdtemp(join(tmpdir(), 'lite-world-'));
    const document = liteConfigDocument(dataDir, crypto.randomUUID());
    dirs.push(dataDir, document.workspaceDir);
    edit(document);
    const configPath = join(dataDir, 'lite.json');
    await writeFile(configPath, JSON.stringify(document, null, 2));
    await writeCharacterCard(document.characterCardPath);
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

  /** The file's one runtime, built exactly as the CLI builds it, closed after the file unless closed earlier. */
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
