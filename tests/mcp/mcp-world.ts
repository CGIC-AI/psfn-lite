/**
 * The activity world (every domain's real core services over fakes, or over
 * the Postgres stores) served over MCP. Credentials are random per world and
 * live only in an in-memory environment; the binding configuration names the
 * variables, never the values. Each binding attests a channel identity from
 * the standard cast, so core ingress resolves it through the same contact
 * authority as every other surface.
 */
import { randomBytes } from 'node:crypto';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { afterEach } from 'vitest';
import {
  BASELINE_DISCLOSURE_POLICY,
  createContactAuthority,
  createTrustedIngress,
  ok,
  type InternalTurnRequest,
  type InternalTurnResult,
  type Result,
} from '../../packages/core/src/index.ts';
import {
  combineCallers,
  createMcpInternalTurns,
  createMcpSurface,
  loadPrincipalBindings,
  startMcpHttpServer,
  type McpErrorReport,
  type McpHttpServer,
  type McpPrincipalBindings,
  type McpSurface,
} from '../../packages/mcp/src/index.ts';
import { activityWorld, fakeActivityPorts, fakeHosts, type ActivityPorts } from '../core/activity-world.ts';
import { COMPANION } from '../core/fakes.ts';
import { fakeMemoryPorts, type MemoryPorts } from '../core/memory-world.ts';
import { BINDINGS } from './bindings-fixture.ts';

export { BINDINGS };

export type Principal = keyof typeof BINDINGS;

export const envName = (principal: string): string => `LITE_MCP_TEST_${principal.toUpperCase().replace(/-/g, '_')}`;

export function freshCredentials(): Record<Principal, string> {
  return Object.fromEntries(Object.keys(BINDINGS).map((p) => [p, randomBytes(32).toString('base64url')])) as Record<Principal, string>;
}

export function bindingConfig(): unknown {
  return { bindings: Object.entries(BINDINGS).map(([principal, attestation]) => ({ principal, credential: { env: envName(principal) }, attestation })) };
}

const openClients: Client[] = [];
const openServers: McpHttpServer[] = [];

afterEach(async () => {
  await Promise.all(openClients.splice(0).map((c) => c.close()));
  await Promise.all(openServers.splice(0).map((s) => s.close()));
});

export interface ToolOutcome {
  readonly isError: boolean;
  readonly payload: Record<string, unknown>;
  readonly text: string;
}

export async function connectClient(url: string, credential: string | null, track = true): Promise<Client> {
  const client = new Client({ name: 'lite-mcp-test', version: '0.0.0' });
  if (track) openClients.push(client);
  await client.connect(
    new StreamableHTTPClientTransport(new URL(url), credential === null ? {} : { requestInit: { headers: { Authorization: `Bearer ${credential}` } } }),
  );
  return client;
}

export async function invoke(client: Client, tool: string, args: Record<string, unknown>): Promise<ToolOutcome> {
  const result = await client.callTool({ name: tool, arguments: args });
  const first = (result.content as { type: string; text?: string }[] | undefined)?.[0];
  const text = first?.type === 'text' ? (first.text ?? '') : '';
  return { isError: result.isError === true, payload: (result.structuredContent ?? {}) as Record<string, unknown>, text };
}

/** The tool content of a call that must succeed. */
export async function mustInvoke<T = unknown>(client: Client, tool: string, args: Record<string, unknown>): Promise<T> {
  const outcome = await invoke(client, tool, args);
  if (outcome.isError) throw new Error(`${tool}.${String(args['action'])} failed: ${outcome.text}`);
  return outcome.payload['content'] as T;
}

/** What the companion does in one internal turn, over a client connected with that turn's credential. */
export type CompanionTurn = (request: InternalTurnRequest, self: Client, credential: string) => Promise<Result<InternalTurnResult>>;

const QUIET_TURN: CompanionTurn = () => Promise.resolve(ok({ status: 'completed', reply: null }));

