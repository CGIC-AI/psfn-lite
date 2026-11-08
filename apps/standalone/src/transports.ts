/**
 * The external transports a standalone runtime may mount, each only when
 * the config names it: the governed tool transport over MCP HTTP and the
 * lifecycle bridge an external companion host (such as Hermes) drives its
 * turns through. Both bind loopback unless the config names the Host values
 * a wider address serves. Callers are bound from their transport credential
 * by the operator's bindings, or by a credential minted for one internal
 * turn; core ingress admits every request, and the CLI's own evidence stays
 * with the local host.
 */
import {
  createHostedTurns,
  createTurnContextAssembler,
  denied,
  invalid,
  ok,
  type CallerAuthenticatorPort,
  type Clock,
  type HostedTurns,
  type InternalTurnPort,
  type Result,
} from './core.ts';
import type { LiteConfig } from './config.ts';
import {
  abandonDelegatedTurn,
  createDelegatedInternalTurns,
  startLifecycleBridge,
  type DelegatedInternalTurns,
  type LifecycleErrorReport,
} from './lifecycle.ts';
import {
  combineCallers,
  createMcpInternalTurns,
  createMcpSurface,
  loadPrincipalBindings,
  startMcpHttpServer,
  type McpCallers,
  type McpErrorReport,
} from './mcp.ts';
import type { LiteStacks } from './stacks.ts';
import type { LiteStorage } from './storage.ts';

export type TransportReport = { readonly kind: 'mcp'; readonly report: McpErrorReport } | { readonly kind: 'lifecycle'; readonly report: LifecycleErrorReport };

/** What exists before core's stacks are built: the callers, and who runs internal turns. */
export interface TransportCallers {
  /** The local host's evidence, then the transport credentials. */
  readonly authenticator: CallerAuthenticatorPort;
  /** Null when internal turns run in this process's harness; otherwise core's port to the delegated host. */
  readonly internalTurns: InternalTurnPort | null;
  mount(parts: { readonly stacks: LiteStacks; readonly storage: LiteStorage }): Promise<Result<MountedTransports>>;
}

export interface MountedTransports {
  /** Null when not configured. */
  readonly mcpUrl: string | null;
  readonly lifecycleUrl: string | null;
  /** Stops accepting requests and fails delegated internal turns that have not settled. */
  close(): Promise<void>;
}

export function prepareTransports(input: {
  readonly config: LiteConfig;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly clock: Clock;
  readonly local: CallerAuthenticatorPort;
  readonly onReport: (report: TransportReport) => void;
}): Result<TransportCallers> {
  const { config } = input;
  if (config.mcp === null) {
    return ok({ authenticator: input.local, internalTurns: null, mount: () => Promise.resolve(ok({ mcpUrl: null, lifecycleUrl: null, close: () => Promise.resolve() })) });
  }
  const mcp = config.mcp;
  const bindings = loadPrincipalBindings({ bindings: mcp.bindings }, input.env);
  if (!bindings.ok) return bindings;
  const minted = createMcpInternalTurns({ ttlMs: mcp.internalTurnTtlMs, maxOpen: mcp.maxOpenInternalTurns, now: () => input.clock.now().getTime() });
  if (!minted.ok) return minted;
  const callers = combineCallers(bindings.value, minted.value);

  const delegation = config.lifecycle?.internalTurns;
  let hosted: HostedTurns | null = null;
  const onLifecycle = (report: LifecycleErrorReport) => input.onReport({ kind: 'lifecycle', report });
  let delegated: DelegatedInternalTurns | null = null;
  if (delegation?.kind === 'delegated') {
    if (!bindings.value.principals.includes(delegation.host)) {
      return invalid(`lifecycle.internalTurns.host ${delegation.host} is not a bound principal`);
    }
    const built = createDelegatedInternalTurns({
      credentials: minted.value,
      claimTimeoutMs: delegation.claimTimeoutMs,
      runTimeoutMs: delegation.runTimeoutMs,
      abandon: abandonDelegatedTurn(() => hosted, onLifecycle),
    });
    if (!built.ok) return built;
    delegated = built.value;
  }

  return ok({
    authenticator: localThenTransport(input.local, callers),
    internalTurns: delegated?.port ?? null,
    async mount({ stacks, storage }) {
      const onMcp = (report: McpErrorReport) => input.onReport({ kind: 'mcp', report });
      const surface = createMcpSurface({ dispatcher: stacks.activity.dispatcher, ingress: stacks.ingress, onError: onMcp });
      if (!surface.ok) return surface;
      const server = await startMcpHttpServer({
        surface: surface.value,
        bindings: callers,
        port: mcp.port,
        host: mcp.host,
        ...(mcp.allowedHosts === null ? {} : { exposeBeyondLoopback: { allowedHosts: mcp.allowedHosts } }),
        onError: onMcp,
      });
      if (!server.ok) return server;
      const lifecycle = config.lifecycle;
      if (lifecycle === null) return ok({ mcpUrl: server.value.url, lifecycleUrl: null, close: () => server.value.close() });
      hosted = createHostedTurns({
        lifecycle: stacks.lifecycle,
        ledger: storage.state.ledger,
        archive: storage.archive,
        sessions: stacks.sessions,
        context: createTurnContextAssembler({ orientation: stacks.orientation, selfState: stacks.selfState, activity: stacks.activity.activity, archive: storage.archive }),
        emotion: stacks.emotion,
        workers: stacks.activity.workers,
        limits: { historyEntries: config.harness.historyEntries, selfStateItems: config.harness.selfStateItems },
      });
      const bridge = await startLifecycleBridge({
        hosted,
        ingress: stacks.ingress,
        callers,
        delegated,
        internalTurnHost: lifecycle.internalTurns.kind === 'delegated' ? lifecycle.internalTurns.host : null,
        port: lifecycle.port,
        host: lifecycle.host,
        ...(lifecycle.allowedHosts === null ? {} : { exposeBeyondLoopback: { allowedHosts: lifecycle.allowedHosts } }),
        onError: onLifecycle,
      });
      if (!bridge.ok) {
        await server.value.close();
        return bridge;
      }
      return ok({
        mcpUrl: server.value.url,
        lifecycleUrl: bridge.value.url,
        async close() {
          await Promise.allSettled([bridge.value.close(), server.value.close()]);
          await delegated?.close();
        },
      });
    },
  });
}

/** The CLI's in-process evidence first; anything it did not issue goes to the transport credentials. */
function localThenTransport(local: CallerAuthenticatorPort, callers: McpCallers): CallerAuthenticatorPort {
  return {
    async authenticate(evidence) {
      const own = await local.authenticate(evidence);
      if (own.ok || own.error.kind !== 'denied' || own.error.reason !== 'unknown_authority') return own;
      const transport = await callers.authenticator.authenticate(evidence);
      return transport.ok || transport.error.kind !== 'denied' ? transport : denied('unknown_authority', 'evidence was not issued by this host or a bound credential');
    },
  };
}
