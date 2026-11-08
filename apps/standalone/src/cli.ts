/**
 * The standalone command line.
 *
 *   init     --config <file>                     register the configured operator (idempotent)
 *   once     --config <file> --text <message>    one operator turn [--key <idempotency key>] [--json]
 *   chat     --config <file>                     interactive turns; the scheduler runs meanwhile
 *   tick     --config <file>                     one scheduler pass (and maintenance when due) [--json]
 *   maintain --config <file>                     one memory maintenance pass [--json]
 *
 * In chat, Ctrl-C interrupts the running turn (recorded as interrupted by
 * the participant); Ctrl-C while idle, or end of input, closes the runtime.
 * Exit codes: 0 success, 1 the runtime refused or failed, 2 usage or
 * configuration error, 3 the turn was recorded as interrupted or failed.
 */
import { randomUUID } from 'node:crypto';
import { productionHost, type HostFactory } from './capabilities.ts';
import { parseLiteConfig, readSecrets, type LiteConfig, type LiteSecrets } from './config.ts';
import { invalid, ok, type CareReminder, type CoreError, type Result } from './core.ts';
import { TurnInterruption, describeError, type TurnReport } from './harness.ts';
import type { OperatorChannel } from './local-host.ts';
import { createLiteRuntime, type LiteDiagnostic, type LiteRuntime } from './runtime.ts';

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

const USAGE = 'usage: lite-standalone <init|once|chat|tick|maintain> --config <file> [--text <message>] [--key <key>] [--json]';
const COMMANDS = ['init', 'once', 'chat', 'tick', 'maintain'] as const;
type Command = (typeof COMMANDS)[number];

interface Args {
  readonly command: Command;
  readonly config: string;
  readonly text: string | null;
  readonly key: string | null;
  readonly json: boolean;
}

