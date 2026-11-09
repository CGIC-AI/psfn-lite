/**
 * The standalone command line.
 *
 *   init  --config <file>                     seed the companion's owner files into dataDir (existing files are kept)
 *   once  --config <file> --text <message>    one operator turn [--json]
 *   chat  --config <file>                     interactive operator turns; the companion's scheduler runs meanwhile
 *   serve --config <file>                     run the companion and the configured transports until Ctrl-C
 *
 * In chat, Ctrl-C aborts the running turn (donor SubstrateAgent.abort); Ctrl-C
 * while idle, or end of input, closes the runtime. Exit codes: 0 success, 1
 * the runtime refused or failed, 2 usage or configuration error.
 */
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { COMPANION_SEED_DIR } from './companion.ts';
import { parseLiteConfig, readSecrets, type LiteConfig, type LiteSecrets } from './config.ts';
import { invalid, ok, type HostError, type Result } from './mcp.ts';
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

const USAGE = 'usage: lite-standalone <init|once|chat|serve> --config <file> [--text <message>] [--json]';
const COMMANDS = ['init', 'once', 'chat', 'serve'] as const;
type Command = (typeof COMMANDS)[number];

/** The companion's shipped owner-file seeds (packages/companion/config), copied as `<name>.json`. */
export const SEED_FILES = [
  'automata-policy',
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

export async function runCli(argv: readonly string[], io: CliIo, overrides: LiteRuntimeOverrides = {}): Promise<number> {
  const args = parseArgs(argv);
  if (!args.ok) {
    io.stderr(`${args.error}\n${USAGE}\n`);
    return 2;
  }
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
  }
}

/** Runs the companion and the configured transports until Ctrl-C; an external host drives its turns. */
async function serve(runtime: LiteRuntime, io: CliIo): Promise<number> {
  const { mcpUrl, lifecycleUrl } = runtime.transports;
  if (mcpUrl !== null) io.stdout(`mcp ${mcpUrl}\n`);
  if (lifecycleUrl !== null) io.stdout(`lifecycle ${lifecycleUrl}\n`);
  await new Promise<void>((resolve) => {
    const unsubscribe = io.onInterrupt(() => {
      unsubscribe();
      resolve();
    });
  });
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
