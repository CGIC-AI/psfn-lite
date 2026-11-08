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
  type HostAttestation,
} from '../../packages/core/src/index.ts';
import {
  createMcpSurface,
  loadPrincipalBindings,
  startMcpHttpServer,
  type McpErrorReport,
  type McpHttpServer,
  type McpPrincipalBindings,
  type McpSurface,
} from '../../packages/mcp/src/index.ts';
import { activityWorld, fakeActivityPorts, type ActivityPorts } from '../core/activity-world.ts';
import { COMPANION } from '../core/fakes.ts';
import { fakeMemoryPorts, type MemoryPorts } from '../core/memory-world.ts';

const SURFACE = 'mcp';

const direct = (externalId: string, channel: string, turnKind: 'foreground' | 'background' = 'foreground'): HostAttestation =>
  ({
    surface: SURFACE,
    principal: { kind: 'channel_account', identity: { channelKind: 'chat', externalId } },
    room: { kind: 'direct', channelId: channel },
    turnKind,
  }) as unknown as HostAttestation;

/** Operator bindings for the standard cast, plus deliberately bad ones. */
export const BINDINGS = {
  primary: direct('primary-handle', 'dm-primary'),
  friend: direct('friend-handle', 'dm-friend'),
  'friend-background': direct('friend-handle', 'dm-friend', 'background'),
  acquaintance: direct('acq-handle', 'dm-acq'),
  stranger: direct('stranger-handle', 'dm-stranger'),
  'friend-group': {
    surface: SURFACE,
    principal: { kind: 'channel_account', identity: { channelKind: 'chat', externalId: 'friend-handle' } },
    room: { kind: 'group', channelId: 'room-a', room: 'small_group' },
    turnKind: 'foreground',
  },
  self: { surface: SURFACE, principal: { kind: 'companion_internal', purpose: 'free_time' }, room: { kind: 'self' }, turnKind: 'background' },
  // Bound, but to nobody core knows.
  nobody: direct('nobody-handle', 'dm-nobody'),
  // A participant claiming the companion's own room.
  'self-claim': { surface: SURFACE, principal: { kind: 'channel_account', identity: { channelKind: 'chat', externalId: 'primary-handle' } }, room: { kind: 'self' }, turnKind: 'foreground' },
} as const;

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

export async function connectClient(url: string, credential: string | null): Promise<Client> {
  const client = new Client({ name: 'lite-mcp-test', version: '0.0.0' });
  openClients.push(client);
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

export async function mcpWorld<A extends ActivityPorts, M extends MemoryPorts>(activityPorts: A, memoryPorts: M) {
  const world = await activityWorld(activityPorts, memoryPorts);
  const credentials = freshCredentials();
  const env = Object.fromEntries(Object.entries(credentials).map(([p, c]) => [envName(p), c]));
  const loaded = loadPrincipalBindings(bindingConfig(), env);
  if (!loaded.ok) throw new Error(JSON.stringify(loaded.error));
  const bindings: McpPrincipalBindings = loaded.value;
  const ingress = createTrustedIngress({
    companionId: COMPANION,
    authenticator: bindings.authenticator,
    contacts: createContactAuthority(world.contactStore),
    policy: BASELINE_DISCLOSURE_POLICY,
  });
  if (!ingress.ok) throw new Error(JSON.stringify(ingress.error));
  const errors: McpErrorReport[] = [];
  const onError = (report: McpErrorReport) => errors.push(report);
  const built = createMcpSurface({ dispatcher: world.dispatcher, ingress: ingress.value, onError });
  if (!built.ok) throw new Error(JSON.stringify(built.error));
  const surface: McpSurface = built.value;
  const http = await startMcpHttpServer({ surface, bindings, port: 0, onError });
  if (!http.ok) throw new Error(JSON.stringify(http.error));
  openServers.push(http.value);
  const clients = new Map<Principal, Client>();
  const as = async (principal: Principal): Promise<Client> => {
    const existing = clients.get(principal);
    if (existing !== undefined) return existing;
    const client = await connectClient(http.value.url, credentials[principal]);
    clients.set(principal, client);
    return client;
  };
  return { ...world, world, credentials, env, bindings, mcpIngress: ingress.value, surface, url: http.value.url, errors, as };
}

export const fakeMcpWorld = () => mcpWorld(fakeActivityPorts(), fakeMemoryPorts());
