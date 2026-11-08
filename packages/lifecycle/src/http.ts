/**
 * The lifecycle bridge: an authenticated HTTP JSON surface through which an
 * external companion host drives core's turn lifecycle. Every request carries
 * a bearer credential; the caller is identified from it before the body is
 * read and admitted by core ingress from it, never from the body. Each route
 * calls one core use case (`HostedTurns`) and holds no business logic. It
 * binds loopback unless the operator explicitly opts out and names the Host
 * values it serves.
 */
import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  invalid,
  ok,
  unavailable,
  type CoreError,
  type HostedTurns,
  type Result,
  type TrustedIngress,
  type TrustedTurnScope,
  type TurnId,
  type TurnOwner,
} from './core.ts';
import type { DelegatedInternalTurns, DelegatedJob } from './delegated.ts';
import { bearerCredential, publicError, type McpCallers } from './mcp.ts';
import { parseCheckpoint, parseClaim, parsePrepare, parseRelease, parseSettle, renderContext, renderRecord } from './wire.ts';

export interface LifecycleErrorReport {
  readonly route: string;
  /** The bound caller's name, or null before identification. */
  readonly caller: string | null;
  readonly error: CoreError | { readonly kind: 'exception'; readonly message: string };
}

export interface LifecycleBridgeOptions {
  readonly hosted: HostedTurns;
  /** Built with the same callers' authenticator; admits every request. */
  readonly ingress: TrustedIngress;
  /** Operator bindings combined with the internal-turn credentials. */
  readonly callers: Pick<McpCallers, 'identify'>;
  /** Null when internal turns run in this process's own harness. */
  readonly delegated: DelegatedInternalTurns | null;
  /** The one bound principal that may claim delegated internal turns. */
  readonly internalTurnHost: string | null;
  readonly port: number;
  /** Default 127.0.0.1. Anything that is not loopback needs `exposeBeyondLoopback`. */
  readonly host?: string;
  readonly exposeBeyondLoopback?: { readonly allowedHosts: readonly string[] };
  readonly maxBodyBytes?: number;
  readonly onError: (report: LifecycleErrorReport) => void;
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

/** The turn owner a credential settles as: the bound caller, narrowed by the host's own process instance. */
export function hostOwner(scope: TrustedTurnScope, caller: string, hostInstance: string): TurnOwner {
  return { surface: scope.surface, instance: `${caller}/${hostInstance}` };
}

/** A delegated internal turn is owned by its job, so only that job's credential settles it. */
export function delegatedOwner(scope: TrustedTurnScope, jobId: string): TurnOwner {
  return { surface: scope.surface, instance: `delegated/${jobId}` };
}

interface Request {
  readonly route: string;
  readonly credential: string;
  readonly caller: string;
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
  if ((options.delegated === null) !== (options.internalTurnHost === null)) {
    return invalid('delegated internal turns and the internal-turn host principal are configured together');
  }
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
  const { hosted, delegated } = options;
  const admit = async (request: Request): Promise<Result<TrustedTurnScope>> => options.ingress.admit({ kind: 'mcp_credential', credential: request.credential });
  const fail = (request: Request, error: CoreError): Reply => {
    if (error.kind === 'unavailable') options.onError({ route: request.route, caller: request.caller, error });
    return { status: STATUS[error.kind], body: { error: publicError(error) } };
  };
  const internalHost = (request: Request): Reply | null =>
    delegated !== null && request.caller === options.internalTurnHost
      ? null
      : fail(request, { kind: 'denied', reason: 'unknown_authority', detail: 'only the configured internal-turn host claims internal turns' });

