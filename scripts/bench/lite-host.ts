/**
 * A Lite runtime for the benchmarks: the conformance host (the real
 * standalone runtime, the Postgres and JSONL adapters, the Pi harness and
 * the MCP and lifecycle transports) in this process, over a throwaway
 * labelled Postgres container and temporary storage roots, with the scripted
 * counting model as the only fake. `withLiteHost` removes exactly what it
 * created.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConformanceHost } from '../../tests/conformance/host/host.ts';
import { startPostgresHarness } from '../../tests/support/postgres-harness.ts';

export async function withLiteHost<T>(run: (host: ConformanceHost) => Promise<T>): Promise<T> {
  const harness = await startPostgresHarness();
  const base = await mkdtemp(join(tmpdir(), 'lite-bench-'));
  try {
    const host = new ConformanceHost(
      {
        databaseUrl: await harness.createDatabase(),
        spareDatabaseUrl: await harness.createDatabase(),
        base,
        roots: null,
        clockMs: 0,
        credentials: null,
        ports: null,
        internalTurns: 'harness',
        generation: 0,
      },
      () => undefined,
    );
    await host.open();
    try {
      return await run(host);
    } finally {
      await host.close();
    }
  } finally {
    harness.stop();
    await rm(base, { recursive: true, force: true });
  }
}

/** Model calls by kind made while `work` ran. */
export async function callsDuring(host: ConformanceHost, work: () => Promise<unknown>): Promise<Record<string, number>> {
  const before = host.modelCalls();
  await work();
  const after = host.modelCalls();
  return Object.fromEntries(Object.entries(after).map(([kind, n]) => [kind, n - (before[kind] ?? 0)]));
}

export function environment(): Record<string, string> {
  return { node: process.version, platform: `${process.platform}-${process.arch}` };
}
