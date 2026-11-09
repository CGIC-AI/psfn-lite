/**
 * The standalone host: a thin wrapper over the extracted companion core's
 * composition root (`startCompanionRuntime`). It builds the host's ports
 * (the Pi model runtime, the session keyring from the
 * environment, the operator's outbound channel), the donor substrate config
 * and the inner-life owner files, starts the companion, provisions the
 * configured contacts, and mounts the MCP tool transport and the lifecycle
 * bridge for an external companion host when the config names them.
 */
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  COMPANION_SEED_DIR,
  HostedAutomataExecutor,
  createSessionHmacBoundaryService,
  createTurnId,
  loadInnerLifeConfig,
  resolveRuntimePathSnapshotFromConfig,
  startCompanionRuntime,
  type AgentResponse,
  type CompanionRuntime,
  type EmbeddingRuntimeProvider,
  type HostedAutomataEvent,
  type ProviderRuntime,
  type StartCompanionRuntimeOptions,
  type TrustLevel,
} from './companion.ts';
import type { LiteConfig, LiteSecrets } from './config.ts';
import { createHostSessionIntegrityProvider } from './session-integrity.ts';
import {
  HostMemoryDeletionApprovals,
  HostTurnBridge,
  HostTurnRelay,
  createHostToolPort,
  startLifecycleBridge,
  type LifecycleBridge,
  type LifecycleErrorReport,
} from './lifecycle.ts';
import {
  createMcpSurface,
  invalid,
  loadPrincipalBindings,
  ok,
  startMcpHttpServer,
  unavailable,
  type McpErrorReport,
  type McpHttpServer,
  type McpPrincipalBindings,
  type Result,
} from './mcp.ts';
import {
  companionEmbeddingProviderOf,
  companionModelRegistryEntryOf,
  companionProviderRuntimeOf,
  createCatalogModelRuntime,
  type EmbeddingPort,
  type PiModelRuntime,
} from './pi.ts';
import { createModelUsageLedger, type ModelUsageSnapshot } from './model-usage.ts';
import { composeGardenServices, startGardenServer, type GardenErrorReport, type GardenServer } from './operator.ts';
import { buildSubstrateConfig } from './substrate-config.ts';

/** The contact key of the configured operator. */
export const OPERATOR_CONTACT = 'operator';
/** The contact-store channel a Lite host records its contact keys under. */
export const LITE_CONTACT_CHANNEL = 'lite';
/** The registry entry id of the host model (companionModelRegistryEntryOf's default). */
export const HOST_MODEL_ENTRY = 'host-model';

export type LiteDiagnostic =
  | { readonly kind: 'outbound'; readonly channelId: string; readonly content: string }
  | { readonly kind: 'mcp'; readonly report: McpErrorReport }
  | { readonly kind: 'lifecycle'; readonly report: LifecycleErrorReport }
  | { readonly kind: 'garden'; readonly report: GardenErrorReport }
  | { readonly kind: 'automata'; readonly event: HostedAutomataEvent }
  | { readonly kind: 'host_turn_timeout'; readonly turnId: string };

/** Host ports a caller may supply instead of the configured ones (tests, embedding hosts). */
export interface LiteRuntimeOverrides {
  readonly model?: PiModelRuntime;
  /** An embedding port serving `config.embedding.model` at `config.embedding.dimensions`, in place of the configured donor provider. */
  readonly embeddings?: EmbeddingPort;
  readonly textEmotionClassifier?: StartCompanionRuntimeOptions['textEmotionClassifier'];
}

export interface LiteRuntime {
  readonly config: LiteConfig;
  readonly companion: CompanionRuntime;
  /** The companion contact id of each configured contact key (`operator` included). */
  readonly contactIds: ReadonlyMap<string, string>;
  /** The host-driven turn bridge; null without a lifecycle config. */
  readonly bridge: HostTurnBridge | null;
  readonly transports: { readonly mcpUrl: string | null; readonly lifecycleUrl: string | null; readonly gardenUrl: string | null };
  /** One operator turn in the operator's terminal conversation, through the donor SubstrateAgent. */
  converse(text: string): Promise<AgentResponse>;
  /** Aborts the operator's running turn (donor SubstrateAgent.abort). */
  interrupt(): void;
  /** Model and embedding usage since start, from the host's model-usage recorder (seam 3.1). */
  modelUsage(): ModelUsageSnapshot;
  close(): Promise<void>;
}

export function operatorChannelId(config: LiteConfig): string {
  return `terminal:${config.operator.userId}`;
}

function buildModel(config: LiteConfig, secrets: LiteSecrets, overrides: LiteRuntimeOverrides): Result<PiModelRuntime> {
  if (overrides.model !== undefined) return ok(overrides.model);
  return createCatalogModelRuntime({
    provider: config.model.provider,
    modelId: config.model.modelId,
    apiKey: secrets.modelApiKey,
    maxOutputTokens: config.model.maxOutputTokens,
  });
}

