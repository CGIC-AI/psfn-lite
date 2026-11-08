/**
 * The model-facing pieces of the Pi harness: attributed rendering, the
 * inventory as Pi tools, core's inference ports over pi-ai, and the
 * embedding capability. Failures must surface as `unavailable`, never as an
 * empty success.
 */
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { TOOL_INVENTORY, ok, unavailable, type ToolCall } from '../../packages/core/src/index.ts';
import {
  createDisabledEmbeddings,
  createOpenAiCompatibleEmbeddings,
  createPiAffectEstimator,
  createPiModelPort,
  piTools,
  ToolRefusal,
} from '../../packages/pi/src/index.ts';
import { toModelMessages } from '../../packages/pi/src/render.ts';
import { AFFECT_JSON, fauxRuntime, providerError, say } from './faux-brain.ts';

const ATTRIBUTION = { purpose: 'test.summary', turnId: null, output: 'machine_inference' } as const;

describe('attributed rendering', () => {
  const { runtime } = fauxRuntime(() => say('unused'));

  it('renders only companion speech as the assistant and labels all internal context in the user position', () => {
    const messages = toModelMessages(
      [
        { role: 'labelled_context', label: 'system note: history', text: 'a session began' },
        { role: 'participant', label: null, text: 'hello' },
        { role: 'companion', label: null, text: 'hi' },
        { role: 'companion', label: null, text: 'again' },
        { role: 'labelled_context', label: 'tool result: memory.search', text: '{"memories":[]}' },
        { role: 'labelled_context', label: 'machine inference: emotion.appraisal', text: 'calm' },
      ],
      runtime.model,
      0,
    );
    expect(messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
    expect(messages[0]?.content).toBe('[system note: history]\na session began\n\nhello');
    expect(messages[1]?.role === 'assistant' && messages[1].content).toEqual([
      { type: 'text', text: 'hi' },
      { type: 'text', text: 'again' },
    ]);
    expect(messages[2]?.content).toBe('[tool result: memory.search]\n{"memories":[]}\n\n[machine inference: emotion.appraisal]\ncalm');
  });

  it('never starts with the assistant', () => {
    const messages = toModelMessages([{ role: 'companion', label: null, text: 'where were we' }], runtime.model, 0);
    expect(messages.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(messages[0]?.content).toContain('[system note: history]');
  });
});

describe('the inventory as Pi tools', () => {
  it('offers one tool per domain tool with its actions as an enum, and passes calls through the invoker', async () => {
    const calls: ToolCall[] = [];
    const tools = piTools(TOOL_INVENTORY, (_id, call) => {
      calls.push(call);
      return Promise.resolve(ok({ origin: { kind: 'tool_result', tool: call.tool, action: call.action }, content: { echoed: call.args } }));
    }, () => true, { maxResultChars: 1_000 });
    expect(tools.map((t) => t.name)).toEqual(TOOL_INVENTORY.map((t) => t.name));
    const memory = tools.find((t) => t.name === 'memory');
    const actions = TOOL_INVENTORY.find((t) => t.name === 'memory')?.actions.map((a) => a.name) ?? [];
    for (const action of actions) expect(JSON.stringify(memory?.parameters)).toContain(`"${action}"`);
    const result = await memory?.execute('call-1', { action: 'search', args: { query: 'q' } });
    expect(calls).toEqual([{ tool: 'memory', action: 'search', args: { query: 'q' } }]);
    expect(result?.content).toEqual([{ type: 'text', text: '{"echoed":{"query":"q"}}' }]);
  });

  it('offers only allowed actions, and throws a labelled refusal for a refused call', async () => {
    const tools = piTools(TOOL_INVENTORY, () => Promise.resolve(unavailable('x', 'down')), (tool, action) => tool === 'memory' && action === 'search', { maxResultChars: 1_000 });
    expect(tools.map((t) => t.name)).toEqual(['memory']);
    expect(JSON.stringify(tools[0]?.parameters)).not.toContain('"write"');
    await expect(tools[0]?.execute('call-1', { action: 'search', args: {} })).rejects.toBeInstanceOf(ToolRefusal);
    await expect(tools[0]?.execute('call-1', { action: 'search', args: {} })).rejects.toThrow('memory.search was refused: unavailable (x): down');
  });

  it('cuts an oversized result and says so', async () => {
    const tools = piTools(TOOL_INVENTORY, (_id, call) => Promise.resolve(ok({ origin: { kind: 'tool_result', tool: call.tool, action: call.action }, content: 'x'.repeat(500) })), () => true, { maxResultChars: 100 });
    const result = await tools[0]?.execute('call-1', { action: tools[0].name === 'orient' ? 'view' : 'list' });
    const text = result?.content[0]?.type === 'text' ? result.content[0].text : '';
    expect(text.startsWith('"xxx')).toBe(true);
    expect(text).toContain('[tool result cut: 402 more characters not shown]');
  });
});

describe('inference ports over pi-ai', () => {
  it('completes a machine task, labelling the context and reporting usage', async () => {
    const { runtime, calls } = fauxRuntime(() => say('a summary'));
    const done = await createPiModelPort(runtime).complete({ attribution: ATTRIBUTION, messages: [{ role: 'labelled_context', label: 'system note: x', text: 'body' }], maxOutputTokens: 50 });
    expect(done).toMatchObject({ ok: true, value: { text: 'a summary' } });
    expect(calls[0]?.systemPrompt).toContain('Task: test.summary');
    expect(calls[0]?.lastUser).toBe('[system note: x]\nbody');
  });

  it('reports a provider failure as unavailable, not as empty text', async () => {
    const { runtime } = fauxRuntime(() => providerError('rate limited'));
    const done = await createPiModelPort(runtime).complete({ attribution: ATTRIBUTION, messages: [{ role: 'participant', label: null, text: 'x' }], maxOutputTokens: 50 });
    expect(done).toEqual(unavailable('model', 'model request error: rate limited'));
  });

  it('returns the estimator JSON with the producer, and refuses text that is not a JSON object', async () => {
    const good = fauxRuntime(() => say(`\`\`\`json\n${AFFECT_JSON}\n\`\`\``));
    const reading = await createPiAffectEstimator(good.runtime).estimate({ purpose: 'emotion.observe', turnId: 'turn-1' as never, messages: [{ role: 'participant', label: null, text: 'hi' }] });
    expect(reading).toEqual(ok({ vad: { valence: 0.5, arousal: 0.2, dominance: 0.1 }, discrete: { warmth: 0.7 }, confidence: 0.9, producer: 'pi:faux/faux-1' }));
    const bad = fauxRuntime(() => say('I feel fine'));
    const refused = await createPiAffectEstimator(bad.runtime).estimate({ purpose: 'emotion.observe', turnId: 'turn-1' as never, messages: [{ role: 'participant', label: null, text: 'hi' }] });
    expect(refused).toEqual(unavailable('affect_estimator', 'the estimate was not a JSON object'));
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
    expect(await createDisabledEmbeddings().embed(['x'], ATTRIBUTION)).toEqual(unavailable('embeddings', 'no embedding provider is configured'));
  });

  it('calls an OpenAI-compatible endpoint and orders vectors by index', async () => {
    const { url, seen } = await serve((body) => ({ status: 200, body: { data: body.input.map((_t, index) => ({ index, embedding: [index, 0, 1] })).reverse() } }));
    const port = createOpenAiCompatibleEmbeddings({ baseUrl: url, model: 'embed-1', dimensions: 3, apiKey: 'test-key', timeoutMs: 5_000 });
    expect(await port.embed(['a', 'b'], ATTRIBUTION)).toEqual(ok([[0, 0, 1], [1, 0, 1]]));
    expect(seen[0]).toEqual({ auth: 'Bearer test-key', body: { model: 'embed-1', input: ['a', 'b'], dimensions: 3 } });
  });

  it('refuses wrong dimensions and provider errors without leaking the key', async () => {
    const wrong = await serve(() => ({ status: 200, body: { data: [{ index: 0, embedding: [1, 2] }] } }));
    const port = createOpenAiCompatibleEmbeddings({ baseUrl: wrong.url, model: 'm', dimensions: 3, apiKey: 'secret-key', timeoutMs: 5_000 });
    expect(await port.embed(['a'], ATTRIBUTION)).toEqual(unavailable('embeddings', 'embedding 0 does not have 3 finite dimensions'));
    const failing = await serve(() => ({ status: 401, body: { error: 'bad key secret-key' } }));
    const refused = await createOpenAiCompatibleEmbeddings({ baseUrl: failing.url, model: 'm', dimensions: 3, apiKey: 'secret-key', timeoutMs: 5_000 }).embed(['a'], ATTRIBUTION);
    expect(refused).toEqual(unavailable('embeddings', 'provider answered 401'));
    expect(JSON.stringify(refused)).not.toContain('secret-key');
  });
});
