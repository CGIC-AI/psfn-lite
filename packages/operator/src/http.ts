/**
 * The light Garden's HTTP surface: a JSON operator API for the companion's
 * primary contact. It is machine-to-machine, like the lifecycle bridge
 * (packages/lifecycle/src/http.ts):
 *
 * - a browser Origin is refused (403), and so is a Host the server does not serve;
 * - every request carries a bearer credential bound to the primary contact
 *   (401 without one), identified before any body is read.
 *
 * It binds loopback unless the operator explicitly opts out and names the
 * Host values it serves.
 *
 * The donor routes (`/api/admin/...`) are dispatched as the donor's
 * standalone Garden dispatched them (operator/garden/server-routes.ts:59-100):
 * the request is bound for the response, and the route gets the standalone
 * request context built from its catalogue entry, whose actor is the
 * standalone operator. Every body is read up to the configured limit, as
 * the donor's standalone Garden read it. The Lite routes (`/api/lite/...`, lite-routes.ts) answer
 * JSON results.
 */
import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  bindRequestForResponse,
  createStandaloneGardenRequestContext,
  gardenRequestCompanionScopeDenial,
  readBodyWithLimit,
  sendJson,
} from './companion.ts';
import { buildDonorGardenRoutes, type DonorGardenRoute } from './donor-routes.ts';
import type { GardenServices } from './garden.ts';
import { LITE_PREFIX, buildLiteRoutes, type GardenHostFacts, type LiteRoute } from './lite-routes.ts';
import { bearerCredential, invalid, ok, publicError, unavailable, type HostError, type Result } from './mcp.ts';

export interface GardenErrorReport {
  readonly route: string;
  readonly principal: string | null;
  readonly error: HostError | { readonly kind: 'exception'; readonly message: string };
}

export interface GardenServerOptions {
  readonly services: GardenServices;
  readonly host: GardenHostFacts;
  /** The principal a credential is bound to, admitted only when it is bound to the primary contact; null otherwise. */
  readonly identify: (credential: string) => string | null;
  readonly port: number;
  /** Default 127.0.0.1. Anything that is not loopback needs `exposeBeyondLoopback`. */
  readonly listenHost?: string;
  readonly exposeBeyondLoopback?: { readonly allowedHosts: readonly string[] };
  /** The largest request body any route reads (the donor's standalone ADMIN_MAX_BODY_SIZE, server.ts:32, as config). */
  readonly maxBodyBytes: number;
  readonly onError: (report: GardenErrorReport) => void;
}

export interface GardenServer {
  /** The base URL; the routes are under `/api/admin/` and `/api/lite/`. */
  readonly url: string;
  close(): Promise<void>;
}

const DEFAULT_HOST = '127.0.0.1';
const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost']);
const LOOPBACK_HOST_HEADERS = new Set(['127.0.0.1', '[::1]', 'localhost']);
const STATUS: Readonly<Record<HostError['kind'], number>> = { denied: 403, not_found: 404, conflict: 409, invalid: 400, unavailable: 503 };

export async function startGardenServer(options: GardenServerOptions): Promise<Result<GardenServer>> {
  const listenHost = options.listenHost ?? DEFAULT_HOST;
  if (!Number.isInteger(options.maxBodyBytes) || options.maxBodyBytes < 1) return invalid('maxBodyBytes must be a positive integer');
  if (!LOOPBACK_HOSTS.has(listenHost) && options.exposeBeyondLoopback === undefined) {
    return invalid(`refusing to bind ${listenHost}: the Garden binds loopback unless exposeBeyondLoopback is set`);
  }
  if (options.exposeBeyondLoopback?.allowedHosts.length === 0) return invalid('exposeBeyondLoopback needs at least one allowed Host');
  const allowedHosts = options.exposeBeyondLoopback === undefined ? null : new Set(options.exposeBeyondLoopback.allowedHosts.map((h) => h.toLowerCase()));

  // The donor's standalone withBody (server.ts:270-290), with its flat limit (ADMIN_MAX_BODY_SIZE, server.ts:32) from config.
  const donorRoutes = buildDonorGardenRoutes(options.services, (req, res, cb) => {
    readBodyWithLimit(req, res, { maxBytes: options.maxBodyBytes }).then(
      (body) => {
        if (body !== null) cb(body);
      },
      (error: unknown) => fail(res, 'body', null, error),
    );
  });
  const liteRoutes = buildLiteRoutes(options.services, options.host);
  const context: ServeContext = { options, donorRoutes, liteRoutes, allowedHosts };

  const server = createServer((req, res) => {
    void serve(req, res, context);
  });
  const listening = await new Promise<Result<void>>((resolve) => {
    server.once('error', (error) => resolve(unavailable('garden_http', `could not listen: ${error.message}`)));
    server.listen(options.port, listenHost, () => resolve(ok(undefined)));
  });
  if (!listening.ok) return listening;
  const address = server.address() as AddressInfo;
  const shown = address.family === 'IPv6' ? `[${address.address}]` : address.address;
  return ok({ url: `http://${shown}:${address.port}`, close: () => closeServer(server) });

  function fail(res: ServerResponse, route: string, principal: string | null, error: unknown): void {
    options.onError({ route, principal, error: { kind: 'exception', message: error instanceof Error ? error.message : 'non-error thrown' } });
    if (!res.headersSent) reply(res, 500, { error: 'garden failure' });
    else res.destroy();
  }
}

