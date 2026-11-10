/**
 * The conversation transport: donor-driven turns of the primary contact's
 * conversation over HTTP, for a host that carries the contact's words to the
 * companion and her replies back (a voice pipeline, a chat bridge). The
 * companion runs the whole turn herself, as on the CLI's `once` and `chat`;
 * the host supplies no model and no context.
 *
 * It is machine-to-machine, like the lifecycle bridge and the Garden:
 *
 * - a browser Origin is refused (403), and so is a Host the server does not serve;
 * - every request carries a bearer credential bound to the primary contact
 *   (401 without one), identified before any body is read.
 *
 * Routes, under `/conversation/v1`:
 *
 * - `GET  /health`     the transport is serving (the companion is started).
 * - `POST /turns`      `{ "message": string }` -> `{ "reply", "channelId" }`. One
 *                      turn runs at a time (the donor runs one agent at a time);
 *                      a second one is refused with 409 `turn_in_progress`.
 * - `POST /interrupt`  aborts the running turn -> `{ "interrupted": boolean }`. The
 *                      aborted turn's own request then ends with 409 `interrupted`,
 *                      unless the companion still completed it.
 * - `GET  /events`     server-sent events of what the companion sends on her
 *                      own. `?after=<seq>` (or `Last-Event-ID`) with `?epoch=`
 *                      resumes; a `hello` event names the log's epoch and the
 *                      oldest sequence still held.
 */
import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { bearerCredential, invalid, isRecord, ok, unavailable, type Result } from './mcp.ts';
import type { ConversationOutbox, OutboundEvent } from './outbox.ts';

export const CONVERSATION_PATH = '/conversation/v1';
/** The longest message a turn takes, in characters. */
export const MAX_MESSAGE_CHARS = 32_000;
const HEARTBEAT_MS = 15_000;

/** The companion's side of the transport: the standalone runtime's own operator conversation. */
export interface ConversationPort {
  /** One donor-driven turn. The reply is empty when the companion chose not to answer. */
  converse(message: string): Promise<{ readonly reply: string; readonly channelId: string }>;
  /** Aborts the running turn. */
  interrupt(): void;
}

export interface ConversationErrorReport {
  readonly route: string;
  readonly principal: string | null;
  readonly error: { readonly kind: 'exception' | 'turn_failed'; readonly message: string };
}

export interface ConversationServerOptions {
  readonly port: ConversationPort;
  readonly outbox: ConversationOutbox;
  /** The principal a credential is bound to, admitted only when it is bound to the primary contact; null otherwise. */
  readonly identify: (credential: string) => string | null;
  readonly listenPort: number;
  /** Default 127.0.0.1. Anything that is not loopback needs `exposeBeyondLoopback`. */
  readonly listenHost?: string;
  readonly exposeBeyondLoopback?: { readonly allowedHosts: readonly string[] };
  readonly maxBodyBytes: number;
  readonly onError: (report: ConversationErrorReport) => void;
}

export interface ConversationServer {
  /** The base URL of the routes (it ends in `/conversation/v1`). */
  readonly url: string;
  close(): Promise<void>;
}

const DEFAULT_HOST = '127.0.0.1';
const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost']);
const LOOPBACK_HOST_HEADERS = new Set(['127.0.0.1', '[::1]', 'localhost']);

