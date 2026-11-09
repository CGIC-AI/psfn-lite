/**
 * The Pi model and embedding adapters a host hands the companion core: the
 * catalog model runtime (no ambient credentials), the core's provider
 * runtime and registry entry over it, and the embedding ports and the core's
 * embedding provider over them.
 */
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { builtinProviders } from '@earendil-works/pi-ai/providers/all';
import {
  companionEmbeddingProviderOf,
  companionModelRegistryEntryOf,
  companionProviderRuntimeOf,
  createCatalogModelRuntime,
  createDisabledEmbeddings,
  createOpenAiCompatibleEmbeddings,
  ok,
  unavailable,
} from '../../packages/pi/src/index.ts';
import { fauxModel } from '../support/faux-model.ts';

describe('catalog model credentials', () => {
  const saved = { ANTHROPIC_API_KEY: process.env['ANTHROPIC_API_KEY'], ANTHROPIC_OAUTH_TOKEN: process.env['ANTHROPIC_OAUTH_TOKEN'] };
  afterEach(() => {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });
  const runtimeFor = (apiKey: string | null) => {
    const modelId = builtinProviders().find((p) => p.id === 'anthropic')?.getModels()[0]?.id ?? '';
    const runtime = createCatalogModelRuntime({ provider: 'anthropic', modelId, apiKey, maxOutputTokens: 16 });
    if (!runtime.ok) throw new Error(JSON.stringify(runtime.error));
    return runtime.value;
  };

  it('never picks up a credential the config did not name, from the environment or from files', async () => {
    process.env['ANTHROPIC_API_KEY'] = 'ambient-not-in-config';
    process.env['ANTHROPIC_OAUTH_TOKEN'] = 'ambient-token-not-in-config';
    const runtime = runtimeFor(null);
    expect(await runtime.models.getAuth(runtime.model)).toBeUndefined();
    // A request without a key fails closed instead of authenticating with the ambient one.
    const reply = await runtime.models.completeSimple(runtime.model, { messages: [{ role: 'user', content: 'hi', timestamp: 0 }] }, { maxTokens: 16 });
    expect(reply.stopReason).toBe('error');
    expect(reply.errorMessage).toContain('Provider is not configured: anthropic');
    expect(JSON.stringify(reply)).not.toContain('ambient');
  });

  it('authenticates with the explicit key only', async () => {
    process.env['ANTHROPIC_API_KEY'] = 'ambient-not-in-config';
    const runtime = runtimeFor('configured-key');
    const auth = await runtime.models.getAuth(runtime.model, { apiKey: 'configured-key' });
    expect(JSON.stringify(auth)).toContain('configured-key');
    expect(JSON.stringify(auth)).not.toContain('ambient');
  });
});

describe('the companion core provider seam', () => {
  it('caps every request at the host output ceiling and answers only its own provider key', async () => {
    const { runtime, calls } = fauxModel(() => 'hello');
    const provider = companionProviderRuntimeOf({ ...runtime, apiKey: 'host-key' });
    const reply = await provider.complete(runtime.model, { messages: [{ role: 'user', content: 'hi', timestamp: 0 }] }, { maxTokens: 999_999 });
    expect(reply.content).toEqual([{ type: 'text', text: 'hello' }]);
    expect(calls).toHaveLength(1);
    expect(provider.getProviders()).toEqual([runtime.model.provider]);
    expect(provider.resolveProviderApiKey(runtime.model.provider)).toBe('host-key');
    expect(provider.resolveProviderApiKey('anthropic')).toBeUndefined();
    expect(companionProviderRuntimeOf(runtime).resolveProviderApiKey(runtime.model.provider)).toBeUndefined();
  });

  it('routes every single-model purpose to the host model in one registry entry', () => {
    const { runtime } = fauxModel(() => null);
    const entry = companionModelRegistryEntryOf(runtime);
    expect(entry).toMatchObject({ id: 'host-model', rank: 1, identity: { provider: runtime.model.provider, model: runtime.model.id } });
    expect(entry.purposes.map((p) => p.purpose)).toEqual(['chat', 'background', 'memory', 'extraction', 'summary', 'reasoning', 'longContext']);
    expect(entry.capabilities).toEqual({ maxOutputTokens: 1024, contextWindow: runtime.model.contextWindow, supportsVision: runtime.model.input.includes('image') });
  });

  it('gives the core an embedding provider that throws on an unavailable port and on wrong dimensions', async () => {
    const disabled = companionEmbeddingProviderOf(createDisabledEmbeddings(), { model: 'm', dimensions: 3 });
    expect(disabled).toMatchObject({ kind: 'api', model: 'm', dims: 3 });
    await expect(disabled.embed('x')).rejects.toThrow('Embedding provider unavailable: no embedding provider is configured');
    const fixed = companionEmbeddingProviderOf({ embed: (texts) => Promise.resolve(ok(texts.map(() => [1, 2, 3]))) }, { model: 'm', dimensions: 3 });
    expect(Array.from(await fixed.embed('x'))).toEqual([1, 2, 3]);
    const wrong = companionEmbeddingProviderOf({ embed: (texts) => Promise.resolve(ok(texts.map(() => [1, 2]))) }, { model: 'm', dimensions: 3 });
    await expect(wrong.embedBatch(['x'])).rejects.toThrow('Embedding 0 has 2 dimensions, expected 3');
  });
});