interface ServeContext {
  readonly options: GardenServerOptions;
  readonly donorRoutes: readonly DonorGardenRoute[];
  readonly liteRoutes: readonly LiteRoute[];
  readonly allowedHosts: ReadonlySet<string> | null;
}

async function serve(req: IncomingMessage, res: ServerResponse, context: ServeContext): Promise<void> {
  const { options } = context;
  let route = '';
  let principal: string | null = null;
  try {
    // Machine-to-machine only: a browser origin never reaches the companion's state.
    if (req.headers.origin !== undefined) return reply(res, 403, { error: 'browser origins are not accepted' });
    if (!hostAllowed(req.headers.host, context.allowedHosts)) return reply(res, 403, { error: 'host not accepted' });
    const credential = bearerCredential(req.headers.authorization);
    principal = credential === null ? null : options.identify(credential);
    if (credential === null || principal === null) {
      return reply(res, 401, { error: 'a bearer credential bound to the primary contact is required' }, { 'WWW-Authenticate': 'Bearer realm="psfn-lite-garden"' });
    }
    const url = new URL(req.url ?? '/', 'http://garden.invalid');
    const method = req.method ?? 'GET';
    route = `${method} ${url.pathname}`;
    res.setHeader('Cache-Control', 'no-store');

    for (const candidate of context.donorRoutes) {
      if (candidate.method !== method) continue;
      const params = candidate.match(url.pathname);
      if (params === null) continue;
      route = candidate.capability.id;
      bindRequestForResponse(res, req);
      const requestContext = createStandaloneGardenRequestContext({
        authorization: candidate.capability.authorization,
        routeId: candidate.capability.id,
        companionId: options.services.companionId,
        pathParams: params,
        query: queryOf(url),
      });
      const denial = gardenRequestCompanionScopeDenial(requestContext, options.services.companionId);
      if (denial !== null) {
        sendJson(res, 403, { error: denial });
        return;
      }
      candidate.handle(req, res, params, requestContext);
      return;
    }

    const lite = matchLite(context.liteRoutes, method, url.pathname);
    if (lite === null) return reply(res, 404, { error: 'not found' });
    route = `${lite.route.method} ${LITE_PREFIX}${lite.route.pattern}`;
    let body: unknown;
    if (lite.route.hasBody) {
      const raw = await readBodyWithLimit(req, res, { maxBytes: options.maxBodyBytes });
      if (raw === null) return;
      if (raw.trim() !== '') {
        try {
          body = JSON.parse(raw);
        } catch {
          return reply(res, 400, { error: { kind: 'invalid', issues: ['body must be JSON'] } });
        }
      }
    }
    const answer = await lite.route.handle({ principal, params: lite.params, body });
    if (answer.ok) return reply(res, 200, answer.value);
    if (answer.error.kind === 'unavailable') options.onError({ route, principal, error: answer.error });
    return reply(res, STATUS[answer.error.kind], { error: publicError(answer.error) });
  } catch (error) {
    options.onError({ route, principal, error: { kind: 'exception', message: error instanceof Error ? error.message : 'non-error thrown' } });
    if (!res.headersSent) reply(res, 500, { error: 'garden failure' });
    else res.destroy();
  }
}

function matchLite(routes: readonly LiteRoute[], method: string, path: string): { route: LiteRoute; params: Record<string, string> } | null {
  if (!path.startsWith(`${LITE_PREFIX}/`)) return null;
  const actual = path.slice(LITE_PREFIX.length).split('/');
  for (const route of routes) {
    if (route.method !== method) continue;
    const expected = route.pattern.split('/');
    if (expected.length !== actual.length) continue;
    const params: Record<string, string> = {};
    let matched = true;
    for (const [index, part] of expected.entries()) {
      const value = actual[index] ?? '';
      if (part.startsWith(':')) {
        let decoded: string;
        try {
          decoded = decodeURIComponent(value);
        } catch {
          matched = false;
          break;
        }
        if (decoded === '' || decoded.includes('/')) {
          matched = false;
          break;
        }
        params[part.slice(1)] = decoded;
      } else if (part !== value) {
        matched = false;
        break;
      }
    }
    if (matched) return { route, params };
  }
  return null;
}

function queryOf(url: URL): Record<string, string[]> {
  const query: Record<string, string[]> = {};
  for (const [key, value] of url.searchParams) (query[key] ??= []).push(value);
  return query;
}

function hostAllowed(header: string | undefined, allowed: ReadonlySet<string> | null): boolean {
  if (header === undefined) return false;
  const name = header.toLowerCase().replace(/:\d+$/, '');
  return allowed === null ? LOOPBACK_HOST_HEADERS.has(name) : allowed.has(name);
}

function reply(res: ServerResponse, status: number, body: unknown, headers: Readonly<Record<string, string>> = {}): void {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers });
  res.end(JSON.stringify(body));
}

function closeServer(server: HttpServer): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error === undefined ? resolve() : reject(error)));
    server.closeAllConnections();
  });
}
