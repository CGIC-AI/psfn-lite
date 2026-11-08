/**
 * The standalone composition over a throwaway Postgres and temporary storage
 * roots, with the faux model as the only fake: every core stack, adapter and
 * the Pi harness are the production ones. Runtimes opened here are closed
 * after each test; a test may close one early to restart.
 */
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach } from 'vitest';
import { createLiteRuntime, parseLiteConfig, randomIds, runCli, type CliIo, type HostFactory, type LiteDiagnostic, type LiteRuntime } from '../../apps/standalone/src/index.ts';
import type { CareReminder, Result, TrustedTurnScope } from '../../packages/core/src/index.ts';
import { createDisabledEmbeddings } from '../../packages/pi/src/index.ts';
import { tempRoots } from '../adapters/fs-support.ts';
import { usePostgres } from '../adapters/pg-support.ts';
import { FixedClock } from '../core/fakes.ts';
import { fauxRuntime, type Brain } from '../pi/faux-brain.ts';
import { DATABASE_URL_ENV, liteConfigDocument } from './lite-config.ts';

export function useStandalone() {
  const pg = usePostgres();
  const opened: LiteRuntime[] = [];
  afterEach(async () => {
    for (const runtime of opened.splice(0)) await runtime.close();
  });

  /** A fresh database, storage roots and config file; the clock starts at midday, outside quiet hours. */
  const install = async () => {
    const roots = await tempRoots();
    const databaseUrl = await pg.database();
    const document = liteConfigDocument({ history: roots.history, workspace: roots.workspace, backups: roots.backups });
    const configPath = join(roots.base, 'lite.json');
    await writeFile(configPath, JSON.stringify(document, null, 2));
    const clock = new FixedClock();
    clock.advance(12 * 3_600_000);
    return { roots, databaseUrl, document, configPath, clock, env: { [DATABASE_URL_ENV]: databaseUrl } };
  };
  type Install = Awaited<ReturnType<typeof install>>;

  /** The host a test supplies: its clock, the faux model over `brain`, no embeddings, and a recording operator channel. */
  const fauxHost = (install: Install, brain: Brain, instance: string, options: { readonly tokensPerSecond?: number } = {}) => {
    const model = fauxRuntime(brain, options);
    const replies: string[] = [];
    const reminders: CareReminder[] = [];
    const diagnostics: LiteDiagnostic[] = [];
    const factory: HostFactory = ({ channel, onDiagnostic }) => ({
      ok: true,
      value: {
        clock: install.clock,
        ids: randomIds,
        model: model.runtime,
        embeddings: createDisabledEmbeddings(),
        channel: {
          reply: (text) => {
            replies.push(text);
            return channel.reply(text);
          },
          reminder: (reminder) => {
            reminders.push(reminder);
            return channel.reminder(reminder);
          },
        },
        instance,
        onDiagnostic: (diagnostic) => {
          diagnostics.push(diagnostic);
          onDiagnostic(diagnostic);
        },
      },
    });
    return { factory, model, replies, reminders, diagnostics };
  };

  /** A runtime built exactly as the CLI builds it, closed after the test unless closed earlier. */
  const start = async (install: Install, brain: Brain, instance: string, options: { readonly tokensPerSecond?: number } = {}) => {
    const host = fauxHost(install, brain, instance, options);
    const capabilities = host.factory({
      config: parsedConfig(install),
      secrets: { databaseUrl: install.databaseUrl, modelApiKey: null, embeddingApiKey: null },
      channel: { reply: () => Promise.resolve({ ok: true, value: undefined }), reminder: () => Promise.resolve({ ok: true, value: undefined }) },
      onDiagnostic: () => undefined,
    });
    if (!capabilities.ok) throw new Error(JSON.stringify(capabilities.error));
    const runtime = await createLiteRuntime({ config: parsedConfig(install), databaseUrl: install.databaseUrl, host: capabilities.value });
    if (!runtime.ok) throw new Error(JSON.stringify(runtime.error));
    opened.push(runtime.value);
    return { runtime: runtime.value, ...host };
  };

  /** Closes a runtime early, as a stop or restart would. */
  const stop = async (runtime: LiteRuntime) => {
    const index = opened.indexOf(runtime);
    if (index !== -1) opened.splice(index, 1);
    await runtime.close();
  };

  /** Runs the real CLI entry with captured streams. */
  const cli = async (install: Install, argv: readonly string[], factory: HostFactory, input: { readonly lines?: () => AsyncIterable<string>; readonly onInterrupt?: CliIo['onInterrupt'] } = {}) => {
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
    const code = await runCli(argv, io, factory);
    return { code, stdout, stderr };
  };

  return { install, fauxHost, start, stop, cli };
}

function parsedConfig(install: { readonly document: unknown }) {
  return unwrap(parseLiteConfig(install.document));
}

/** Dispatches as `scope` and returns the content, failing the test on a refusal. */
export async function must<T = unknown>(runtime: LiteRuntime, scope: TrustedTurnScope, tool: string, action: string, args: Record<string, unknown> = {}): Promise<T> {
  const result = await runtime.dispatcher.dispatch(scope, { tool, action, args });
  if (!result.ok) throw new Error(`${tool}.${action} failed: ${JSON.stringify(result.error)}`);
  return result.value.content as T;
}

export async function operatorScope(runtime: LiteRuntime): Promise<TrustedTurnScope> {
  return unwrap(await runtime.ingress.admit(runtime.host.operatorEvidence()));
}

export async function selfScope(runtime: LiteRuntime): Promise<TrustedTurnScope> {
  return unwrap(await runtime.internalScope('reflection'));
}

/** Every archived entry of a session, oldest first, read from the JSONL archive. */
export async function archived(runtime: LiteRuntime, sessionId: Parameters<LiteRuntime['storage']['archive']['readTail']>[0]) {
  const tail = unwrap(await runtime.storage.archive.readTail(sessionId, 1_000));
  return tail.map((e) => ({ origin: e.origin.kind, text: e.text }));
}

export function unwrap<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  return result.value;
}

/** Empties a directory without removing it: a harness reset discards everything not in durable state. */
export async function emptyDirectory(path: string): Promise<void> {
  for (const name of await readdir(path)) await rm(join(path, name), { recursive: true, force: true });
  await mkdir(path, { recursive: true });
}
