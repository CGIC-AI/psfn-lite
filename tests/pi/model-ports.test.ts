/**
 * The Pi model and embedding adapters a host hands the companion core: the
 * catalog model runtime (no ambient credentials), the core's provider
 * runtime and registry entry over it, and the core's embedding provider over
 * a host-supplied embedding port.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { builtinProviders } from '@earendil-works/pi-ai/providers/all';
import {
  companionEmbeddingProviderOf,
  companionModelRegistryEntryOf,
  companionProviderRuntimeOf,
  KEYLESS_ENDPOINT_BEARER,
  createCatalogModelRuntime,
  createEndpointModelRuntime,
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

describe('endpoint model runtime', () => {
  const servers: Server[] = [];
  afterEach(async () => {
    for (const server of servers.splice(0)) await new Promise((resolve) => server.close(resolve));
  });
  /** A local OpenAI-style chat-completions server that records each request and answers one streamed message. */
  const endpoint = async () => {
    const requests: { url: string; authorization: string | undefined; body: Record<string, unknown> }[] = [];
    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        requests.push({ url: req.url ?? '', authorization: req.headers.authorization, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown> });
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        const chunk = (delta: object, finish: string | null) => `data: ${JSON.stringify({ id: 'c1', object: 'chat.completion.chunk', created: 0, model: 'served-model', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
        res.end(`${chunk({ role: 'assistant', content: 'from the endpoint' }, null)}${chunk({}, 'stop')}data: [DONE]\n\n`);
      });
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    return { baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`, requests };
  };
  const runtimeFor = (baseUrl: string, apiKey: string | null) => {
    const runtime = createEndpointModelRuntime({ provider: 'house-server', modelId: 'served-model', baseUrl, apiKey, maxOutputTokens: 64, contextWindow: 8192 });
    if (!runtime.ok) throw new Error(JSON.stringify(runtime.error));
    return runtime.value;
  };
  const ask = { messages: [{ role: 'user' as const, content: 'hi', timestamp: 0 }] };

  it('sends the companion core\'s requests to the configured endpoint with the configured key', async () => {
    const { baseUrl, requests } = await endpoint();
    const runtime = runtimeFor(baseUrl, 'configured-endpoint-key');
    const reply = await companionProviderRuntimeOf(runtime).complete(runtime.model, ask, { maxTokens: 999_999 });
    expect(reply.content).toEqual([{ type: 'text', text: 'from the endpoint' }]);
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ url: '/v1/chat/completions', authorization: 'Bearer configured-endpoint-key', body: { model: 'served-model' } });
    expect(companionModelRegistryEntryOf(runtime).identity).toMatchObject({ provider: 'house-server', model: 'served-model' });
    expect(companionModelRegistryEntryOf(runtime).capabilities).toMatchObject({ maxOutputTokens: 64, contextWindow: 8192 });
  });

  it('sends a keyless endpoint the placeholder bearer and never an ambient key', async () => {
    const saved = process.env['OPENAI_API_KEY'];
    process.env['OPENAI_API_KEY'] = 'ambient-not-in-config';
    try {
      const { baseUrl, requests } = await endpoint();
      const runtime = runtimeFor(baseUrl, null);
      const reply = await companionProviderRuntimeOf(runtime).complete(runtime.model, ask);
      expect(reply.stopReason).toBe('stop');
      expect(requests[0]?.authorization).toBe(`Bearer ${KEYLESS_ENDPOINT_BEARER}`);
    } finally {
      if (saved === undefined) delete process.env['OPENAI_API_KEY'];
      else process.env['OPENAI_API_KEY'] = saved;
    }
  });

  it('refuses a catalog provider\'s name and malformed endpoints', () => {
    const base = { provider: 'house-server', modelId: 'served-model', baseUrl: 'http://127.0.0.1:9/v1', apiKey: null, maxOutputTokens: 64, contextWindow: 8192 };
    expect(createEndpointModelRuntime({ ...base, provider: 'openai' })).toMatchObject({ ok: false, error: { issues: ['model provider openai is a catalog provider; an endpoint needs its own provider name'] } });
    expect(createEndpointModelRuntime({ ...base, baseUrl: 'ftp://files.example' })).toMatchObject({ ok: false, error: { issues: ['an endpoint baseUrl must be an http(s) URL'] } });
    expect(createEndpointModelRuntime({ ...base, contextWindow: 0 })).toMatchObject({ ok: false, error: { issues: ['an endpoint contextWindow must be a positive integer'] } });
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
    const refusing = companionEmbeddingProviderOf({ embed: () => Promise.resolve(unavailable('embeddings', 'the host has no vectors')) }, { model: 'm', dimensions: 3 });
    expect(refusing).toMatchObject({ kind: 'api', model: 'm', dims: 3 });
    await expect(refusing.embed('x')).rejects.toThrow('Embedding provider unavailable: the host has no vectors');
    const fixed = companionEmbeddingProviderOf({ embed: (texts) => Promise.resolve(ok(texts.map(() => [1, 2, 3]))) }, { model: 'm', dimensions: 3 });
    expect(Array.from(await fixed.embed('x'))).toEqual([1, 2, 3]);
    const wrong = companionEmbeddingProviderOf({ embed: (texts) => Promise.resolve(ok(texts.map(() => [1, 2]))) }, { model: 'm', dimensions: 3 });
    await expect(wrong.embedBatch(['x'])).rejects.toThrow('Embedding 0 has 2 dimensions, expected 3');
  });
});