/**
 * The embedding provider a caller supplies, or none. Without one the donor's
 * composition builds the configured provider itself from the substrate
 * config (provider-runtime-factory.ts: `options.embeddingProvider ??
 * createEmbeddingProviderFromConfig(config, env)`): the donor's
 * transformers, ollama or api provider (substrate-config.ts embeddingSettings),
 * checked by its fail-closed startup warmup (`warmupEmbeddingProvider`).
 */
function hostEmbeddingProvider(config: LiteConfig, overrides: LiteRuntimeOverrides): { embeddingProvider?: EmbeddingRuntimeProvider } {
  if (overrides.embeddings === undefined) return {};
  const identity = { model: config.embedding.model, dimensions: config.embedding.dimensions };
  return { embeddingProvider: companionEmbeddingProviderOf(overrides.embeddings, identity) as EmbeddingRuntimeProvider };
}

export async function createLiteRuntime(input: {
  readonly config: LiteConfig;
  readonly secrets: LiteSecrets;
  /** The process environment: the keyring and the transport credentials are read from it. */
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly onDiagnostic: (diagnostic: LiteDiagnostic) => void;
  readonly overrides?: LiteRuntimeOverrides;
}): Promise<Result<LiteRuntime>> {
  const { config, secrets, env, onDiagnostic } = input;
  const overrides = input.overrides ?? {};
  const model = buildModel(config, secrets, overrides);
  if (!model.ok) return model;

  const contactKeys = new Map<string, { displayName: string; trust: TrustLevel }>([
    [OPERATOR_CONTACT, { displayName: config.operator.displayName, trust: 'primary' }],
    ...config.contacts.map((c) => [c.key, { displayName: c.displayName, trust: c.trust }] as const),
  ]);
  const bindings = config.mcp === null ? null : loadPrincipalBindings(config.mcp.bindings, env);
  if (bindings !== null && !bindings.ok) return bindings;
  const unknownContacts = (bindings?.value.bindings ?? []).filter((b) => !contactKeys.has(b.contact));
  if (unknownContacts.length > 0) return invalid(...unknownContacts.map((b) => `binding ${b.principal} names an unknown contact ${b.contact}`));
  const gardenBindings = loadGardenBindings(config, env);
  if (!gardenBindings.ok) return gardenBindings;

  let sessionIntegrityProvider: StartCompanionRuntimeOptions['sessionIntegrityProvider'] = null;
  if (config.sessionIntegrity.kind === 'keyring') {
    // The donor HMAC chain over the env keyring (seam 3.8); a Hermes install's conversations use the keyring scoped to it (Step E2).
    const keyring = createSessionHmacBoundaryService({ env: { ...env } }).resolveKeyring();
    if (keyring === null) return invalid('sessionIntegrity keyring: the session HMAC keyring environment variables are not set');
    sessionIntegrityProvider = createHostSessionIntegrityProvider(keyring, config.lifecycle?.hermesInstallId ?? null);
  }

  const seedDir = fileURLToPath(COMPANION_SEED_DIR);
  // The donor's seed loaders read the process environment's CONFIG_DIR and
  // fall back to ./config of the working directory (the donor repository
  // root); a host process that was not given one points them at the
  // companion's shipped seeds.
  process.env['CONFIG_DIR'] ??= seedDir;
  const registry = { models: [companionModelRegistryEntryOf(model.value, HOST_MODEL_ENTRY)] };
  const relay = config.lifecycle === null ? null : new HostTurnRelay();
  // Memory deletion in a host-driven turn is approved by the host's human (docs/extraction.md, Step E3).
  const memoryDeletion = relay === null || config.lifecycle === null
    ? null
    : new HostMemoryDeletionApprovals({ relay, approvalWindowMs: config.lifecycle.hostTurnTimeoutMs });
  const modelUsage = createModelUsageLedger();
  // Hosted automata: spawned automata run as host subagents, attempt by attempt (docs/extraction.md, operator automata rules).
  const automata = config.lifecycle?.automata == null
    ? null
    : new HostedAutomataExecutor(config.lifecycle.automata, { onEvent: (event) => onDiagnostic({ kind: 'automata', event }) });
  let companion: CompanionRuntime;
  try {
    const innerLife = loadInnerLifeConfig({ dataDir: config.dataDir, seedDir, modelRegistry: registry as never });
    const substrateConfig = buildSubstrateConfig(config, {
      databaseUrl: secrets.databaseUrl,
      model: {
        modelId: model.value.model.id,
        provider: model.value.model.provider,
        maxOutputTokens: model.value.maxOutputTokens,
        contextWindow: model.value.model.contextWindow,
        registry,
      },
    });
    companion = await startCompanionRuntime({
      config: substrateConfig,
      // The donor read WORKSPACE_PATH (and its logs and temp roots) from the environment of its fleet startup (cut); Lite names them in its config.
      pathSnapshot: resolveRuntimePathSnapshotFromConfig(substrateConfig, {
        workspacePath: config.workspaceDir,
        logsDir: join(config.dataDir, 'logs'),
        tempDir: join(config.dataDir, 'tmp'),
      }),
      innerLife,
      providerRuntime: companionProviderRuntimeOf(model.value) as unknown as ProviderRuntime,
      modelUsageRecorder: modelUsage,
      ...hostEmbeddingProvider(config, overrides),
      ...(overrides.textEmotionClassifier === undefined ? {} : { textEmotionClassifier: overrides.textEmotionClassifier }),
      sessionIntegrityProvider,
      outboundSender: {
        send: (channelId, content) => {
          onDiagnostic({ kind: 'outbound', channelId, content });
          return Promise.resolve();
        },
      },
      heartbeatChannel: { channelId: operatorChannelId(config), channelType: 'terminal' },
      env: { ...env, CONFIG_DIR: seedDir },
      ...(relay === null ? {} : { wrapStreamTransport: relay.wrapTransport }),
      automataHostExecution: automata,
      ...(memoryDeletion === null ? {} : { memoryDeletionApprovalPort: memoryDeletion }),
    });
    memoryDeletion?.attach(companion.persistence.memoryDeletionProposalStore);
  } catch (error) {
    automata?.close();
    return unavailable('companion_runtime', error instanceof Error ? error.message : 'the companion runtime did not start');
  }

  const opened: { close(): Promise<void> }[] = [];
  const closeAll = async (): Promise<void> => {
    for (const handle of opened.reverse()) await handle.close();
    // Open hosted attempts end before the companion stops, so their automata settle as failed rather than hang.
    automata?.close();
    await companion.stop();
  };

  // Contacts: one per configured key, found again by its key on every start.
  const contactIds = new Map<string, string>();
  try {
    for (const [key, contact] of contactKeys) {
      const existing = await companion.persistence.contactStore?.getByChannelIdentity(LITE_CONTACT_CHANNEL, key);
      const record = existing ?? await companion.persistence.contactStore?.upsert(
        { displayName: contact.displayName, trustLevel: contact.trust, channels: [{ channel: LITE_CONTACT_CHANNEL, userId: key, privacyLevel: 'private' }] },
        { allowPrimaryTrustAssignment: contact.trust === 'primary' },
      );
      if (record === undefined) throw new Error('the companion has no contact store');
      contactIds.set(key, record.id);
    }
  } catch (error) {
    await closeAll();
    return unavailable('contacts', error instanceof Error ? error.message : 'contact provisioning failed');
  }

  let bridge: HostTurnBridge | null = null;
  let mcpUrl: string | null = null;
  let lifecycleUrl: string | null = null;
  if (bindings !== null && config.mcp !== null) {
    const principals = bindings.value;
    const primaryPrincipal = (principal: string): boolean => {
      const key = principals.contactOf(principal);
      return key !== null && contactKeys.get(key)?.trust === 'primary';
    };
    if (relay !== null && config.lifecycle !== null) {
      relay.attach(companion.agentLoop);
      bridge = new HostTurnBridge({
        relay,
        agent: companion.agentLoop,
        companionId: config.companionId,
        hermesInstallId: config.lifecycle.hermesInstallId,
        contactOf: (principal) => {
          const key = principals.contactOf(principal);
          const contactId = key === null ? undefined : contactIds.get(key);
          const contact = key === null ? undefined : contactKeys.get(key);
          return contactId === undefined || contact === undefined ? null : { contactId, displayName: contact.displayName };
        },
        findRecordedTurn: (channelId, turnId) => companion.sessionManager.findUniqueSourceRecordedTurn(channelId, turnId),
        maxOpenMs: config.lifecycle.hostTurnTimeoutMs,
        onTimeout: (turnId) => onDiagnostic({ kind: 'host_turn_timeout', turnId }),
      });
    }
    const port = bridge === null
      ? { tools: () => [], call: () => Promise.resolve(unavailable<never>('host_turns', 'no lifecycle bridge is configured')) }
      : createHostToolPort(companion.agentLoop, bridge);
    const surface = createMcpSurface({ port, identify: (credential) => principals.identify(credential), onError: (report) => onDiagnostic({ kind: 'mcp', report }) });
    const mcp: Result<McpHttpServer> = await startMcpHttpServer({
      surface,
      bindings: principals,
      port: config.mcp.port,
      host: config.mcp.host,
      ...(config.mcp.allowedHosts === null ? {} : { exposeBeyondLoopback: { allowedHosts: config.mcp.allowedHosts } }),
      onError: (report) => onDiagnostic({ kind: 'mcp', report }),
    });
    if (!mcp.ok) {
      await closeAll();
      return mcp;
    }
    opened.push(mcp.value);
    mcpUrl = mcp.value.url;
    if (bridge !== null && config.lifecycle !== null) {
      const lifecycle: Result<LifecycleBridge> = await startLifecycleBridge({
        bridge,
        identify: (credential) => principals.identify(credential),
        port: config.lifecycle.port,
        host: config.lifecycle.host,
        ...(config.lifecycle.allowedHosts === null ? {} : { exposeBeyondLoopback: { allowedHosts: config.lifecycle.allowedHosts } }),
        onError: (report) => onDiagnostic({ kind: 'lifecycle', report }),
        automata,
        // Automata carry the companion's private work: only a principal bound to a primary contact runs them.
        automataAdmits: primaryPrincipal,
        memoryDeletion,
        // The primary contact decides memory deletions, as the donor's Operator validated them.
        primaryAdmits: primaryPrincipal,
      });
      if (!lifecycle.ok) {
        await closeAll();
        return lifecycle;
      }
      opened.push(lifecycle.value);
      lifecycleUrl = lifecycle.value.url;
    }
  }

  // The light Garden (docs/extraction.md, seam S8): the operator API over the running companion's own instances.
  let gardenUrl: string | null = null;
  if (gardenBindings.value !== null && config.garden !== null) {
    const garden: Result<GardenServer> = await startGardenServer({
      services: composeGardenServices(companion, { dataDir: config.dataDir, seedDir }, { contactId: contactIds.get(OPERATOR_CONTACT) ?? '' }),
      host: {
        model: { provider: model.value.model.provider, modelId: model.value.model.id },
        awaitingHostTurn: (proposalId) => memoryDeletion?.awaiting(proposalId) ?? false,
        recentTurnLimit: config.garden.recentTurnLimit,
      },
      identify: gardenBindings.value.identify,
      port: config.garden.port,
      listenHost: config.garden.host,
      ...(config.garden.allowedHosts === null ? {} : { exposeBeyondLoopback: { allowedHosts: config.garden.allowedHosts } }),
      maxBodyBytes: config.garden.maxBodyBytes,
      onError: (report) => onDiagnostic({ kind: 'garden', report }),
    });
    if (!garden.ok) {
      await closeAll();
      return garden;
    }
    opened.push(garden.value);
    gardenUrl = garden.value.url;
  }

  const operatorContact = contactIds.get(OPERATOR_CONTACT) ?? '';
  let closed: Promise<void> | null = null;
  return ok({
    config,
    companion,
    contactIds,
    bridge,
    transports: { mcpUrl, lifecycleUrl, gardenUrl },
    converse: (text) =>
      companion.agentLoop.handleMessage({
        id: `cli:${createTurnId()}`,
        channelId: operatorChannelId(config),
        channelType: 'terminal',
        authorId: config.operator.userId,
        authorName: config.operator.displayName,
        content: text,
        timestamp: new Date(),
        isDirectMessage: true,
        routing: { canonicalContactId: operatorContact },
      }),
    interrupt: () => {
      companion.agentLoop.abort();
    },
    modelUsage: () => modelUsage.snapshot(),
    close: () => (closed ??= closeAll()),
  });
}

