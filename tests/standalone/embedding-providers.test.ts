/**
 * The embedding providers are the donor's own (faculties/memory/embedding.ts).
 * Each configured kind reaches its donor provider class through the substrate
 * config exactly as the runtime builds it: buildSubstrateConfig, then the
 * donor's createEmbeddingProviderFromConfig, which startCompanionRuntime calls
 * (provider-runtime-factory.ts) whenever the host supplies no embedding port.
 * Without an embedding block the donor's seeded default applies: the local,
 * keyless transformers provider, its model cached under the data directory.
 * The donor had no "disabled" kind, and Lite has none either.
 */
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { isAbsolute, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { COMPANION_SEED_DIR } from '../../apps/standalone/src/companion.ts';
import { EMBEDDING_PROVIDER_KINDS, buildSubstrateConfig, parseLiteConfig, readSecrets, type LiteConfig } from '../../apps/standalone/src/index.ts';
import {
  ApiEmbeddingProvider,
  OllamaEmbeddingProvider,
  TransformersEmbeddingProvider,
  createEmbeddingProviderFromConfig,
  resolveEmbeddingProviderProvenanceFromConfig,
} from '@cgic/psfn-core';
import { DATABASE_URL_ENV, liteConfigDocument } from '../support/lite-install.ts';

// The donor's default factories read their seeds from CONFIG_DIR, which the runtime points at the shipped seeds (runtime.ts).
process.env['CONFIG_DIR'] ??= fileURLToPath(COMPANION_SEED_DIR);
const DATA_DIR = '/srv/lite/data';
const MODEL = { modelId: 'faux-1', provider: 'faux', maxOutputTokens: 1024, contextWindow: 8192, registry: { models: [] } };
const SEED = JSON.parse(readFileSync(join(fileURLToPath(COMPANION_SEED_DIR), 'settings.seed.json'), 'utf8')) as Record<string, unknown>;

function parsed(embedding: unknown): LiteConfig {
  const document: Record<string, unknown> = { ...liteConfigDocument(DATA_DIR, crypto.randomUUID()) };
  if (embedding === undefined) delete document['embedding'];
  else document['embedding'] = embedding;
  const result = parseLiteConfig(document);
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  return result.value;
}

function issuesOf(embedding: unknown): readonly string[] {
  const result = parseLiteConfig({ ...liteConfigDocument(DATA_DIR, crypto.randomUUID()), embedding });
  return result.ok ? [] : result.error.kind === 'invalid' ? result.error.issues : [result.error.kind];
}

/** The provider and the provenance the core records with every vector, from the substrate config the runtime runs with. */
function donorProviderOf(config: LiteConfig, env: Record<string, string> = {}) {
  const substrate = buildSubstrateConfig(config, { databaseUrl: 'postgres://unused', model: MODEL });
  const provider = createEmbeddingProviderFromConfig(substrate, env);
  return { provider, provenance: resolveEmbeddingProviderProvenanceFromConfig(substrate, provider.dims) };
}

function inside(dir: string, path: string): boolean {
  const rel = relative(dir, path);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/** The donor provider's private model cache directory (TransformersEmbeddingProvider `config.cacheDir`). */
const cacheDirOf = (provider: TransformersEmbeddingProvider): string | undefined => (provider as unknown as { config: { cacheDir?: string } }).config.cacheDir;

describe('embedding providers', () => {
  const servers: { close(): void }[] = [];
  afterEach(() => {
    for (const server of servers.splice(0)) server.close();
  });

  /** A loopback embeddings endpoint recording each request. */
  async function serve(answer: (input: string[]) => unknown) {
    const seen: { path: string | undefined; auth: string | undefined; body: Record<string, unknown> }[] = [];
    const server = createServer((req, res) => {
      let raw = '';
      req.on('data', (chunk: Buffer) => (raw += chunk.toString()));
      req.on('end', () => {
        const body = JSON.parse(raw) as Record<string, unknown>;
        seen.push({ path: req.url, auth: req.headers.authorization, body });
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(answer(body['input'] as string[])));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    servers.push(server);
    return { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen };
  }

  it('offers exactly the donor kinds; "disabled" and the old Lite kind are refused by name', () => {
    for (const kind of EMBEDDING_PROVIDER_KINDS) {
      expect(() => createEmbeddingProviderFromConfig({ embeddingProvider: kind })).not.toThrow(/Unsupported EMBEDDING_PROVIDER/);
    }
    const refusal = `embedding.provider.kind must be one of ${EMBEDDING_PROVIDER_KINDS.join(', ')}`;
    for (const kind of ['disabled', 'openai_compatible']) {
      expect(() => createEmbeddingProviderFromConfig({ embeddingProvider: kind as never })).toThrow(/Unsupported EMBEDDING_PROVIDER/);
      expect(issuesOf({ model: 'm', dimensions: 3, provider: { kind } })).toEqual([refusal]);
    }
  });

  it('without an embedding block runs the donor seed default: local transformers, cached under the data directory', () => {
    const config = parsed(undefined);
    expect(SEED['embeddingProvider']).toBe('transformers');
    expect(config.embedding).toEqual({
      model: SEED['transformersModel'],
      dimensions: SEED['embeddingDims'],
      provider: { kind: 'transformers', cacheDir: join(DATA_DIR, 'models', 'transformers') },
    });
    const { provider, provenance } = donorProviderOf(config);
    expect(provider).toBeInstanceOf(TransformersEmbeddingProvider);
    expect(provenance).toEqual({ provider: 'transformers', model: 'Xenova/all-MiniLM-L6-v2', dimensions: 384 });
    expect(cacheDirOf(provider as TransformersEmbeddingProvider)).toBe(join(DATA_DIR, 'models', 'transformers'));
    expect(inside(process.cwd(), cacheDirOf(provider as TransformersEmbeddingProvider) ?? '')).toBe(false);
    // No key of any kind is read: the default runs with an empty environment.
    expect(readSecrets(config, { [DATABASE_URL_ENV]: 'postgres://x' })).toEqual({ ok: true, value: { databaseUrl: 'postgres://x', modelApiKey: null } });
  });

  it('transformers: a relative cache directory resolves under the data directory, an absolute one is kept', () => {
    const relativeCache = donorProviderOf(parsed({ model: 'Xenova/bge-small-en-v1.5', dimensions: 384, provider: { kind: 'transformers', cacheDir: 'cache/hf' } }));
    expect(relativeCache.provenance).toEqual({ provider: 'transformers', model: 'Xenova/bge-small-en-v1.5', dimensions: 384 });
    expect(cacheDirOf(relativeCache.provider as TransformersEmbeddingProvider)).toBe(join(DATA_DIR, 'cache', 'hf'));
    const absoluteCache = donorProviderOf(parsed({ model: 'Xenova/all-MiniLM-L6-v2', dimensions: 384, provider: { kind: 'transformers', cacheDir: '/var/cache/lite-models' } }));
    expect(cacheDirOf(absoluteCache.provider as TransformersEmbeddingProvider)).toBe('/var/cache/lite-models');
    expect(cacheDirOf(donorProviderOf(parsed({ model: 'Xenova/all-MiniLM-L6-v2', dimensions: 384, provider: { kind: 'transformers' } })).provider as TransformersEmbeddingProvider))
      .toBe(join(DATA_DIR, 'models', 'transformers'));
  });

  it('ollama: the donor provider posts to <url>/api/embed', async () => {
    const { base, seen } = await serve((input) => ({ embeddings: input.map((_text, index) => [index, 0, 1]) }));
    const { provider, provenance } = donorProviderOf(parsed({ model: 'nomic-embed-text', dimensions: 3, provider: { kind: 'ollama', url: base } }));
    expect(provider).toBeInstanceOf(OllamaEmbeddingProvider);
    expect(provenance).toEqual({ provider: 'ollama', model: 'nomic-embed-text', dimensions: 3 });
    expect((await provider.embedBatch(['a', 'b'])).map((vector) => Array.from(vector))).toEqual([[0, 0, 1], [1, 0, 1]]);
    expect(seen).toEqual([{ path: '/api/embed', auth: undefined, body: { model: 'nomic-embed-text', input: ['a', 'b'] } }]);
    expect(issuesOf({ model: 'm', dimensions: 3, provider: { kind: 'ollama' } })).toEqual(['embedding.provider.url is required']);
  });

  it('api: the donor provider posts to the configured endpoint with the key from the named variable', async () => {
    const { base, seen } = await serve((input) => ({ data: input.map((_text, index) => ({ index, embedding: [index, 1, 0, 0] })) }));
    const config = parsed({ model: 'text-embedding-3-small', dimensions: 4, provider: { kind: 'api', url: `${base}/v1/embeddings`, apiKeyEnv: 'LITE_EMBED_KEY' } });
    const { provider, provenance } = donorProviderOf(config, { LITE_EMBED_KEY: 'named-key', EMBEDDING_API_KEY: 'ambient-key' });
    expect(provider).toBeInstanceOf(ApiEmbeddingProvider);
    // The configured model and dimensions, never the seeded settings.json api values (snowflake-arctic-embed2, 1024).
    expect(SEED['embeddingApiModel']).not.toBe('text-embedding-3-small');
    expect(provenance).toEqual({ provider: 'api', model: 'text-embedding-3-small', dimensions: 4 });
    expect((await provider.embedBatch(['a'])).map((vector) => Array.from(vector))).toEqual([[0, 1, 0, 0]]);
    expect(seen).toEqual([{ path: '/v1/embeddings', auth: 'Bearer named-key', body: { model: 'text-embedding-3-small', input: ['a'] } }]);
    const missing = readSecrets(config, { [DATABASE_URL_ENV]: 'postgres://x' });
    expect(missing).toEqual({ ok: false, error: expect.objectContaining({ issues: ['environment variable LITE_EMBED_KEY is not set'] }) as unknown });
  });

  it('api with no named key uses the donor key variables, and sends none without them', async () => {
    const { base, seen } = await serve((input) => ({ data: input.map(() => ({ embedding: [1, 2] })) }));
    const config = parsed({ model: 'local-embed', dimensions: 2, provider: { kind: 'api', url: `${base}/embed`, apiKeyEnv: null } });
    await donorProviderOf(config, { EMBEDDING_API_KEY: 'donor-key' }).provider.embed('x');
    await donorProviderOf(config).provider.embed('y');
    expect(seen.map((request) => request.auth)).toEqual(['Bearer donor-key', undefined]);
    expect(issuesOf({ model: 'm', dimensions: 3, provider: { kind: 'api', url: `${base}/embed`, apiKeyEnv: null, timeoutMs: 1_000 } })).toEqual([
      'embedding.provider.timeoutMs is not a known setting',
    ]);
  });
});
