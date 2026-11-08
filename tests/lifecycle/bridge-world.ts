/**
 * The standalone runtime with the MCP transport and the lifecycle bridge
 * mounted, over a throwaway Postgres: the composition an external companion
 * host (Hermes) reaches. Credentials are random per world and live only in
 * the test environment; the config names the variables, never the values.
 */
import { randomBytes } from 'node:crypto';
import type { LiteRuntime } from '../../apps/standalone/src/index.ts';
import type { Brain } from '../pi/faux-brain.ts';
import { unwrap, useStandalone } from '../standalone/standalone-world.ts';
import { HERMES_BINDINGS } from './bindings.ts';

export { HERMES_BINDINGS };

export type HermesPrincipal = keyof typeof HERMES_BINDINGS;

const envName = (principal: string) => `LITE_HERMES_TEST_${principal.toUpperCase().replace(/-/g, '_')}`;

export interface BridgeWorld {
  readonly runtime: LiteRuntime;
  readonly credentials: Readonly<Record<HermesPrincipal, string>>;
  readonly mcpUrl: string;
  readonly lifecycleUrl: string;
  readonly diagnostics: readonly unknown[];
  /** Registers the operator and the friend contact. */
  seedContacts(): Promise<void>;
}

export function useBridgeWorld() {
  const lite = useStandalone();
  return async (brain: Brain, options: { readonly delegated: boolean }): Promise<BridgeWorld> => {
    const install = await lite.install();
    const credentials = Object.fromEntries(Object.keys(HERMES_BINDINGS).map((p) => [p, randomBytes(32).toString('base64url')])) as Record<HermesPrincipal, string>;
    const document = {
      ...install.document,
      mcp: {
        host: '127.0.0.1',
        port: 0,
        allowedHosts: null,
        bindings: Object.entries(HERMES_BINDINGS).map(([principal, attestation]) => ({ principal, credential: { env: envName(principal) }, attestation })),
        internalTurnTtlMs: 120_000,
        maxOpenInternalTurns: 4,
      },
      lifecycle: {
        host: '127.0.0.1',
        port: 0,
        allowedHosts: null,
        internalTurns: options.delegated ? { kind: 'delegated', host: 'hermes-operator', claimTimeoutMs: 20_000, runTimeoutMs: 60_000 } : { kind: 'harness' },
      },
    };
    const env = { ...install.env, ...Object.fromEntries(Object.entries(credentials).map(([p, c]) => [envName(p), c])) };
    const started = await lite.start({ ...install, document, env }, brain, 'bridge-1');
    const { runtime } = started;
    const { mcpUrl, lifecycleUrl } = runtime.transports;
    if (mcpUrl === null || lifecycleUrl === null) throw new Error('transports were not mounted');
    return {
      runtime,
      credentials,
      mcpUrl,
      lifecycleUrl,
      diagnostics: started.diagnostics,
      async seedContacts() {
        unwrap(await runtime.ensureOperator());
        unwrap(
          await runtime.stacks.contactAdmin.register('test:seed', {
            displayName: 'Sam',
            identity: { channelKind: 'telegram', externalId: 'friend-1' },
            trust: 'regular',
            relationship: 'friend',
            consent: 'granted',
            sensitivity: 'personal',
          }),
        );
      },
    };
  };
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
