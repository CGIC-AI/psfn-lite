/**
 * The standalone command line.
 *
 *   init  --config <file>                     seed the companion's owner files into dataDir (existing files are kept)
 *   once  --config <file> --text <message>    one operator turn [--json]
 *   chat  --config <file>                     interactive operator turns; the companion's scheduler runs meanwhile
 *   serve --config <file>                     run the companion and the configured transports until Ctrl-C
 *   models --config <file>                    run the shared model service (embeddings, text emotion) until Ctrl-C;
 *                                             its config is the model service's own (model-service.ts), not a companion's
 *
 * In chat, Ctrl-C aborts the running turn (donor SubstrateAgent.abort); Ctrl-C
 * while idle, or end of input, closes the runtime. Exit codes: 0 success, 1
 * the runtime refused or failed, 2 usage or configuration error.
 */
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { COMPANION_SEED_DIR, TEXT_EMOTION_DTYPE_VALUES, TextEmotionClassifier, TransformersEmbeddingProvider, type TextEmotionDType } from './companion.ts';
import { parseLiteConfig, readSecrets, type LiteConfig, type LiteSecrets } from './config.ts';
import { invalid, ok, type HostError, type Result } from './mcp.ts';
import { parseModelServiceConfig, startModelService, type ModelService, type ModelServiceConfig, type ModelServicePorts } from './model-service.ts';
import { HOST_MODEL_ENTRY, createLiteRuntime, type LiteDiagnostic, type LiteRuntime, type LiteRuntimeOverrides } from './runtime.ts';

export interface CliIo {
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly readFile: (path: string) => Promise<string>;
  /** Operator input lines for chat. */
  readonly lines: () => AsyncIterable<string>;
  /** Subscribes to the operator's interrupt (Ctrl-C); returns the unsubscribe. */
  readonly onInterrupt: (handler: () => void) => () => void;
}

const USAGE = 'usage: lite-standalone <init|once|chat|serve|models> --config <file> [--text <message>] [--json]';
const COMMANDS = ['init', 'once', 'chat', 'serve', 'models'] as const;
type Command = (typeof COMMANDS)[number];

/** The companion's shipped owner-file seeds (packages/companion/config), copied as `<name>.json`. */
export const SEED_FILES = [
  'automata-policy',
  'capability-tier',
  'companions',
  'intake-policy',
  'runtime-prompt-layers',
  'scheduler',
  'settings',
  'subagent-roles',
  'trust-policy',
] as const;

interface Args {
  readonly command: Command;
  readonly config: string;
  readonly text: string | null;
  readonly json: boolean;
}

export async function runCli(argv: readonly string[], io: CliIo, overrides: LiteRuntimeOverrides = {}, modelPorts?: ModelServicePorts): Promise<number> {
  const args = parseArgs(argv);
  if (!args.ok) {
    io.stderr(`${args.error}\n${USAGE}\n`);
    return 2;
  }
  if (args.value.command === 'models') return models(args.value.config, io, modelPorts);
  const loaded = await loadConfig(args.value.config, io, args.value.command !== 'init');
  if (!loaded.ok) {
    io.stderr(`configuration refused:\n${formatError(loaded.error)}\n`);
    return 2;
  }
  const { config, secrets } = loaded.value;
  if (args.value.command === 'init') return init(config, io);
  if (secrets === null) return 2;
  const onDiagnostic = (diagnostic: LiteDiagnostic) => {
    if (diagnostic.kind === 'outbound') io.stdout(`[${diagnostic.channelId}] ${diagnostic.content}\n`);
    else io.stderr(`[diagnostic] ${JSON.stringify(diagnostic)}\n`);
  };
  const runtime = await createLiteRuntime({ config, secrets, env: io.env, onDiagnostic, overrides });
  if (!runtime.ok) {
    io.stderr(`the runtime could not start:\n${formatError(runtime.error)}\n`);
    return 1;
  }
  try {
    return await run(args.value, runtime.value, io);
  } finally {
    await runtime.value.close();
  }
}