export const INTERNAL_TURN_TTL_MS = 5 * 60_000;

export async function mcpWorld<A extends ActivityPorts, M extends MemoryPorts>(activityPorts: A, memoryPorts: M) {
  const hosts = fakeHosts();
  const world = await activityWorld(activityPorts, memoryPorts, { hosts });
  const credentials = freshCredentials();
  const env = Object.fromEntries(Object.entries(credentials).map(([p, c]) => [envName(p), c]));
  const loaded = loadPrincipalBindings(bindingConfig(), env);
  if (!loaded.ok) throw new Error(JSON.stringify(loaded.error));
  const bindings: McpPrincipalBindings = loaded.value;
  const turns = createMcpInternalTurns({ ttlMs: INTERNAL_TURN_TTL_MS, maxOpen: 4, now: Date.now });
  if (!turns.ok) throw new Error(JSON.stringify(turns.error));
  const callers = combineCallers(bindings, turns.value);
  const ingress = createTrustedIngress({
    companionId: COMPANION,
    authenticator: callers.authenticator,
    contacts: createContactAuthority(world.contactStore),
    policy: BASELINE_DISCLOSURE_POLICY,
  });
  if (!ingress.ok) throw new Error(JSON.stringify(ingress.error));
  const errors: McpErrorReport[] = [];
  const onError = (report: McpErrorReport) => errors.push(report);
  const built = createMcpSurface({ dispatcher: world.dispatcher, ingress: ingress.value, onError });
  if (!built.ok) throw new Error(JSON.stringify(built.error));
  const surface: McpSurface = built.value;
  const http = await startMcpHttpServer({ surface, bindings: callers, port: 0, onError });
  if (!http.ok) throw new Error(JSON.stringify(http.error));
  openServers.push(http.value);
  const url = http.value.url;

  // The host's InternalTurnPort: core asks, a credential is minted for the turn, the harness runs, the credential is revoked.
  const companion: { turn: CompanionTurn } = { turn: QUIET_TURN };
  /** Every credential a turn was given, so tests can try them after the turn settles. */
  const turnCredentials: string[] = [];
  const turnPort = turns.value.createTurnPort(async (request, credential) => {
    turnCredentials.push(credential);
    const self = await connectClient(url, credential, false);
    try {
      return await companion.turn(request, self, credential);
    } finally {
      await self.close();
    }
  });
  hosts.internalTurns.script = (request) => turnPort.run(request);

  /** Runs `act` as the companion inside one free-time internal turn core could have asked for. */
  const inSelfTurn = async <T>(act: (self: Client, credential: string) => Promise<T>): Promise<T> => {
    const previous = companion.turn;
    const outcome: { result?: { value: T } } = {};
    companion.turn = async (_request, self, credential) => {
      outcome.result = { value: await act(self, credential) };
      return ok({ status: 'completed', reply: null });
    };
    try {
      const scope = await world.admit('free-time');
      const run = await turnPort.run({ scope, purpose: 'free_time', prompt: 'A quiet moment of your own.', reference: { kind: 'scheduled_prompt', id: 'mcp-test' } });
      if (!run.ok) throw new Error(JSON.stringify(run.error));
    } finally {
      companion.turn = previous;
    }
    if (outcome.result === undefined) throw new Error('the internal turn never ran');
    return outcome.result.value;
  };

  const clients = new Map<Principal, Client>();
  const as = async (principal: Principal): Promise<Client> => {
    const existing = clients.get(principal);
    if (existing !== undefined) return existing;
    const client = await connectClient(url, credentials[principal]);
    clients.set(principal, client);
    return client;
  };
  return { ...world, world, credentials, env, bindings, callers, turns: turns.value, turnPort, turnCredentials, companion, inSelfTurn, mcpIngress: ingress.value, surface, url, errors, as };
}

export const fakeMcpWorld = () => mcpWorld(fakeActivityPorts(), fakeMemoryPorts());