/**
 * The Garden's principal bindings (seam S8). Each is bound to the primary
 * contact, who is the donor's Garden operator. A Garden credential or
 * principal is never also an MCP one, so a tool transport credential never
 * opens the Garden: loading both lists together refuses a shared one.
 */
function loadGardenBindings(config: LiteConfig, env: Readonly<Record<string, string | undefined>>): Result<McpPrincipalBindings | null> {
  if (config.garden === null) return ok(null);
  const bindings = loadPrincipalBindings(config.garden.bindings, env);
  if (!bindings.ok) return invalid(...prefixed('garden', bindings.error));
  const strangers = bindings.value.bindings.filter((b) => b.contact !== OPERATOR_CONTACT);
  if (strangers.length > 0) return invalid(...strangers.map((b) => `garden binding ${b.principal} must name the primary contact ${OPERATOR_CONTACT}, not ${b.contact}`));
  if (config.mcp !== null) {
    const together = loadPrincipalBindings([...config.mcp.bindings, ...config.garden.bindings], env);
    if (!together.ok) return invalid(...prefixed('garden and mcp together', together.error));
  }
  return bindings;
}

function prefixed(at: string, error: { readonly kind: string; readonly issues?: readonly string[] }): string[] {
  return (error.issues ?? [error.kind]).map((issue) => `${at}: ${issue}`);
}
