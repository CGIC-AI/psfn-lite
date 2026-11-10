/**
 * The conversation transport over a real socket, with the companion's side
 * as a scripted port: who may speak, one turn at a time, interruption, and
 * the outbound stream's replay.
 */
import { request } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { createConversationOutbox, startConversationServer, type ConversationErrorReport, type ConversationPort, type ConversationServer } from '../../packages/conversation/src/index.ts';

const CREDENTIAL = 'c'.repeat(40);
const servers: ConversationServer[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) await server.close();
});

async function start(port: Partial<ConversationPort> = {}, extra: { maxBodyBytes?: number; capacity?: number } = {}) {
  const outbox = createConversationOutbox({ capacity: extra.capacity ?? 8, epoch: 'epoch-a', now: () => 1_000 });
  const errors: ConversationErrorReport[] = [];
  const server = await startConversationServer({
    port: { converse: (message) => Promise.resolve({ reply: `heard: ${message}`, channelId: 'terminal:robin' }), interrupt: () => undefined, ...port },
    outbox,
    identify: (credential) => (credential === CREDENTIAL ? 'voice-host' : null),
    listenPort: 0,
    maxBodyBytes: extra.maxBodyBytes ?? 65_536,
    onError: (report) => errors.push(report),
  });
  if (!server.ok) throw new Error(JSON.stringify(server.error));
  servers.push(server.value);
  return { url: server.value.url, outbox, errors, server: server.value };
}

