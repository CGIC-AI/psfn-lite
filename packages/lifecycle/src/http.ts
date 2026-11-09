/**
 * The lifecycle bridge: an authenticated HTTP JSON surface through which an
 * external companion host (Hermes) drives host-driven companion turns. Every
 * request carries a bearer credential; the principal is identified from it
 * before the body is read, never from the body. Each route calls one bridge
 * use case (prepare, settle, checkpoint, tool-choice, and with hosted
 * automata the attempt routes under `automata/`) and holds no business logic. It
 * binds loopback unless the operator explicitly opts out and names the Host
 * values it serves.
 */
import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { bearerCredential, invalid, ok, publicError, unavailable, type HostError, type Result } from './mcp.ts';
import type { HostTurnBridge } from './bridge.ts';
import type { HostedAttemptRefusal, HostedAutomataExecutor, HostedResult } from './companion.ts';
import type { HostMemoryDeletionApprovals } from './memory-deletion.ts';
import {
  parseMemoryDeletionApprove,
  parseAutomataAttempt,
  parseAutomataBus,
  parseAutomataClaim,
  parseAutomataReport,
  parseCheckpoint,
  parsePrepare,
  parseSettle,
  parseToolChoice,
  renderContext,
  renderToolChoice,
} from './wire.ts';

export interface LifecycleErrorReport {
  readonly route: string;
  /** The bound principal, or null before identification. */
  readonly principal: string | null;
  readonly error: HostError | { readonly kind: 'exception'; readonly message: string };
}

export interface LifecycleBridgeOptions {
  readonly bridge: HostTurnBridge;
  /** The same principal bindings the MCP tool transport uses. */
  readonly identify: (credential: string) => string | null;
  readonly port: number;
  /** Default 127.0.0.1. Anything that is not loopback needs `exposeBeyondLoopback`. */
  readonly host?: string;
  readonly exposeBeyondLoopback?: { readonly allowedHosts: readonly string[] };
  readonly maxBodyBytes?: number;
  readonly onError: (report: LifecycleErrorReport) => void;
  /**
   * Hosted automata (operator automata rule 4): the core executor whose
   * attempts the host claims, runs as its own subagents and reports. The
   * routes `automata/claim`, `automata/heartbeat`, `automata/bus` and
   * `automata/report` exist only when it is set. The owner of an attempt is
   * the bound principal and the body's hostInstance.
   */
  readonly automata?: Pick<HostedAutomataExecutor, 'claim' | 'heartbeat' | 'callBus' | 'report'> | null;
  /**
   * Which principals may run automata. An automaton's goal and context are
   * the companion's own work at its private trust, so the standalone host
   * admits only principals bound to its primary contact. Required with `automata`.
   */
  readonly automataAdmits?: (principal: string) => boolean;
  /**
   * Memory deletion approved by the host's human (Step E3): the route
   * `memory-deletion/approve` exists only when it is set. Only principals
   * `primaryAdmits` admits (bound to the primary contact, who decides
   * deletions as the donor's Operator did) approve.
   */
  readonly memoryDeletion?: HostMemoryDeletionApprovals | null;
  readonly primaryAdmits?: (principal: string) => boolean;
}

export interface LifecycleBridge {
  readonly url: string;
  close(): Promise<void>;
}

export const LIFECYCLE_PATH = '/lifecycle/v1';
const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_MAX_BODY_BYTES = 4 * 1024 * 1024;
const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost']);
const LOOPBACK_HOST_HEADERS = new Set(['127.0.0.1', '[::1]', 'localhost']);

interface Request {
  readonly route: string;
  readonly principal: string;
  readonly body: unknown;
}

type Reply = { readonly status: number; readonly body: Readonly<Record<string, unknown>> };

export async function startLifecycleBridge(options: LifecycleBridgeOptions): Promise<Result<LifecycleBridge>> {
  const host = options.host ?? DEFAULT_HOST;
  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  if (!Number.isInteger(maxBodyBytes) || maxBodyBytes < 1) return invalid('maxBodyBytes must be a positive integer');
  if (!LOOPBACK_HOSTS.has(host) && options.exposeBeyondLoopback === undefined) {
    return invalid(`refusing to bind ${host}: the lifecycle bridge binds loopback unless exposeBeyondLoopback is set`);
  }
  if (options.exposeBeyondLoopback?.allowedHosts.length === 0) return invalid('exposeBeyondLoopback needs at least one allowed Host');
  const allowedHosts = options.exposeBeyondLoopback === undefined ? null : new Set(options.exposeBeyondLoopback.allowedHosts.map((h) => h.toLowerCase()));
  const routes = createRoutes(options);

  const server = createServer((req, res) => {
    void serve(req, res, { options, routes, maxBodyBytes, allowedHosts });
  });
  const listening = await new Promise<Result<void>>((resolve) => {
    server.once('error', (error) => resolve(unavailable('lifecycle_http', `could not listen: ${error.message}`)));
    server.listen(options.port, host, () => resolve(ok(undefined)));
  });
  if (!listening.ok) return listening;
  const address = server.address() as AddressInfo;
  const shown = address.family === 'IPv6' ? `[${address.address}]` : address.address;
  return ok({ url: `http://${shown}:${address.port}${LIFECYCLE_PATH}`, close: () => closeServer(server) });
}