export async function startConversationServer(options: ConversationServerOptions): Promise<Result<ConversationServer>> {
  const listenHost = options.listenHost ?? DEFAULT_HOST;
  if (!Number.isInteger(options.maxBodyBytes) || options.maxBodyBytes < 1) return invalid('maxBodyBytes must be a positive integer');
  if (!LOOPBACK_HOSTS.has(listenHost) && options.exposeBeyondLoopback === undefined) {
    return invalid(`refusing to bind ${listenHost}: the conversation transport binds loopback unless exposeBeyondLoopback is set`);
  }
  if (options.exposeBeyondLoopback?.allowedHosts.length === 0) return invalid('exposeBeyondLoopback needs at least one allowed Host');
  const allowedHosts = options.exposeBeyondLoopback === undefined ? null : new Set(options.exposeBeyondLoopback.allowedHosts.map((h) => h.toLowerCase()));
  const state: ServeState = { options, allowedHosts, running: false, interrupted: false, streams: new Set() };

  const server = createServer((req, res) => {
    void serve(req, res, state);
  });
  const listening = await new Promise<Result<void>>((resolve) => {
    server.once('error', (error) => resolve(unavailable('conversation_http', `could not listen: ${error.message}`)));
    server.listen(options.listenPort, listenHost, () => resolve(ok(undefined)));
  });
  if (!listening.ok) return listening;
  const address = server.address() as AddressInfo;
  const shown = address.family === 'IPv6' ? `[${address.address}]` : address.address;
  return ok({
    url: `http://${shown}:${address.port}${CONVERSATION_PATH}`,
    close: async () => {
      for (const end of [...state.streams]) end();
      await closeServer(server);
    },
  });
}

interface ServeState {
  readonly options: ConversationServerOptions;
  readonly allowedHosts: ReadonlySet<string> | null;
  running: boolean;
  /** The running turn was asked to stop through `/interrupt`. */
  interrupted: boolean;
  /** Ends each open event stream. */
  readonly streams: Set<() => void>;
}

async function serve(req: IncomingMessage, res: ServerResponse, state: ServeState): Promise<void> {
  const { options } = state;
  let route = '';
  let principal: string | null = null;
  try {
    // Machine-to-machine only: a browser origin never reaches the companion's conversation.
    if (req.headers.origin !== undefined) return reply(res, 403, { error: 'browser origins are not accepted' });
    if (!hostAllowed(req.headers.host, state.allowedHosts)) return reply(res, 403, { error: 'host not accepted' });
    const credential = bearerCredential(req.headers.authorization);
    principal = credential === null ? null : options.identify(credential);
    if (credential === null || principal === null) {
      return reply(res, 401, { error: 'a bearer credential bound to the primary contact is required' }, { 'WWW-Authenticate': 'Bearer realm="psfn-lite-conversation"' });
    }
    const url = new URL(req.url ?? '/', 'http://conversation.invalid');
    const method = req.method ?? 'GET';
    route = `${method} ${url.pathname}`;
    res.setHeader('Cache-Control', 'no-store');
    switch (route) {
      case `GET ${CONVERSATION_PATH}/health`:
        return reply(res, 200, { ok: true });
      case `POST ${CONVERSATION_PATH}/turns`:
        return await turn(req, res, state, route, principal);
      case `POST ${CONVERSATION_PATH}/interrupt`: {
        const interrupted = state.running;
        if (interrupted) {
          state.interrupted = true;
          options.port.interrupt();
        }
        return reply(res, 200, { interrupted });
      }
      case `GET ${CONVERSATION_PATH}/events`:
        return events(req, res, state, url);
      default:
        return reply(res, 404, { error: 'not found' });
    }
  } catch (error) {
    options.onError({ route, principal, error: { kind: 'exception', message: error instanceof Error ? error.message : 'non-error thrown' } });
    if (!res.headersSent) reply(res, 500, { error: 'conversation failure' });
    else res.destroy();
  }
}