/** Seeds the owner files the companion loads from its data directory; an existing file is the owner's and is kept. */
async function init(config: LiteConfig, io: CliIo): Promise<number> {
  const seedDir = fileURLToPath(COMPANION_SEED_DIR);
  await mkdir(config.dataDir, { recursive: true });
  for (const name of SEED_FILES) {
    const target = join(config.dataDir, `${name}.json`);
    if (existsSync(target)) {
      io.stdout(`kept ${target}\n`);
      continue;
    }
    const source = join(seedDir, `${name}.seed.json`);
    if (name === 'automata-policy') {
      // The seed names a reviewer model of the donor's registry; a Lite host has one model entry.
      const policy = JSON.parse(await readFile(source, 'utf8')) as { bus: { reviewer: { model: string } } };
      policy.bus.reviewer.model = HOST_MODEL_ENTRY;
      await writeFile(target, `${JSON.stringify(policy, null, 2)}\n`);
    } else {
      await copyFile(source, target);
    }
    io.stdout(`seeded ${target}\n`);
  }
  return 0;
}

async function run(args: Args, runtime: LiteRuntime, io: CliIo): Promise<number> {
  switch (args.command) {
    case 'init':
      return 0;
    case 'once': {
      if (args.text === null) return usage(io, 'once needs --text');
      try {
        const response = await runtime.converse(args.text);
        if (args.json) io.stdout(`${JSON.stringify({ reply: response.content, channelId: response.channelId }, null, 2)}\n`);
        else io.stdout(`${response.content}\n`);
        return 0;
      } catch (error) {
        io.stderr(`turn failed: ${error instanceof Error ? error.message : String(error)}\n`);
        return 1;
      }
    }
    case 'chat':
      return chat(runtime, io);
    case 'serve':
      return serve(runtime, io);
    case 'models':
      return 0;
  }
}

/** Runs the companion and the configured transports until Ctrl-C; an external host drives its turns. */
async function serve(runtime: LiteRuntime, io: CliIo): Promise<number> {
  const { mcpUrl, lifecycleUrl, gardenUrl, conversationUrl } = runtime.transports;
  if (mcpUrl !== null) io.stdout(`mcp ${mcpUrl}\n`);
  if (lifecycleUrl !== null) io.stdout(`lifecycle ${lifecycleUrl}\n`);
  if (gardenUrl !== null) io.stdout(`garden ${gardenUrl}\n`);
  if (conversationUrl !== null) io.stdout(`conversation ${conversationUrl}\n`);
  await new Promise<void>((resolve) => {
    const unsubscribe = io.onInterrupt(() => {
      unsubscribe();
      resolve();
    });
  });
  return 0;
}

/** The companion core's own model classes, as a companion would load them in-process. */
function localModelPorts(config: ModelServiceConfig): Result<ModelServicePorts> {
  if (!(TEXT_EMOTION_DTYPE_VALUES as readonly string[]).includes(config.textEmotion.dtype)) return invalid(`textEmotion.dtype must be one of ${TEXT_EMOTION_DTYPE_VALUES.join(', ')}`);
  const embedder = new TransformersEmbeddingProvider({ model: config.embedding.model, dims: config.embedding.dimensions, cacheDir: config.cacheDir });
  const classifier = new TextEmotionClassifier({ model: config.textEmotion.model, cacheDir: config.cacheDir, dtype: config.textEmotion.dtype as TextEmotionDType });
  return ok({ embed: (texts) => embedder.embedBatch(texts), classify: (text) => classifier.classify(text) });
}