type Routes = Readonly<Record<string, (request: Request) => Promise<Reply>>>;

function createRoutes(options: LifecycleBridgeOptions): Routes {
  const { bridge } = options;
  const fail = (request: Request, error: HostError): Reply => {
    if (error.kind === 'unavailable') options.onError({ route: request.route, principal: request.principal, error });
    return { status: STATUS[error.kind], body: { error: publicError(error) } };
  };

  return {
    ...(options.automata ? createAutomataRoutes(options.automata, options.automataAdmits ?? (() => false), fail) : {}),
    ...(options.memoryDeletion ? { 'memory-deletion/approve': memoryDeletionRoute(options.memoryDeletion, bridge, options.primaryAdmits ?? (() => false), fail) } : {}),
    async prepare(request) {
      const body = parsePrepare(request.body);
      if (!body.ok) return fail(request, body.error);
      const prepared = await bridge.prepare(request.principal, body.value);
      if (!prepared.ok) return fail(request, prepared.error);
      const answer = prepared.value;
      switch (answer.kind) {
        case 'replayed':
          return { status: 200, body: { kind: 'replayed' } };
        case 'answered':
          return { status: 200, body: { kind: 'answered', turnId: answer.turnId, reply: answer.reply } };
        case 'prepared':
          return { status: 200, body: { kind: 'prepared', turnId: answer.turnId, resumed: answer.resumed, context: renderContext(answer.context) } };
      }
    },

    async settle(request) {
      const body = parseSettle(request.body);
      if (!body.ok) return fail(request, body.error);
      if (body.value.outcome.kind === 'failed') {
        options.onError({
          route: request.route,
          principal: request.principal,
          error: { kind: 'exception', message: `host turn ${body.value.turnId} failed: ${body.value.outcome.code}: ${body.value.errorMessage ?? ''}` },
        });
      }
      const settled = await bridge.settle(request.principal, { hostInstance: body.value.hostInstance, turnId: body.value.turnId, outcome: body.value.outcome });
      if (!settled.ok) return fail(request, settled.error);
      return { status: 200, body: { turnId: settled.value.turnId, status: settled.value.status, reply: settled.value.reply } };
    },

    // The explicit tool contract of the open turn's pending model call (host-turns.ts HostToolChoice).
    'tool-choice': async (request) => {
      const body = parseToolChoice(request.body);
      if (!body.ok) return fail(request, body.error);
      const answer = bridge.toolChoice(request.principal, body.value.hostInstance, body.value.turnId);
      return answer.ok ? { status: 200, body: { toolChoice: renderToolChoice(answer.value.toolChoice) } } : fail(request, answer.error);
    },

    async checkpoint(request) {
      const body = parseCheckpoint(request.body);
      if (!body.ok) return fail(request, body.error);
      const checkpoint = await bridge.checkpoint(request.principal, body.value.hermesInstallId, body.value.sessionId, body.value.turnIds);
      return checkpoint.ok ? { status: 200, body: { settled: checkpoint.value.settled, open: checkpoint.value.open } } : fail(request, checkpoint.error);
    },
  };
}

const STATUS: Readonly<Record<HostError['kind'], number>> = { denied: 403, not_found: 404, conflict: 409, invalid: 400, unavailable: 503 };

function memoryDeletionRoute(
  approvals: HostMemoryDeletionApprovals,
  bridge: HostTurnBridge,
  admits: (principal: string) => boolean,
  fail: (request: Request, error: HostError) => Reply,
): (request: Request) => Promise<Reply> {
  return async (request) => {
    if (!admits(request.principal)) {
      return fail(request, { kind: 'denied', reason: 'deletion_not_admitted', detail: 'only the primary contact approves memory deletion' });
    }
    const body = parseMemoryDeletionApprove(request.body);
    if (!body.ok) return fail(request, body.error);
    const bound = bridge.boundInstall(body.value.hermesInstallId);
    if (!bound.ok) return fail(request, bound.error);
    const owner = `${request.principal}/${body.value.hostInstance}`;
    const approved = await approvals.approve(owner, body.value.proposalId, body.value.memoryId, `host:${request.principal}`);
    return approved.ok ? { status: 200, body: { ...approved.value } } : fail(request, approved.error);
  };
}

