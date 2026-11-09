/**
 * The conformance host as a process a runner drives over JSON lines, so the
 * TypeScript runner and the Python runner inside the pinned Hermes drive the
 * same host, and either can kill it (SIGKILL) to crash the runtime and start
 * a successor over the same state. One process holds one companion runtime
 * (the donor's PostgreSQL readiness ledger is process-lifetime).
 *
 * Run: node --import tsx tests/conformance/fixtures/host-process.ts. The
 * first stdin line is the HostState (JSON). The process answers with one
 * line {"event":"ready", ...}, then one line per request:
 *   {"id": n, "op": "...", "args": {...}} -> {"id": n, "ok": true, "value": ..., "state": {...}}
 * Ops: pi_turn, lapse, inventory, close. It closes the runtime and exits
 * when stdin ends or on "close". Storage and databases belong to the runner.
 *
 * The donor logger writes to stdout, so protocol lines go to the process's
 * own stdout handle and every other stdout write is sent to stderr.
 */
import { createInterface } from 'node:readline';
import { ConformanceHost, type HostState } from '../host/host.ts';
import type { PlannedCall, Vars } from '../scenario.ts';

const protocol = process.stdout.write.bind(process.stdout);
process.stdout.write = process.stderr.write.bind(process.stderr) as typeof process.stdout.write;

function write(line: unknown): void {
  protocol(`${JSON.stringify(line)}\n`);
}

async function main(): Promise<void> {
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity })[Symbol.asyncIterator]();
  const first = await lines.next();
  if (first.done === true) throw new Error('no host state on stdin');
  const host = new ConformanceHost(JSON.parse(first.value) as HostState);
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
        vars: (args['vars'] as Vars | undefined) ?? {},
        key: args['key'] as string,
      });
    case 'lapse':
      return host.lapse(args['turnId'] as string);
    case 'inventory':
      return host.inventory();
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