/** Loads both models (a model that cannot load stops the start), then serves them until the interrupt. */
async function models(configPath: string, io: CliIo, supplied: ModelServicePorts | undefined): Promise<number> {
  let raw: unknown;
  try {
    raw = JSON.parse(await io.readFile(configPath));
  } catch {
    io.stderr(`configuration refused:\n  cannot read ${configPath} as JSON\n`);
    return 2;
  }
  const config = parseModelServiceConfig(raw);
  if (!config.ok) {
    io.stderr(`configuration refused:\n${formatError(config.error)}\n`);
    return 2;
  }
  const token = io.env[config.value.tokenEnv];
  if (token === undefined || token.trim() === '') {
    io.stderr(`configuration refused:\n  environment variable ${config.value.tokenEnv} is not set\n`);
    return 2;
  }
  const ports = supplied === undefined ? localModelPorts(config.value) : ok(supplied);
  if (!ports.ok) {
    io.stderr(`configuration refused:\n${formatError(ports.error)}\n`);
    return 2;
  }
  let service: ModelService;
  try {
    const [vector] = await ports.value.embed(['model service start']);
    if (vector?.length !== config.value.embedding.dimensions) throw new Error(`the embedding model returns ${vector?.length ?? 0} dimensions, not the configured ${config.value.embedding.dimensions}`);
    await ports.value.classify('model service start');
    service = await startModelService({
      config: config.value,
      token,
      ports: ports.value,
      onError: (route, error) => io.stderr(`[models] ${route} failed: ${error instanceof Error ? error.message : String(error)}\n`),
    });
  } catch (error) {
    io.stderr(`the model service could not start: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
  io.stdout(`models ${service.url}\n`);
  await new Promise<void>((resolve) => {
    const unsubscribe = io.onInterrupt(() => {
      unsubscribe();
      resolve();
    });
  });
  await service.close();
  return 0;
}

async function chat(runtime: LiteRuntime, io: CliIo): Promise<number> {
  let running = false;
  let quit: (() => void) | null = null;
  const quitting = new Promise<void>((resolve) => {
    quit = resolve;
  });
  const unsubscribe = io.onInterrupt(() => {
    if (running) runtime.interrupt();
    else quit?.();
  });
  try {
    const lines = io.lines()[Symbol.asyncIterator]();
    for (;;) {
      const next = await Promise.race([lines.next(), quitting.then(() => ({ done: true, value: undefined }) as const)]);
      if (next.done === true) return 0;
      const text = next.value.trim();
      if (text.length === 0) continue;
      running = true;
      try {
        const response = await runtime.converse(text);
        io.stdout(`${response.content}\n`);
      } catch (error) {
        io.stderr(`turn failed: ${error instanceof Error ? error.message : String(error)}\n`);
      } finally {
        running = false;
      }
    }
  } finally {
    unsubscribe();
  }
}

function usage(io: CliIo, message: string): number {
  io.stderr(`${message}\n${USAGE}\n`);
  return 2;
}

function formatError(error: HostError): string {
  switch (error.kind) {
    case 'invalid':
      return error.issues.map((issue) => `  - ${issue}`).join('\n');
    case 'unavailable':
      return `  ${error.capability}: ${error.detail}`;
    case 'denied':
    case 'conflict':
      return `  ${error.reason}: ${error.detail}`;
    case 'not_found':
      return `  ${error.subject} not found`;
  }
}

async function loadConfig(path: string, io: CliIo, withSecrets: boolean): Promise<Result<{ readonly config: LiteConfig; readonly secrets: LiteSecrets | null }>> {
  let text: string;
  try {
    text = await io.readFile(path);
  } catch {
    return invalid(`cannot read the config file ${path}`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return invalid('the config file is not valid JSON');
  }
  const config = parseLiteConfig(raw);
  if (!config.ok) return config;
  if (!withSecrets) return ok({ config: config.value, secrets: null });
  const secrets = readSecrets(config.value, io.env);
  if (!secrets.ok) return secrets;
  return ok({ config: config.value, secrets: secrets.value });
}

function parseArgs(argv: readonly string[]): { ok: true; value: Args } | { ok: false; error: string } {
  const [command, ...rest] = argv;
  if (!(COMMANDS as readonly (string | undefined)[]).includes(command)) return { ok: false, error: command === undefined ? 'no command given' : `unknown command ${command}` };
  const values: Record<string, string> = {};
  let json = false;
  for (let i = 0; i < rest.length; i += 1) {
    const flag = rest[i];
    if (flag === '--json') {
      json = true;
      continue;
    }
    if (flag !== '--config' && flag !== '--text') return { ok: false, error: `unknown argument ${flag ?? ''}` };
    const value = rest[i + 1];
    if (value === undefined) return { ok: false, error: `${flag} needs a value` };
    values[flag.slice(2)] = value;
    i += 1;
  }
  const config = values['config'];
  if (config === undefined) return { ok: false, error: '--config is required' };
  return { ok: true, value: { command: command as Command, config, text: values['text'] ?? null, json } };
}