/** An attempt refusal as HTTP: an ended attempt is gone (410), a stranger's is forbidden. */
const REFUSAL_STATUS: Readonly<Record<HostedAttemptRefusal, number>> = {
  unknown_attempt: 404,
  attempt_ended: 410,
  not_attempt_owner: 403,
  budget_exceeds_policy: 409,
  invalid: 400,
  no_bus_access: 403,
  cancel_requested: 409,
};

function createAutomataRoutes(
  automata: NonNullable<LifecycleBridgeOptions['automata']>,
  admits: (principal: string) => boolean,
  fail: (request: Request, error: HostError) => Reply,
): Routes {
  const owner = (request: Request, hostInstance: string) => `${request.principal}/${hostInstance}`;
  const admitted = (route: (request: Request) => Promise<Reply>) => async (request: Request): Promise<Reply> => (admits(request.principal)
    ? await route(request)
    : fail(request, { kind: 'denied', reason: 'automata_not_admitted', detail: 'this principal does not run the companion\'s automata' }));
  const answer = <T>(result: HostedResult<T>, render: (value: T) => Readonly<Record<string, unknown>>): Reply => (result.ok
    ? { status: 200, body: render(result.value) }
    : { status: REFUSAL_STATUS[result.refusal], body: { error: { kind: result.refusal, detail: result.message } } });
  return {
    'automata/claim': admitted(async (request) => {
      const body = parseAutomataClaim(request.body);
      if (!body.ok) return fail(request, body.error);
      return answer(
        automata.claim(owner(request, body.value.hostInstance), { maxIterations: body.value.maxIterations, limit: body.value.limit }),
        (claims) => ({ attempts: claims }),
      );
    }),
    'automata/heartbeat': admitted(async (request) => {
      const body = parseAutomataAttempt(request.body);
      if (!body.ok) return fail(request, body.error);
      return answer(automata.heartbeat(owner(request, body.value.hostInstance), body.value.attemptCredential), (status) => ({ ...status }));
    }),
    'automata/bus': admitted(async (request) => {
      const body = parseAutomataBus(request.body);
      if (!body.ok) return fail(request, body.error);
      const result = await automata.callBus(owner(request, body.value.hostInstance), body.value.attemptCredential, body.value.arguments);
      return answer(result, (value) => ({ ...value }));
    }),
    'automata/report': admitted(async (request) => {
      const body = parseAutomataReport(request.body);
      if (!body.ok) return fail(request, body.error);
      return answer(
        automata.report(owner(request, body.value.hostInstance), body.value.attemptCredential, body.value.outcome),
        (value) => ({ ...value }),
      );
    }),
  };
}

interface ServeContext {
  readonly options: LifecycleBridgeOptions;
  readonly routes: Routes;
  readonly maxBodyBytes: number;
  readonly allowedHosts: ReadonlySet<string> | null;
}

async function serve(req: IncomingMessage, res: ServerResponse, context: ServeContext): Promise<void> {
  const { options, routes } = context;
  let route = '';
  let principal: string | null = null;
  try {
    const url = new URL(req.url ?? '/', 'http://lifecycle.invalid');
    route = url.pathname.startsWith(`${LIFECYCLE_PATH}/`) ? url.pathname.slice(LIFECYCLE_PATH.length + 1) : '';
    const handler = Object.hasOwn(routes, route) ? routes[route] : undefined;
    if (handler === undefined) return reply(res, 404, { error: 'not found' });
    // Machine-to-machine only: a browser origin never reaches the companion's state.
    if (req.headers.origin !== undefined) return reply(res, 403, { error: 'browser origins are not accepted' });
    if (!hostAllowed(req.headers.host, context.allowedHosts)) return reply(res, 403, { error: 'host not accepted' });
    const credential = bearerCredential(req.headers.authorization);
    principal = credential === null ? null : options.identify(credential);
    if (credential === null || principal === null) {
      return reply(res, 401, { error: 'a bound bearer credential is required' }, { 'WWW-Authenticate': 'Bearer realm="psfn-lite"' });
    }
    if (req.method !== 'POST') return reply(res, 405, { error: 'method not allowed' }, { Allow: 'POST' });
    if (!(req.headers['content-type'] ?? '').toLowerCase().startsWith('application/json')) return reply(res, 415, { error: 'application/json is required' });
    const raw = await readBody(req, context.maxBodyBytes);
    if (raw === null) return reply(res, 413, { error: 'request body too large' });
    let body: unknown;
    try {
      body = JSON.parse(raw.toString('utf8'));
    } catch {
      return reply(res, 400, { error: { kind: 'invalid', issues: ['body must be JSON'] } });
    }
    const answer = await handler({ route, principal, body });
    reply(res, answer.status, answer.body);
  } catch (error) {
    options.onError({ route, principal, error: { kind: 'exception', message: error instanceof Error ? error.message : 'non-error thrown' } });
    if (!res.headersSent) reply(res, 500, { error: 'bridge failure' });
    else res.destroy();
  }
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