  return {
    async prepare(request) {
      const body = parsePrepare(request.body);
      if (!body.ok) return fail(request, body.error);
      const scope = await admit(request);
      if (!scope.ok) return fail(request, scope.error);
      const job = delegated?.jobFor(request.credential) ?? null;
      if (job === null && scope.value.caller.kind !== 'participant') {
        return fail(request, { kind: 'denied', reason: 'unknown_authority', detail: 'only a participant credential or a claimed internal-turn credential prepares turns' });
      }
      if ((job === null) === (body.value.message === null)) {
        return fail(request, { kind: 'invalid', issues: [job === null ? 'message is required for a participant turn' : 'an internal turn takes no message; core fixed its trigger'] });
      }
      const prepared = await hosted.prepare(scope.value, job === null
        ? { owner: hostOwner(scope.value, request.caller, body.value.hostInstance), idempotencyKey: body.value.idempotencyKey, trigger: { kind: 'participant_message', text: body.value.message ?? '' } }
        : { owner: delegatedOwner(scope.value, job.jobId), idempotencyKey: job.idempotencyKey, trigger: internalTrigger(job) });
      if (!prepared.ok) return fail(request, prepared.error);
      if (prepared.value.kind === 'replayed') return { status: 200, body: { kind: 'replayed', ...renderRecord(prepared.value.record) } };
      const turn = prepared.value;
      if (job !== null) delegated?.bindTurn(job.jobId, scope.value, turn.turnId);
      return {
        status: 200,
        body: {
          kind: 'prepared',
          turnId: turn.turnId,
          sessionId: turn.sessionId,
          resumed: turn.resumed,
          internal: job === null ? null : { purpose: job.request.purpose, reference: job.request.reference },
          context: renderContext(turn.context),
        },
      };
    },

    async settle(request) {
      const body = parseSettle(request.body);
      if (!body.ok) return fail(request, body.error);
      const scope = await admit(request);
      if (!scope.ok) return fail(request, scope.error);
      const job = delegated?.jobFor(request.credential) ?? null;
      const owner = job === null ? hostOwner(scope.value, request.caller, body.value.hostInstance) : delegatedOwner(scope.value, job.jobId);
      const settled = await hosted.settle(scope.value, { owner, turnId: body.value.turnId, outcome: body.value.outcome, toolCallCount: body.value.toolCallCount });
      if (!settled.ok) return fail(request, settled.error);
      const { record, settledNow, postTurn } = settled.value;
      const outcome = record.settlement?.outcome;
      if (job !== null && outcome !== undefined) {
        delegated?.complete(job.jobId, { status: outcome.kind, reply: outcome.kind === 'completed' ? outcome.reply : outcome.partialReply });
      }
      const part = (result: Result<unknown> | null, name: string) => {
        if (result === null) return null;
        if (result.ok) return { ok: true };
        options.onError({ route: `${request.route}:${name}`, caller: request.caller, error: result.error });
        return { ok: false, error: publicError(result.error) };
      };
      return {
        status: 200,
        body: { ...renderRecord(record), settledNow, postTurn: { emotion: part(postTurn.emotion, 'emotion'), workers: part(postTurn.workers, 'workers') } },
      };
    },

    async checkpoint(request) {
      const body = parseCheckpoint(request.body);
      if (!body.ok) return fail(request, body.error);
      const scope = await admit(request);
      if (!scope.ok) return fail(request, scope.error);
      const checkpoint = await hosted.checkpoint(scope.value, body.value);
      return checkpoint.ok ? { status: 200, body: { settled: checkpoint.value.settled, open: checkpoint.value.open } } : fail(request, checkpoint.error);
    },

    async 'internal/claim'(request) {
      const refused = internalHost(request);
      if (refused !== null) return refused;
      const body = parseClaim(request.body);
      if (!body.ok) return fail(request, body.error);
      const job = await delegated?.claim(body.value.waitMs);
      return { status: 200, body: { job: job == null ? null : claimed(job) } };
    },

    async 'internal/release'(request) {
      const refused = internalHost(request);
      if (refused !== null) return refused;
      const body = parseRelease(request.body);
      if (!body.ok) return fail(request, body.error);
      options.onError({ route: request.route, caller: request.caller, error: { kind: 'exception', message: `internal turn ${body.value.jobId} released: ${body.value.error.code}` } });
      const released = await delegated?.release(body.value.jobId, body.value.error);
      return released === undefined || released.ok ? { status: 200, body: { released: true } } : fail(request, released.error);
    },
  };
}

function internalTrigger(job: DelegatedJob) {
  const { purpose, prompt } = job.request;
  return { kind: 'internal', origin: { kind: 'system_note', source: purpose }, purpose, text: prompt } as const;
}

function claimed(job: DelegatedJob): Readonly<Record<string, unknown>> {
  return { jobId: job.jobId, credential: job.credential, purpose: job.request.purpose, prompt: job.request.prompt, reference: job.request.reference };
}

/** Settles a delegated turn whose job ended without the host settling it. */
export function abandonDelegatedTurn(hosted: () => HostedTurns | null, onError: (report: LifecycleErrorReport) => void) {
  return async (scope: TrustedTurnScope, turnId: TurnId, jobId: string, error: { readonly code: string; readonly message: string }): Promise<void> => {
    const turns = hosted();
    if (turns === null) return;
    const settled = await turns.settle(scope, {
      owner: delegatedOwner(scope, jobId),
      turnId,
      outcome: { kind: 'failed', error, partialReply: null, delivery: 'not_attempted' },
      toolCallCount: 0,
    });
    // A turn the host settled just before the timeout is already recorded; anything else is reported.
    if (!settled.ok && !(settled.error.kind === 'conflict' && settled.error.reason === 'turn_already_settled')) {
      onError({ route: 'internal/abandon', caller: null, error: settled.error });
    }
  };
}

const STATUS: Readonly<Record<CoreError['kind'], number>> = { denied: 403, not_found: 404, conflict: 409, invalid: 400, unavailable: 503 };

interface ServeContext {
  readonly options: LifecycleBridgeOptions;
  readonly routes: Routes;
  readonly maxBodyBytes: number;
  readonly allowedHosts: ReadonlySet<string> | null;
}

async function serve(req: IncomingMessage, res: ServerResponse, context: ServeContext): Promise<void> {
  const { options, routes } = context;
  let route = '';
  try {
    const url = new URL(req.url ?? '/', 'http://lifecycle.invalid');
    route = url.pathname.startsWith(`${LIFECYCLE_PATH}/`) ? url.pathname.slice(LIFECYCLE_PATH.length + 1) : '';
    const handler = Object.hasOwn(routes, route) ? routes[route] : undefined;
    if (handler === undefined) return reply(res, 404, { error: 'not found' });
    // Machine-to-machine only: a browser origin never reaches the companion's state.
    if (req.headers.origin !== undefined) return reply(res, 403, { error: 'browser origins are not accepted' });
    if (!hostAllowed(req.headers.host, context.allowedHosts)) return reply(res, 403, { error: 'host not accepted' });
    const credential = bearerCredential(req.headers.authorization);
    const caller = credential === null ? null : options.callers.identify(credential);
    if (credential === null || caller === null) {
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
    const answer = await handler({ route, credential, caller, body });
    reply(res, answer.status, answer.body);
  } catch (error) {
    options.onError({ route, caller: null, error: { kind: 'exception', message: error instanceof Error ? error.message : 'non-error thrown' } });
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