describe('embeddings', () => {
  const servers: { close(): void }[] = [];
  afterEach(() => {
    for (const server of servers.splice(0)) server.close();
  });

  async function serve(answer: (body: { input: string[] }) => { status: number; body: unknown }) {
    const seen: { auth: string | undefined; body: { input: string[]; model: string; dimensions: number } }[] = [];
    const server = createServer((req, res) => {
      let raw = '';
      req.on('data', (chunk: Buffer) => (raw += chunk.toString()));
      req.on('end', () => {
        const body = JSON.parse(raw) as { input: string[]; model: string; dimensions: number };
        seen.push({ auth: req.headers.authorization, body });
        const reply = answer(body);
        res.writeHead(reply.status, { 'content-type': 'application/json' }).end(JSON.stringify(reply.body));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    servers.push(server);
    return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`, seen };
  }

  it('is unavailable when no provider is configured', async () => {
    expect(await createDisabledEmbeddings().embed(['x'])).toEqual(unavailable('embeddings', 'no embedding provider is configured'));
  });

  it('calls an OpenAI-compatible endpoint and orders vectors by index', async () => {
    const { url, seen } = await serve((body) => ({ status: 200, body: { data: body.input.map((_t, index) => ({ index, embedding: [index, 0, 1] })).reverse() } }));
    const port = createOpenAiCompatibleEmbeddings({ baseUrl: url, model: 'embed-1', dimensions: 3, apiKey: 'test-key', timeoutMs: 5_000 });
    expect(await port.embed(['a', 'b'])).toEqual(ok([[0, 0, 1], [1, 0, 1]]));
    expect(seen[0]).toEqual({ auth: 'Bearer test-key', body: { model: 'embed-1', input: ['a', 'b'], dimensions: 3 } });
  });

  it('refuses wrong dimensions and provider errors without leaking the key', async () => {
    const wrong = await serve(() => ({ status: 200, body: { data: [{ index: 0, embedding: [1, 2] }] } }));
    const port = createOpenAiCompatibleEmbeddings({ baseUrl: wrong.url, model: 'm', dimensions: 3, apiKey: 'secret-key', timeoutMs: 5_000 });
    expect(await port.embed(['a'])).toEqual(unavailable('embeddings', 'embedding 0 does not have 3 finite dimensions'));
    const failing = await serve(() => ({ status: 401, body: { error: 'bad key secret-key' } }));
    const refused = await createOpenAiCompatibleEmbeddings({ baseUrl: failing.url, model: 'm', dimensions: 3, apiKey: 'secret-key', timeoutMs: 5_000 }).embed(['a']);
    expect(refused).toEqual(unavailable('embeddings', 'provider answered 401'));
    expect(JSON.stringify(refused)).not.toContain('secret-key');
  });
});