async function call(url: string, method: string, path: string, init: { body?: unknown; credential?: string | null; headers?: Record<string, string> } = {}) {
  const credential = init.credential === undefined ? CREDENTIAL : init.credential;
  const response = await fetch(`${url}${path}`, {
    method,
    headers: { ...(credential === null ? {} : { Authorization: `Bearer ${credential}` }), ...init.headers },
    ...(init.body === undefined ? {} : { body: typeof init.body === 'string' ? init.body : JSON.stringify(init.body) }),
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

/** Reads server-sent events until `count` named events arrived, then closes the stream. */
function readEvents(url: string, path: string, count: number): Promise<{ event: string; data: Record<string, unknown> }[]> {
  return new Promise((resolve, reject) => {
    const target = new URL(`${url}${path}`);
    const events: { event: string; data: Record<string, unknown> }[] = [];
    const req = request({ host: target.hostname, port: target.port, path: `${target.pathname}${target.search}`, headers: { Authorization: `Bearer ${CREDENTIAL}` } }, (res) => {
      let buffer = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => {
        buffer += chunk;
        for (;;) {
          const end = buffer.indexOf('\n\n');
          if (end === -1) break;
          const block = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          const event = /^event: (.+)$/m.exec(block)?.[1];
          const data = /^data: (.+)$/m.exec(block)?.[1];
          if (event !== undefined && data !== undefined) events.push({ event, data: JSON.parse(data) as Record<string, unknown> });
          if (events.length === count) {
            req.destroy();
            resolve(events);
          }
        }
      });
    });
    req.on('error', (error) => (events.length === count ? undefined : reject(error)));
    req.end();
  });
}

describe('conversation transport', () => {
  it('serves only a bound credential, on its own Host, and never a browser', async () => {
    const { url } = await start();
    expect((await call(url, 'GET', '/health')).body).toEqual({ ok: true });
    expect((await call(url, 'GET', '/health', { credential: null })).status).toBe(401);
    expect((await call(url, 'GET', '/health', { credential: 'x'.repeat(40) })).status).toBe(401);
    expect((await call(url, 'GET', '/health', { headers: { Origin: 'https://app.example' } })).status).toBe(403);
    expect((await call(url, 'GET', '/nothing')).status).toBe(404);
    const foreign = await new Promise<number>((resolve, reject) => {
      const target = new URL(url);
      request({ host: target.hostname, port: target.port, path: `${target.pathname}/health`, headers: { Host: 'voice.example', Authorization: `Bearer ${CREDENTIAL}` } }, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      }).on('error', reject).end();
    });
    expect(foreign).toBe(403);
  });

  it('refuses a non-loopback bind that names no Host', async () => {
    const refused = await startConversationServer({
      port: { converse: () => Promise.reject(new Error('unused')), interrupt: () => undefined },
      outbox: createConversationOutbox({ capacity: 1, epoch: 'e' }),
      identify: () => null,
      listenPort: 0,
      listenHost: '0.0.0.0',
      maxBodyBytes: 1_024,
      onError: () => undefined,
    });
    expect(refused).toMatchObject({ ok: false, error: { kind: 'invalid' } });
  });

  it('runs a turn and answers with the companion\'s reply', async () => {
    const { url } = await start();
    expect(await call(url, 'POST', '/turns', { body: { message: 'good morning' } })).toEqual({ status: 200, body: { reply: 'heard: good morning', channelId: 'terminal:robin' } });
  });

  it('refuses malformed turns and oversized bodies', async () => {
    const { url } = await start({}, { maxBodyBytes: 64 });
    expect(await call(url, 'POST', '/turns', { body: '{' })).toEqual({ status: 400, body: { error: 'invalid', issues: ['the body is not valid JSON'] } });
    expect(await call(url, 'POST', '/turns', { body: { message: ' ', speaker: 'sam' } })).toEqual({ status: 400, body: { error: 'invalid', issues: ['speaker is not a known field', 'message must be a non-empty string'] } });
    expect((await call(url, 'POST', '/turns', { body: { message: 'x'.repeat(200) } })).status).toBe(413);
  });

  it('runs one turn at a time, and interrupts the running one', async () => {
    let finish: (reply: string) => void = () => undefined;
    let interrupts = 0;
    const { url } = await start({
      converse: () => new Promise((resolve) => (finish = (reply) => resolve({ reply, channelId: 'terminal:robin' }))),
      interrupt: () => {
        interrupts += 1;
        finish('');
      },
    });
    expect((await call(url, 'POST', '/interrupt')).body).toEqual({ interrupted: false });
    const first = call(url, 'POST', '/turns', { body: { message: 'a long question' } });
    await expect.poll(async () => (await call(url, 'POST', '/turns', { body: { message: 'a second one' } })).status).toBe(409);
    expect((await call(url, 'POST', '/interrupt')).body).toEqual({ interrupted: true });
    expect(await first).toEqual({ status: 200, body: { reply: '', channelId: 'terminal:robin' } });
    expect(interrupts).toBe(1);
    // The transport is free again once the turn ended.
    finish = () => undefined;
  });

  it('reports a failed turn to the operator and tells the caller only that it failed', async () => {
    const { url, errors } = await start({ converse: () => Promise.reject(new Error('provider said: secret detail')) });
    expect(await call(url, 'POST', '/turns', { body: { message: 'hello' } })).toEqual({ status: 502, body: { error: 'turn_failed' } });
    expect(errors).toEqual([{ route: 'POST /conversation/v1/turns', principal: 'voice-host', error: { kind: 'turn_failed', message: 'provider said: secret detail' } }]);
    expect((await call(url, 'POST', '/turns', { body: { message: 'again' } })).status).toBe(502);
  });

  it('streams what the companion sends on her own, replaying from the reader\'s position', async () => {
    const { url, outbox } = await start({}, { capacity: 2 });
    outbox.publish('terminal:robin', 'one');
    outbox.publish('terminal:robin', 'two');
    outbox.publish('terminal:robin', 'three');
    // The log holds the last two; a new reader is told the oldest it can get.
    const fresh = readEvents(url, '/events', 4);
    setTimeout(() => outbox.publish('terminal:robin', 'four'), 50);
    expect(await fresh).toEqual([
      { event: 'hello', data: { epoch: 'epoch-a', oldest: 2 } },
      { event: 'outbound', data: { seq: 2, channelId: 'terminal:robin', content: 'two', at: 1_000 } },
      { event: 'outbound', data: { seq: 3, channelId: 'terminal:robin', content: 'three', at: 1_000 } },
      { event: 'outbound', data: { seq: 4, channelId: 'terminal:robin', content: 'four', at: 1_000 } },
    ]);
    // A reader that saw 3 gets only what came after; a position from another process's log starts over.
    expect((await readEvents(url, '/events?after=3&epoch=epoch-a', 2)).map((e) => e.data['seq'] ?? e.data['oldest'])).toEqual([3, 4]);
    expect((await readEvents(url, '/events?after=3&epoch=epoch-old', 3)).map((e) => e.data['seq'] ?? e.data['oldest'])).toEqual([3, 3, 4]);
    expect((await call(url, 'GET', '/events?after=soon')).status).toBe(400);
  });
});
