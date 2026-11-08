/**
 * A Lite runtime for the benchmarks: the conformance host (the real
 * standalone runtime, the Postgres and JSONL adapters, the Pi harness and
 * the MCP and lifecycle transports) in this process, over a throwaway
 * labelled Postgres container and temporary storage roots. The fakes are the
 * scripted counting model and a counting embedding port (a deterministic
 * hashed bag of words in a 1,536-dimension space, answered at once), so
 * embedding requests are counted beside model requests and memory writes are
 * embedded as with a configured provider. `withLiteHost` removes exactly
 * what it created.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ok, type EmbeddingPort } from '../../packages/core/src/index.ts';
import { hashEmbedding } from '../../tests/core/memory-fakes.ts';
import { ConformanceHost } from '../../tests/conformance/host/host.ts';
import { startPostgresHarness } from '../../tests/support/postgres-harness.ts';

/** The size of a common hosted embedding model's vectors (for example text-embedding-3-small). */
export const BENCH_DIMENSIONS = 1536;

/** An embedding port that counts requests and texts and answers at once with a deterministic vector. */
export class CountingEmbeddings implements EmbeddingPort {
  requests = 0;
  texts = 0;
  readonly byPurpose: Record<string, number> = {};
  embed(texts: readonly string[], attribution: Parameters<EmbeddingPort['embed']>[1]): ReturnType<EmbeddingPort['embed']> {
    this.requests += 1;
    this.texts += texts.length;
    this.byPurpose[attribution.purpose] = (this.byPurpose[attribution.purpose] ?? 0) + 1;
    return Promise.resolve(ok(texts.map((t) => hashEmbedding(t, BENCH_DIMENSIONS))));
  }
}

export async function withLiteHost<T>(run: (host: ConformanceHost, embeddings: CountingEmbeddings) => Promise<T>): Promise<T> {
  const embeddings = new CountingEmbeddings();
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
      { port: embeddings, space: { name: 'bench-space', dimensions: BENCH_DIMENSIONS } },
    );
    await host.open();
    try {
      return await run(host, embeddings);
    } finally {
      await host.close();
    }
  } finally {
    harness.stop();
    await rm(base, { recursive: true, force: true });
  }
}

/** Model calls by kind, and embedding requests, made while `work` ran. */
export async function callsDuring(host: ConformanceHost, embeddings: CountingEmbeddings, work: () => Promise<unknown>): Promise<Record<string, number>> {
  const count = (): Record<string, number> => ({
    ...host.modelCalls(),
    embedding: embeddings.requests,
    'embedded texts': embeddings.texts,
    ...Object.fromEntries(Object.entries(embeddings.byPurpose).map(([purpose, n]) => [`embedding:${purpose}`, n])),
  });
  const before = count();
  await work();
  const after = count();
  return Object.fromEntries(
    Object.entries(after)
      .map(([kind, n]): [string, number] => [kind, n - (before[kind] ?? 0)])
      .filter(([kind, n]) => !kind.startsWith('embedding:') || n > 0),
  );
}

export function environment(): Record<string, string> {
  return { node: process.version, platform: `${process.platform}-${process.arch}` };
}
