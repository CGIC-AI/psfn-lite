/**
 * The standalone host with the MCP transport and the lifecycle bridge
 * mounted: the composition an external companion host (Hermes) reaches.
 * Credentials are random per world and live only in the test environment;
 * the config names the variables, never the values.
 */
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import type { LiteRuntime } from '../../apps/standalone/src/index.ts';
import type { Script } from '../support/faux-model.ts';
import { beforeAll } from 'vitest';
import { HERMES_TEST_INSTALL_ID, RUNTIME_TIMEOUT_MS, newCredential, useLiteWorld } from '../support/lite-world.ts';

/** The operator through Hermes, and a regular friend through Hermes. */
export const HERMES_PRINCIPALS = { 'hermes-operator': 'operator', 'hermes-friend': 'sam' } as const;
export type HermesPrincipal = keyof typeof HERMES_PRINCIPALS;

const envName = (principal: string) => `LITE_HERMES_TEST_${principal.toUpperCase().replace(/-/g, '_')}`;

export interface BridgeWorld {
  readonly runtime: LiteRuntime;
  readonly credentials: Readonly<Record<HermesPrincipal, string>>;
  readonly mcpUrl: string;
  readonly lifecycleUrl: string;
  readonly model: { readonly calls: readonly { readonly lastUser: string }[] };
  /** The install's data directory and environment (the session keyring among it). */
  readonly install: { readonly dataDir: string; readonly env: Readonly<Record<string, string>> };
}

/** Registers the file's one bridge world: started before the file's tests, closed after them. */
export interface BridgeWorldOptions {
  readonly hostTurnTimeoutMs?: number;
  /** The lifecycle config's hosted automata policy; default null (automata run in core). */
  readonly automata?: { readonly maxAttempts: number; readonly leaseMs: number; readonly maxIterations: number } | null;
  /** The pi-ai API the world's faux model reports (tests/support/faux-model.ts FauxModelOptions). */
  readonly modelApi?: string;
}

/** The test Hermes install every bridge world serves; prepare and checkpoint bodies name it. */
export const INSTALL = HERMES_TEST_INSTALL_ID;

export function useBridgeWorld(script: Script, options: BridgeWorldOptions = {}): () => BridgeWorld {
  const lite = useLiteWorld();
  let world: BridgeWorld | null = null;
  beforeAll(async () => {
    world = await startWorld();
  }, RUNTIME_TIMEOUT_MS);
  return () => {
    if (world === null) throw new Error('the bridge world did not start');
    return world;
  };

  async function startWorld(): Promise<BridgeWorld> {
    const credentials = Object.fromEntries(Object.keys(HERMES_PRINCIPALS).map((p) => [p, newCredential()])) as Record<HermesPrincipal, string>;
    const install = await lite.install((document) => {
      document.mcp = {
        host: '127.0.0.1',
        port: 0,
        allowedHosts: null,
        bindings: Object.entries(HERMES_PRINCIPALS).map(([principal, contact]) => ({ principal, credential: { env: envName(principal) }, contact })),
      };
      document.lifecycle = { host: '127.0.0.1', port: 0, allowedHosts: null,
        hostTurnTimeoutMs: options.hostTurnTimeoutMs ?? 60_000,
        hermesInstallId: HERMES_TEST_INSTALL_ID,
        automata: options.automata ?? null,
      };
    });
    Object.assign(install.env, Object.fromEntries(Object.entries(credentials).map(([p, c]) => [envName(p), c])));
    const { runtime, model } = await lite.start(install, script, options.modelApi === undefined ? {} : { api: options.modelApi });
    const { mcpUrl, lifecycleUrl } = runtime.transports;
    if (mcpUrl === null || lifecycleUrl === null) throw new Error('transports were not mounted');
    return { runtime, credentials, mcpUrl, lifecycleUrl, model, install: { dataDir: install.dataDir, env: install.env } };
  }
}

export interface BridgeReply {
  readonly status: number;
  readonly body: Record<string, unknown>;
}

/** One bridge call as a host makes it: a bearer credential and a JSON body. */
export async function bridge(world: Pick<BridgeWorld, 'lifecycleUrl'>, route: string, credential: string | null, body: unknown): Promise<BridgeReply> {
  const response = await fetch(`${world.lifecycleUrl}/${route}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(credential === null ? {} : { Authorization: `Bearer ${credential}` }) },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

/** An MCP client as a host connects it, with its bearer credential. */
export async function mcpClient(world: Pick<BridgeWorld, 'mcpUrl'>, credential: string): Promise<Client> {
  const client = new Client({ name: 'lite-test-host', version: '0.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(world.mcpUrl), { requestInit: { headers: { Authorization: `Bearer ${credential}` } } }));
  return client;
}
