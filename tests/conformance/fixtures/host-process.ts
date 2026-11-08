/**
 * The conformance host as a process a runner drives over JSON lines, so the
 * TypeScript runner and the Python runner inside the pinned Hermes drive the
 * same host, and either can kill it (SIGKILL) to crash the runtime mid-turn
 * or mid-worker and start a successor over the same state.
 *
 * Run: tsx tests/conformance/fixtures/host-process.ts. The first stdin line
 * is the HostState (JSON). The process answers with one line
 * {"event":"ready", ...}, then one line per request:
 *   {"id": n, "op": "...", "args": {...}} -> {"id": n, "ok": true, "value": ..., "state": {...}}
 * Brain events ({"event":"companion_model_call"} or "worker_model_call") are
 * written as they happen. It closes the runtime and exits when stdin ends or
 * on the "close" op. Storage and databases belong to the runner.
 */
import { createInterface } from 'node:readline';
import { ConformanceHost, type HostState } from '../host/host.ts';
import type { ExtractionItem } from '../host/brain.ts';
import type { PlannedCall, Vars } from '../scenario.ts';

function write(line: unknown): void {
  process.stdout.write(`${JSON.stringify(line)}\n`);
}

async function main(): Promise<void> {
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity })[Symbol.asyncIterator]();
  const first = await lines.next();
  if (first.done === true) throw new Error('no host state on stdin');
  const state = JSON.parse(first.value) as HostState;
  const host = new ConformanceHost(state, (event) => write({ event }));
  write({ event: 'ready', ...(await host.open()) });

  const pending = new Set<Promise<void>>();
  for (;;) {
    const next = await lines.next();
    if (next.done === true) break;
    const request = JSON.parse(next.value) as { readonly id: number; readonly op: string; readonly args?: Record<string, unknown> };
    if (request.op === 'close') {
      await Promise.allSettled([...pending]);
      write({ id: request.id, ok: true, value: null, state: host.snapshot() });
      break;
    }
    // Requests run concurrently: a tick that waits on a delegated internal turn must not block the requests serving it.
    const running = serve(host, request.op, request.args ?? {}).then(
      (value) => write({ id: request.id, ok: true, value, state: host.snapshot() }),
      (error: unknown) => write({ id: request.id, ok: false, error: error instanceof Error ? error.message : String(error), state: host.snapshot() }),
    );
    pending.add(running);
    void running.finally(() => pending.delete(running));
  }
  await Promise.allSettled([...pending]);
  await host.close();
}

async function serve(host: ConformanceHost, op: string, args: Record<string, unknown>): Promise<unknown> {
  switch (op) {
    case 'pi_turn':
      return host.piTurn({
        say: args['say'] as string,
        calls: (args['calls'] as PlannedCall[] | undefined) ?? [],
        reply: (args['reply'] as string | undefined) ?? 'ok',
        hang: args['hang'] === true,
        vars: (args['vars'] as Vars | undefined) ?? {},
        key: args['key'] as string,
      });
    case 'advance':
      return host.advance(args['minutes'] as number);
    case 'tick':
      return host.tick(args as { choice?: string; reflection?: string });
    case 'maintain':
      return host.maintain((args['extract'] as ExtractionItem[] | undefined) ?? []);
    case 'consent':
      return host.consent(args as { contact: string; consent: 'granted' | 'pending' | 'denied' | 'revoked' });
    case 'worker_plan':
      return host.workerPlan(args as { calls?: PlannedCall[]; reply?: string; hang?: boolean });
    case 'dispatch':
      return host.dispatch(args as { as: 'operator' | 'self'; tool: string; action: string; args?: Record<string, unknown> });
    case 'history':
      return host.history();
    case 'backup_restore':
      return host.backupRestore();
    case 'restart':
      return host.restart();
    case 'pi_tools':
      return host.piTools();
    case 'model_calls':
      return host.modelCalls();
    case 'diagnostics':
      return host.diagnostics;
    default:
      throw new Error(`unknown host op ${op}`);
  }
}

main().then(
  () => process.exit(0),
  (error: unknown) => {
    process.stderr.write(`conformance host failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
    process.exit(1);
  },
);
