/**
 * Lite's own turn latency and memory: wall time of participant turns on the
 * Pi harness (Postgres, the JSONL archive, context assembly, governed tool
 * dispatch, post-turn emotion), of idle scheduler ticks, and the process's
 * resident set size, with a scripted model that answers at once. It measures
 * Lite's overhead per turn, not a provider's latency.
 *
 * Run: tsx scripts/bench/latency.ts [--turns N] [--json]
 * Needs Docker (a throwaway labelled pgvector container).
 */
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { setTimeout as sleep } from 'node:timers/promises';
import { HostProcess } from '../../tests/conformance/host-client.ts';
import type { PlannedCall } from '../../tests/conformance/scenario.ts';
import { startPostgresHarness } from '../../tests/support/postgres-harness.ts';
import { environment, withLiteHost } from './lite-host.ts';

const IDLE_SAMPLE_SECONDS = 30;

/** VmRSS of a process, from /proc (Linux). */
async function rssOf(pid: number): Promise<number> {
  const status = await readFile(`/proc/${String(pid)}/status`, 'utf8');
  const kib = /^VmRSS:\s+(\d+) kB$/m.exec(status)?.[1];
  if (kib === undefined) throw new Error(`no VmRSS for ${String(pid)}`);
  return Number(kib) * 1024;
}

/**
 * The resident set of a Lite runtime process of its own (the conformance host
 * process: node with tsx's loader, the standalone runtime, both transports)
 * idling with nothing due, sampled each second, as the donor's idle agent is
 * sampled in docs/footprint.md.
 */
async function idleProcessRss(): Promise<Record<string, number>> {
  const harness = await startPostgresHarness();
  const base = await mkdtemp(join(tmpdir(), 'lite-bench-'));
  try {
    const host = await HostProcess.start({
      databaseUrl: await harness.createDatabase(),
      spareDatabaseUrl: await harness.createDatabase(),
      base,
      roots: null,
      clockMs: 0,
      credentials: null,
      ports: null,
      internalTurns: 'harness',
      generation: 0,
    });
    try {
      const pid = host.pid;
      if (pid === undefined) throw new Error('the host process has no pid');
      const afterOpen = await rssOf(pid);
      // The first tick runs and answers the first free-time invitations; after that nothing is due for hours.
      await host.request('tick', { choice: 'rest' });
      const samples: number[] = [];
      for (let i = 0; i < IDLE_SAMPLE_SECONDS; i += 1) {
        await host.request('advance', { minutes: 1 });
        await host.request('tick', { choice: 'rest' });
        samples.push(await rssOf(pid));
        await sleep(1_000);
      }
      const calls = await host.request<Record<string, number>>('model_calls');
      return { afterOpenMiB: mib(afterOpen), idleMaxMiB: mib(Math.max(...samples)), idleLastMiB: mib(samples.at(-1) ?? 0), seconds: IDLE_SAMPLE_SECONDS, modelCallsTotal: Object.values(calls).reduce((a, b) => a + b, 0) };
    } finally {
      await host.close();
    }
  } finally {
    harness.stop();
    await rm(base, { recursive: true, force: true });
  }
}

const WARMUP_TURNS = 5;

function stats(samples: readonly number[]): Record<string, number> {
  const sorted = [...samples].sort((a, b) => a - b);
  const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? Number.NaN;
  const round = (v: number) => Math.round(v * 10) / 10;
  return { n: sorted.length, p50: round(at(0.5)), p95: round(at(0.95)), max: round(sorted.at(-1) ?? Number.NaN), mean: round(sorted.reduce((s, v) => s + v, 0) / sorted.length) };
}

const mib = (bytes: number) => Math.round((bytes / 1_048_576) * 10) / 10;

async function main(argv: readonly string[]): Promise<void> {
  const index = argv.indexOf('--turns');
  const turns = index === -1 ? 100 : Number(argv[index + 1]);
  if (!Number.isInteger(turns) || turns < 1) throw new Error('--turns must be a positive integer');
  const rssAtStart = process.memoryUsage().rss;
  const opened = performance.now();
  const result = await withLiteHost(async (host) => {
    const openMs = performance.now() - opened;
    const rssOpen = process.memoryUsage().rss;
    let n = 0;
    const timed = async (calls: readonly PlannedCall[]) => {
      n += 1;
      const started = performance.now();
      const report = await host.piTurn({ say: `message number ${String(n)} about the garden`, calls, reply: 'Noted.', hang: false, vars: {}, key: `latency-${String(n)}` });
      if (report.status !== 'completed') throw new Error(`turn ${String(n)} ended ${String(report.status)}`);
      return performance.now() - started;
    };
    for (let i = 0; i < WARMUP_TURNS; i += 1) await timed([]);
    const plain: number[] = [];
    for (let i = 0; i < turns; i += 1) plain.push(await timed([]));
    const withTools: number[] = [];
    for (let i = 0; i < Math.max(1, Math.floor(turns / 5)); i += 1) {
      withTools.push(
        await timed([
          { tool: 'memory', action: 'write', args: { writeId: `latency-${String(i)}`, kind: 'fact', content: `Robin planted row ${String(i)}`, sensitivity: 'personal' } },
          { tool: 'memory', action: 'search', args: { query: 'planted row' } },
          { tool: 'session', action: 'messages' },
        ]),
      );
    }
    const rssAfterTurns = process.memoryUsage().rss;
    const ticks: number[] = [];
    host.advance(1);
    for (let i = 0; i < 50; i += 1) {
      const started = performance.now();
      await host.tick({ choice: 'rest' });
      ticks.push(performance.now() - started);
    }
    return {
      openMs: Math.round(openMs),
      turnMs: stats(plain),
      turnWithThreeToolCallsMs: stats(withTools),
      idleTickMs: stats(ticks),
      rssMiB: { processStart: mib(rssAtStart), runtimeOpen: mib(rssOpen), afterTurns: mib(rssAfterTurns), peak: mib(process.resourceUsage().maxRSS * 1024) },
      heapUsedMiB: mib(process.memoryUsage().heapUsed),
      historyEntries: (await host.history('operator')).length,
    };
  });
  const out = { environment: environment(), warmupTurns: WARMUP_TURNS, ...result, idleRuntimeProcess: await idleProcessRss() };
  process.stdout.write(`${JSON.stringify(out, null, argv.includes('--json') ? 2 : 1)}\n`);
}

main(process.argv.slice(2)).then(
  () => process.exit(0),
  (error: unknown) => {
    process.stderr.write(`${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
    process.exit(1);
  },
);
