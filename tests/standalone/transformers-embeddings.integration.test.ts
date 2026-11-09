/**
 * A real start with the donor's default embedding provider: no embedding
 * block and no host-supplied port, so the core builds the donor
 * TransformersEmbeddingProvider itself (provider-runtime-factory.ts,
 * createEmbeddingProviderFromConfig), loads Xenova/all-MiniLM-L6-v2 through
 * @huggingface/transformers, passes the donor's fail-closed startup warmup
 * (warmupEmbeddingProvider checks the 384 dimensions), and embeds a memory
 * the companion writes in a turn. No API key is set anywhere. The model is
 * cached under the data directory, never in the working directory.
 *
 * The first use downloads the model into the data directory (about 90 MB).
 * To run it again without a download, point LITE_TEST_TRANSFORMERS_CACHE at
 * a transformers.js cache directory that already holds the model (for
 * example a kept `<dataDir>/models/transformers`); it is copied into the new
 * data directory's default cache before the start, never used in place.
 */
import { cp, readdir, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import pg from 'pg';
import { describe, expect, it } from 'vitest';
import type { Script } from '../support/faux-model.ts';
import { dockerTestsOptedOut } from '../support/postgres-harness.ts';
import { DATABASE_URL_ENV, useLiteWorld } from '../support/lite-world.ts';

const MODEL = 'Xenova/all-MiniLM-L6-v2';
const SEED_CACHE_ENV = 'LITE_TEST_TRANSFORMERS_CACHE';
/** Starting the core plus, on a first use, downloading the model. */
const BOOT_TIMEOUT_MS = 600_000;
const REMEMBER = 'Please remember: ';

/** The operator's turn: one memory write named by the message, then the tool result as the reply. */
const script: Script = (call) => {
  if ((call.context.tools?.length ?? 0) === 0) return null;
  const messages = call.context.messages;
  const results = messages.slice(messages.map((m) => m.role).lastIndexOf('user') + 1).filter((m) => m.role === 'toolResult');
  if (results.length > 0) return results[0]!.content.map((block) => (block.type === 'text' ? block.text : '')).join('');
  if (call.lastUser.includes(REMEMBER)) {
    return { toolCalls: [{ name: 'memory', arguments: { action: 'write', text: call.lastUser.split(REMEMBER)[1] ?? '', type: 'semantic' } }] };
  }
  return null;
};

async function sizeOf(dir: string): Promise<number> {
  let total = 0;
  for (const entry of await readdir(dir, { withFileTypes: true, recursive: true })) {
    if (entry.isFile()) total += (await stat(join(entry.parentPath, entry.name))).size;
  }
  return total;
}

describe.skipIf(dockerTestsOptedOut('standalone transformers embeddings'))('the donor default embedding provider', () => {
  const lite = useLiteWorld();

  it('boots keyless on local transformers, caches the model under the data directory and embeds a memory', async () => {
    const cwdModels = join(process.cwd(), 'models');
    const cwdModelsBefore = existsSync(cwdModels);
    const install = await lite.install((document) => {
      document.embedding = undefined;
    });
    const cacheDir = join(install.dataDir, 'models', 'transformers');
    const seed = process.env[SEED_CACHE_ENV];
    if (seed !== undefined && seed !== '') await cp(seed, cacheDir, { recursive: true });

    const { runtime } = await lite.start(install, script, {}, { configuredEmbeddings: true });
    expect(runtime.config.embedding).toEqual({ model: MODEL, dimensions: 384, provider: { kind: 'transformers', cacheDir } });
    expect(existsSync(join(cacheDir, MODEL, 'onnx', 'model.onnx'))).toBe(true);
    process.stderr.write(`[lite] ${MODEL} cache: ${cacheDir} (${await sizeOf(cacheDir)} bytes)\n`);

    const written = await runtime.converse(`${REMEMBER}Robin keeps the spare key under the blue flowerpot`);
    const memoryId = /id: ([0-9a-f-]{36})/.exec(written.content)?.[1];
    expect(memoryId, written.content).toBeDefined();
    const memory = await runtime.companion.persistence.memoryStore.getById(memoryId!);
    expect(memory?.text).toContain('blue flowerpot');
    // The vector the core stored for it (faculties/memory/postgres-store: l2_memories.embedding, an unbounded pgvector column).
    const client = new pg.Client({ connectionString: install.env[DATABASE_URL_ENV] });
    await client.connect();
    try {
      const stored = await client.query<{ vector: string }>('SELECT embedding::text AS vector FROM l2_memories WHERE id = $1', [memoryId]);
      const vector = JSON.parse(stored.rows[0]?.vector ?? '[]') as number[];
      expect(vector).toHaveLength(384);
      expect(Math.hypot(...vector)).toBeCloseTo(1, 4);
    } finally {
      await client.end();
    }

    // Every embedding call went through the donor transformers provider (the core's usage accounting names its kind and model).
    const usage = runtime.modelUsage().byModel[`transformers/${MODEL}`];
    expect(usage?.calls ?? 0).toBeGreaterThan(0);
    expect(usage?.failures).toBe(0);
    expect(Object.keys(runtime.modelUsage().byModel).filter((key) => key.startsWith('api/'))).toEqual([]);
    expect(existsSync(cwdModels)).toBe(cwdModelsBefore);
  }, BOOT_TIMEOUT_MS);
});