export async function runCli(argv: readonly string[], io: CliIo, hostFactory: HostFactory = productionHost): Promise<number> {
  const args = parseArgs(argv);
  if (!args.ok) {
    io.stderr(`${args.error}\n${USAGE}\n`);
    return 2;
  }
  const loaded = await loadConfig(args.value.config, io);
  if (!loaded.ok) {
    io.stderr(`configuration refused:\n${formatError(loaded.error)}\n`);
    return 2;
  }
  const { config } = loaded.value;
  const json = args.value.json;
  const channel: OperatorChannel = {
    reply: (text) => {
      if (!json) io.stdout(`${text}\n`);
      return Promise.resolve(ok(undefined));
    },
    reminder: (reminder: CareReminder) => {
      io.stdout(`[reminder] ${reminder.title}: ${reminder.content}\n`);
      return Promise.resolve(ok(undefined));
    },
  };
  const onDiagnostic = (diagnostic: LiteDiagnostic) => {
    if (diagnostic.kind === 'tick' && diagnostic.report.ok) return;
    io.stderr(`[diagnostic] ${JSON.stringify(diagnostic)}\n`);
  };
  const host = hostFactory({ config, secrets: loaded.value.secrets, channel, onDiagnostic });
  if (!host.ok) {
    io.stderr(`host capabilities refused:\n${formatError(host.error)}\n`);
    return 2;
  }
  const runtime = await createLiteRuntime({ config, databaseUrl: loaded.value.secrets.databaseUrl, host: host.value });
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

async function run(args: Args, runtime: LiteRuntime, io: CliIo): Promise<number> {
  const print = (value: unknown) => io.stdout(`${JSON.stringify(value, null, 2)}\n`);
  switch (args.command) {
    case 'init': {
      const operator = await runtime.ensureOperator();
      if (!operator.ok) return refused(io, operator.error);
      io.stdout(`${operator.value.created ? 'registered' : 'already registered'} operator contact ${operator.value.contactId}\n`);
      return 0;
    }
    case 'once': {
      if (args.text === null) return usage(io, 'once needs --text');
      const report = await runtime.converse({ text: args.text, idempotencyKey: args.key ?? `cli:${randomUUID()}` });
      if (!report.ok) return refused(io, report.error);
      if (args.json) print(turnSummary(report.value));
      return turnExit(report.value);
    }
    case 'tick': {
      const report = await runtime.tick();
      if (!report.ok) return refused(io, report.error);
      if (args.json) print(report.value);
      else io.stdout(`tick done${report.value.maintenance === null ? '' : ' (with maintenance)'}\n`);
      return report.value.scheduler.ok ? 0 : 1;
    }
    case 'maintain': {
      const report = await runtime.maintain();
      if (!report.ok) return refused(io, report.error);
      if (args.json) print(report.value);
      else io.stdout('maintenance done\n');
      return 0;
    }
    case 'chat':
      return chat(runtime, io);
  }
}

async function chat(runtime: LiteRuntime, io: CliIo): Promise<number> {
  runtime.startScheduler();
  let current: AbortController | null = null;
  let quit: (() => void) | null = null;
  const quitting = new Promise<void>((resolve) => {
    quit = resolve;
  });
  const unsubscribe = io.onInterrupt(() => {
    if (current !== null) current.abort(new TurnInterruption('participant'));
    else quit?.();
  });
  try {
    const lines = io.lines()[Symbol.asyncIterator]();
    for (;;) {
      const next = await Promise.race([lines.next(), quitting.then(() => ({ done: true, value: undefined }) as const)]);
      if (next.done === true) return 0;
      const text = next.value.trim();
      if (text.length === 0) continue;
      const controller = new AbortController();
      current = controller;
      const report = await runtime.converse({ text, idempotencyKey: `cli:${randomUUID()}`, signal: controller.signal });
      current = null;
      if (!report.ok) io.stderr(`turn refused: ${describeError(report.error)}\n`);
      else if (report.value.status !== 'completed') io.stderr(`[turn ${report.value.status}]\n`);
    }
  } finally {
    unsubscribe();
  }
}

function turnSummary(report: TurnReport) {
  const postTurn = report.postTurn;
  return {
    status: report.status,
    turnId: report.record.turnId,
    sessionId: report.record.sessionId,
    reply: report.reply,
    delivery: report.delivery,
    outcome: report.record.settlement?.outcome ?? null,
    usage: report.usage,
    postTurn:
      postTurn === null
        ? null
        : {
            emotion: postTurn.emotion.ok ? { ok: true, status: postTurn.emotion.value.status, trusted: postTurn.emotion.value.trusted } : { ok: false, error: postTurn.emotion.error },
            workers: postTurn.workers === null ? null : postTurn.workers.ok ? { ok: true, resumed: postTurn.workers.value.map((r) => r.id) } : { ok: false, error: postTurn.workers.error },
          },
  };
}

function turnExit(report: TurnReport): number {
  if (report.status === 'completed') return 0;
  if (report.status === 'replayed') return report.record.settlement?.outcome.kind === 'completed' ? 0 : 3;
  return 3;
}

function refused(io: CliIo, error: CoreError): number {
  io.stderr(`refused: ${describeError(error)}\n`);
  return 1;
}

function usage(io: CliIo, message: string): number {
  io.stderr(`${message}\n${USAGE}\n`);
  return 2;
}

function formatError(error: CoreError): string {
  return error.kind === 'invalid' ? error.issues.map((issue) => `  - ${issue}`).join('\n') : `  ${describeError(error)}`;
}

async function loadConfig(path: string, io: CliIo): Promise<Result<{ readonly config: LiteConfig; readonly secrets: LiteSecrets }>> {
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
    if (flag !== '--config' && flag !== '--text' && flag !== '--key') return { ok: false, error: `unknown argument ${flag ?? ''}` };
    const value = rest[i + 1];
    if (value === undefined) return { ok: false, error: `${flag} needs a value` };
    values[flag.slice(2)] = value;
    i += 1;
  }
  const config = values['config'];
  if (config === undefined) return { ok: false, error: '--config is required' };
  return { ok: true, value: { command: command as Command, config, text: values['text'] ?? null, key: values['key'] ?? null, json } };
}
