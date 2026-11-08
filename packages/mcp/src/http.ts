/**
 * Streamable HTTP transport. Stateless: every POST is authenticated on its
 * own and served by a fresh protocol server, so no transport session can
 * carry authority from one request to the next. It binds to loopback unless
 * the operator explicitly opts out and names the Host values it serves.
 */
import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createMcpHandler } from '@modelcontextprotocol/server';
import type { McpCallers } from './callers.ts';
import { invalid, ok, unavailable, type Result } from './core.ts';
import { bearerCredential } from './credentials.ts';
import type { McpErrorReport, McpSurface } from './surface.ts';

export interface McpHttpOptions {
  readonly surface: McpSurface;
  /** The operator bindings, or `combineCallers(bindings, internalTurns)` when the host runs internal turns over this transport. */
  readonly bindings: Pick<McpCallers, 'identify'>;
  /** Port to listen on; 0 picks a free one. */
  readonly port: number;
  /** Default 127.0.0.1. Anything that is not loopback needs `exposeBeyondLoopback`. */
  readonly host?: string;
  /** Default `/mcp`. */
  readonly path?: string;
  readonly maxBodyBytes?: number;
  /** Explicit opt-in to bind a non-loopback address, with the Host header values to accept. */
  readonly exposeBeyondLoopback?: { readonly allowedHosts: readonly string[] };
  readonly onError: (report: McpErrorReport) => void;
}

export interface McpHttpServer {
  readonly url: string;
  close(): Promise<void>;
}

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PATH = '/mcp';
const DEFAULT_MAX_BODY_BYTES = 1024 * 1024;
const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost']);
const LOOPBACK_HOST_HEADERS = new Set(['127.0.0.1', '[::1]', 'localhost']);
/** Headers that carry credentials or browser state; the protocol layer never sees them. */
const STRIPPED_HEADERS = new Set(['authorization', 'cookie', 'proxy-authorization']);

export async function startMcpHttpServer(options: McpHttpOptions): Promise<Result<McpHttpServer>> {
  const host = options.host ?? DEFAULT_HOST;
  const path = options.path ?? DEFAULT_PATH;
  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  if (!path.startsWith('/')) return invalid('path must start with /');
  if (!Number.isInteger(maxBodyBytes) || maxBodyBytes < 1) return invalid('maxBodyBytes must be a positive integer');
  const loopback = LOOPBACK_HOSTS.has(host);
  if (!loopback && options.exposeBeyondLoopback === undefined) {
    return invalid(`refusing to bind ${host}: the MCP endpoint binds loopback unless exposeBeyondLoopback is set`);
  }
  if (options.exposeBeyondLoopback?.allowedHosts.length === 0) return invalid('exposeBeyondLoopback needs at least one allowed Host');
  const allowedHosts = options.exposeBeyondLoopback === undefined ? null : new Set(options.exposeBeyondLoopback.allowedHosts.map((h) => h.toLowerCase()));

  const server = createServer((req, res) => {
    void serve({ ...options, path, maxBodyBytes, allowedHosts }, req, res);
  });
  const listening = await new Promise<Result<void>>((resolve) => {
    server.once('error', (error) => resolve(unavailable('mcp_http', `could not listen: ${error.message}`)));
    server.listen(options.port, host, () => resolve(ok(undefined)));
  });
  if (!listening.ok) return listening;
  const address = server.address() as AddressInfo;
  const shown = address.family === 'IPv6' ? `[${address.address}]` : address.address;
  return ok({ url: `http://${shown}:${address.port}${path}`, close: () => closeServer(server) });
}

interface ServeOptions extends McpHttpOptions {
  readonly path: string;
  readonly maxBodyBytes: number;
  readonly allowedHosts: ReadonlySet<string> | null;
}

async function serve(options: ServeOptions, req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    const url = new URL(req.url ?? '/', 'http://mcp.invalid');
    if (url.pathname !== options.path) return reply(res, 404, 'not found');
    // Machine-to-machine only: a browser origin never reaches the companion's state.
    if (req.headers.origin !== undefined) return reply(res, 403, 'browser origins are not accepted');
    if (!hostAllowed(req.headers.host, options.allowedHosts)) return reply(res, 403, 'host not accepted');
    const credential = bearerCredential(req.headers.authorization);
    if (credential === null || options.bindings.identify(credential) === null) {
      return reply(res, 401, 'a bound bearer credential is required', { 'WWW-Authenticate': 'Bearer realm="psfn-lite"' });
    }
    if (req.method !== 'POST') return reply(res, 405, 'method not allowed', { Allow: 'POST' });
    if (req.headers['mcp-session-id'] !== undefined) return reply(res, 400, 'transport sessions are not supported');
    const body = await readBody(req, options.maxBodyBytes);
    if (body === null) return reply(res, 413, 'request body too large');

    const headers = new Headers();
    for (const [name, value] of Object.entries(req.headers)) {
      if (value !== undefined && !STRIPPED_HEADERS.has(name)) headers.set(name, Array.isArray(value) ? value.join(', ') : value);
    }
    const handler = createMcpHandler(() => options.surface.createServer(credential), {
      onerror: (error) => options.onError({ stage: 'transport', tool: null, action: null, error: { kind: 'exception', message: error.message } }),
    });
    try {
      const response = await handler.fetch(new Request(`http://mcp.invalid${options.path}`, { method: 'POST', headers, body: new Uint8Array(body) }));
      const payload = Buffer.from(await response.arrayBuffer());
      res.writeHead(response.status, Object.fromEntries(response.headers));
      res.end(payload);
    } finally {
      await handler.close();
    }
  } catch (error) {
    options.onError({ stage: 'transport', tool: null, action: null, error: { kind: 'exception', message: error instanceof Error ? error.message : 'non-error thrown' } });
    if (!res.headersSent) reply(res, 500, 'transport failure');
    else res.destroy();
  }
}

function hostAllowed(header: string | undefined, allowed: ReadonlySet<string> | null): boolean {
  if (header === undefined) return false;
  const name = header.toLowerCase().replace(/:\d+$/, '');
  return allowed === null ? LOOPBACK_HOST_HEADERS.has(name) : allowed.has(name);
}

function reply(res: ServerResponse, status: number, message: string, headers: Readonly<Record<string, string>> = {}): void {
  res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
  res.end(JSON.stringify({ error: message }));
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