async function turn(req: IncomingMessage, res: ServerResponse, state: ServeState, route: string, principal: string): Promise<void> {
  const { options } = state;
  const body = await readBody(req, options.maxBodyBytes);
  if (body === null) return reply(res, 413, { error: 'request body too large' });
  let raw: unknown;
  try {
    raw = JSON.parse(body.toString('utf8'));
  } catch {
    return reply(res, 400, { error: 'invalid', issues: ['the body is not valid JSON'] });
  }
  const issues: string[] = [];
  if (!isRecord(raw)) issues.push('the body must be a JSON object');
  else {
    for (const key of Object.keys(raw)) if (key !== 'message') issues.push(`${key} is not a known field`);
    const message = raw['message'];
    if (typeof message !== 'string' || message.trim().length === 0) issues.push('message must be a non-empty string');
    else if (message.length > MAX_MESSAGE_CHARS) issues.push(`message must be at most ${MAX_MESSAGE_CHARS} characters`);
  }
  if (issues.length > 0 || !isRecord(raw)) return reply(res, 400, { error: 'invalid', issues });
  if (state.running) return reply(res, 409, { error: 'turn_in_progress' });
  state.running = true;
  state.interrupted = false;
  try {
    const answer = await options.port.converse(raw['message'] as string);
    return reply(res, 200, { reply: answer.reply, channelId: answer.channelId });
  } catch (error) {
    // A turn the host itself stopped did not fail; it has no reply.
    if (state.interrupted) return reply(res, 409, { error: 'interrupted' });
    // The failure text is the operator's; the caller learns only that the turn failed.
    options.onError({ route, principal, error: { kind: 'turn_failed', message: error instanceof Error ? error.message : 'non-error thrown' } });
    return reply(res, 502, { error: 'turn_failed' });
  } finally {
    state.running = false;
  }
}

function events(req: IncomingMessage, res: ServerResponse, state: ServeState, url: URL): void {
  const { outbox } = state.options;
  const epoch = url.searchParams.get('epoch');
  const rawAfter = url.searchParams.get('after') ?? (typeof req.headers['last-event-id'] === 'string' ? req.headers['last-event-id'] : null);
  let after = 0;
  if (rawAfter !== null) {
    if (!/^\d{1,15}$/.test(rawAfter)) return reply(res, 400, { error: 'invalid', issues: ['after must be a sequence number'] });
    // A position in another process's log does not continue in this one.
    after = epoch === null || epoch === outbox.epoch ? Number(rawAfter) : 0;
  }
  res.writeHead(200, { 'Content-Type': 'text/event-stream', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  const write = (event: string, data: unknown, id?: number): void => {
    res.write(`${id === undefined ? '' : `id: ${id}\n`}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };
  const send = (event: OutboundEvent): void => write('outbound', { seq: event.seq, channelId: event.channelId, content: event.content, at: event.at }, event.seq);
  // Subscribe before replaying, so nothing published during the replay is lost; the sequence check drops what both delivered.
  let delivered = after;
  const pending: OutboundEvent[] = [];
  let replaying = true;
  const unsubscribe = outbox.subscribe((event) => {
    if (replaying) pending.push(event);
    else if (event.seq > delivered) {
      delivered = event.seq;
      send(event);
    }
  });
  write('hello', { epoch: outbox.epoch, oldest: outbox.oldest() });
  for (const event of [...outbox.since(after), ...pending]) {
    if (event.seq <= delivered) continue;
    delivered = event.seq;
    send(event);
  }
  replaying = false;
  const heartbeat = setInterval(() => res.write(': keep-alive\n\n'), HEARTBEAT_MS);
  const end = (): void => {
    clearInterval(heartbeat);
    unsubscribe();
    state.streams.delete(end);
    if (!res.writableEnded) res.end();
  };
  state.streams.add(end);
  req.once('close', end);
}

function hostAllowed(header: string | undefined, allowed: ReadonlySet<string> | null): boolean {
  if (header === undefined) return false;
  const name = header.toLowerCase().replace(/:\d+$/, '');
  return allowed === null ? LOOPBACK_HOST_HEADERS.has(name) : allowed.has(name);
}

function reply(res: ServerResponse, status: number, body: Readonly<Record<string, unknown>>, headers: Readonly<Record<string, string>> = {}): void {
  res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
  res.end(JSON.stringify(body));
}

/** The raw body, or null once it exceeds the limit. */
async function readBody(req: IncomingMessage, limit: number): Promise<Buffer | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > limit) return null;
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function closeServer(server: HttpServer): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error === undefined ? resolve() : reject(error)));
    server.closeAllConnections();
  });
}
