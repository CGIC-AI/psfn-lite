// ── Shared Runtime Composition ──
// Common builders used across runtime, agent container, CLI, and test harnesses.
//
// Intentional wiring differences:
// - src/app/agent/main.ts runs in split mode (gateway + isolated agent) and wires gateway-backed providers.
// Keep core construction through these helpers so behavior stays aligned across split entrypoints.
//
// Lite cut (seam 3.11, extraction/cuts.tsv): the Redis session tail, the CogSec
// session-integrity and projection-drift incident observers, the fatigue
// ledgers, the shard manager, the analysis workbench and the operator hook
// runtime are cut. wireShardAndThinkRuntime is now wireSubagentRuntime: the
// subagent faculty, its fold-review queue and the subagent tool are kept.

import type { RetrievalDecisionPort } from '../../../faculties/memory/retrieval/decision-routing.js';
import type { CoreSubstrateConfig, SubstrateConfig } from '../../../system/config/runtime-config-contracts.js';
import type { PlacesRegistryConfig } from '../../../shared/contracts/places-registry.js';
import type { EventBus } from '../../../shared/event-bus.js';
import type { AppCache } from '../../../shared/cache/types.js';
import { isRecord } from '../../../shared/utils/types.js';
import { wireRuntimeDiagnosticsEventCapture } from '../../../shared/diagnostics/runtime-diagnostics.js';
import { createEventBusCostTelemetryPort } from '../../../shared/telemetry/cost-telemetry-port.js';
import { SessionStore, type SessionIntegrityProvider } from '../../../persistence/sessions/store.js';
import type { SessionTailCachePort } from '../../../persistence/sessions/session-tail-cache-port.js';
import { SessionManager } from '../../../core/session/manager.js';
import { UserContinuityStore } from '../../../core/session/continuity.js';
import {
  createDisabledCrossChannelContinuityPort,
  createUserContinuityPort,
} from '../../../core/session/cross-channel-continuity-port.js';
import { InternalRoleEnvelopeLedgerStore } from '../../../core/internal-role-envelopes/store.js';
import { wireInternalRoleEnvelopeRuntime } from '../../../core/internal-role-envelopes/runtime-wiring.js';
import { MemoryJournal } from '../../../faculties/memory/journal.js';
import { createPostgresMemoryStore } from '../../../faculties/memory/postgres-store.js';
import {
  SubstrateAgent,
  type EmotionRuntimeWiring,
  type SubstrateAgentOptions,
} from '../../../core/agent/substrate-agent.js';
import type { ObserverEvalSidecarRuntime } from '../../../core/eval/observer-sidecar/types.js';
import { MemoryRetriever } from '../../../faculties/memory/retrieval.js';
import type { EpisodicRetrievalStore } from '../../../faculties/memory/retrieval/episodic.js';
import {
  MemoryExtractor,
  type MemoryExtractorFormationOptions,
} from '../../../faculties/memory/extraction.js';
import type { ConcernCandidateExtractionSink } from '../../../faculties/memory/extraction/types.js';
import { MemoryWriter } from '../../../faculties/memory/writer.js';
import { createCompanionRoomMembershipAuthority } from '../../../faculties/memory/companion-provenance.js';
import type {
  CoreMemoryStorePort,
  MemoryStorePort,
} from '../../../faculties/memory/memory-store-port.js';
import { createCoreMemoryStorePort } from '../../../faculties/memory/memory-store-port.js';
import type { ContactStorePort } from '../../../core/contacts/contact-store-port.js';
import type { ContactTrackingGate } from '../../../core/contacts/tracking-gate.js';
import type { AutomataRunRegistry } from '../../../faculties/automata/run-registry.js';
import type { AutomataSessionClassificationService } from '../../../faculties/automata/session-classification.js';
import type { AutomataBusWorkerAccess } from '../../../faculties/automata/bus/worker-access.js';
import type { CapabilityGrantSnapshot } from '../../../system/capabilities/access.js';
import type { AutomataTerminalLifecyclePort } from '../../../faculties/automata/terminal-lifecycle.js';
import { ShardFoldReviewController } from '../../../faculties/shards/fold-review.js';
import { SubagentFaculty, type SubagentAuditTrail } from '../../../faculties/subagents/faculty.js';
import type { SubagentHostExecutionPort } from '../../../faculties/subagents/host-execution.js';
import { createSubagentTool } from '../../../faculties/subagents/tools.js';
import { CoreMemoryStore } from '../../../faculties/core-memory/store.js';
import { createOrientTool } from '../../../faculties/core-memory/tools.js';
import { resolveCurrentInternalStateConcernVAD } from '../../../core/intention/concern-grooming.js';
import { ValuesJournalStore } from '../../../faculties/values/store.js';
import type { IntrospectionConsentStore } from '../../../faculties/introspection/consent-store.js';
import type { IntrospectionTurnSensitivityDecisions } from '../../../faculties/introspection/turn-sensitivity.js';
import { loadCharacterCard, composeSystemPrompt } from '../../../core/identity/loader.js';
import { resolveCompanionIdFromConfig } from '../../../core/identity/companion-runtime.js';
import type { RuntimeCompanionId } from '../../../shared/routing/companion-id.js';
import type { CharacterCardV2 } from '../../../core/identity/types.js';
import type { LLMProviderPort, MemoryProvider } from '../../../core/agent/contracts.js';
import type { ProviderRuntime } from '../../../primitives/llm/provider-runtime.js';
import type { EmbeddingProviderPort } from '../../../shared/contracts/embedding-provider.js';
import type { PromptRegistryStatePort } from '../../../core/identity/prompt-state-port.js';
import type { PersonaPreamblePort } from '../../../core/identity/persona-preamble.js';
import type { ToolWiringValidationMode } from '../../../core/agent/tool-wiring-validator.js';
import type { ConcernStorePort } from '../../../core/intention/concern-store-port.js';
import {
  migrateLegacyPersistenceLayout,
  resolveBackupsDir,
  resolveConfiguredCompanionDataDir,
  resolveCoreMemoryPath,
  resolveContinuityDir,
  resolveLegacyValuesJournalPath,
  resolveMemoryJournalPath,
  resolveNotesDir,
  resolveShardFoldReviewStorePath,
  resolveScratchpadMirrorPath,
  resolveSessionsDir,
  resolveValuesJournalPath,
} from '../../../persistence/layout.js';
import { createBackgroundWorkHandoffRecoveryDisposition } from '../../../persistence/repair/background-work-handoff-recovery-disposition.js';
import { createDefaultPostgresSessionAdapters } from '../../../persistence/sessions/postgres-adapters.js';
import { FilesystemAutomataRetentionWriteBarrier } from '../../../persistence/sessions/automata-retention-write-barrier.js';
import { awaitPostgresStoreReadiness } from '../../../persistence/postgres/runtime-readiness.js';
import { resolveConfigTenantPoolScope } from '../../../persistence/postgres/tenant-pool-scope.js';
import { createSafeguardAuditTrail } from '../../../system/capabilities/safeguards.js';
import { createComponentLogger } from '../../../shared/logger.js';
import { toErrorMessage } from '../../../shared/utils/errors.js';

const log = createComponentLogger('StartupComposition');

export interface SessionComposition {
  sessionStore: SessionStore;
  sessionManager: SessionManager;
  continuityStore: UserContinuityStore | null;
  internalRoleEnvelopeLedger: InternalRoleEnvelopeLedgerStore;
  /** Non-null only when settings.json sessionTailCache.enabled=true (psfn-framework-hgw3.5). */
  sessionTailCache: SessionTailCachePort | null;
  sessionsDir: string;
  exactSessionProjection: Awaited<ReturnType<typeof createDefaultPostgresSessionAdapters>>['exactSessionProjection'];
  conversationalActivityWorkset: Awaited<ReturnType<typeof createDefaultPostgresSessionAdapters>>['conversationalActivityWorkset'];
  exactSessionWriteBarrier: FilesystemAutomataRetentionWriteBarrier;
}

interface SessionCompositionBaseOptions {
  config: SubstrateConfig;
  /**
   * Explicit database credential for callers whose core config is
   * intentionally secret-sanitized. When absent, legacy/full-config callers
   * may still supply config.postgresDatabaseUrl.
   */
  postgresDatabaseUrl?: string;
  eventBus?: EventBus;
  sessionsDir?: string;
  enableContinuity?: boolean;
  /** Exact channels.json registry ids eligible for cross-channel continuity. */
  continuityChannelIds?: readonly string[];
  /** Exact enabled-plugin channel-id prefixes eligible for cross-channel continuity. */
  continuityChannelPrefixes?: readonly string[];
  promptRegistry?: PromptRegistryStatePort | null;
  /** Runtime-owned backup root for automatic corrupt-handoff quarantine evidence. */
  sessionIntegrityRepairBackupRootDir?: string;
  /**
   * Injected session tail cache (tests/harnesses/hosts). Lite cut: the Redis
   * tail is cut, so `undefined` with settings sessionTailCache.enabled refuses
   * to start (the donor built the Redis tail there); explicit `null` disables
   * it regardless of config.
   */
  sessionTailCache?: SessionTailCachePort | null;
  /** Exact runtime identity used by retention write barriers in full agent composition. */
  automataRetentionCompanionId?: string;
}

/**
 * Production composition requires HMAC verification. Tests and narrowly
 * scoped maintenance harnesses may omit it by leaving `runtimeMode` unset.
 * Lite cut: the donor's indivisible operator integrity alert fed the CogSec
 * session-integrity incident observer, which is cut, so the alert is gone.
 */
export type SessionCompositionOptions = SessionCompositionBaseOptions & (
  | {
      runtimeMode: 'production';
      sessionIntegrityProvider: SessionIntegrityProvider;
    }
  | {
      runtimeMode?: 'non-production';
      sessionIntegrityProvider?: SessionIntegrityProvider | null;
    }
);

function assertProductionSessionIntegrityComposition(options: unknown): void {
  if (!isRecord(options) || options.runtimeMode !== 'production') return;
  if (!options.sessionIntegrityProvider) {
    throw new Error('Production session composition requires a non-null integrity provider');
  }
}

/**
 * Lite cut: the Redis-backed session tail (psfn-framework-hgw3.5) is cut. An
 * injected tail is used as given; settings.json enabling the tail without one
 * fails closed at startup, as the donor did when Redis was unavailable.
 */
function composeSessionTailCache(
  config: SubstrateConfig,
  override: SessionTailCachePort | null | undefined,
): SessionTailCachePort | null {
  if (override !== undefined) return override;
  const settings = config.sessionTailCache;
  if (!settings?.enabled) return null;
  throw new Error(
    'settings.json sessionTailCache.enabled requires a host-injected session tail cache (the Redis tail is not part of Lite)',
  );
}

function createSessionComposition(
  options: SessionCompositionOptions,
  sessionAdapters: Awaited<ReturnType<typeof createDefaultPostgresSessionAdapters>>,
  sessionsDir: string,
  sessionTailCache: SessionTailCachePort | null,
  exactSessionWriteBarrier: FilesystemAutomataRetentionWriteBarrier,
): SessionComposition {
  const companionDataDir = resolveConfiguredCompanionDataDir(options.config);
  // Keep the adapter contract required at compile time while still rejecting
  // malformed/custom runtime adapters at the composition boundary.
  const turnRecordEligibilityFence = (sessionAdapters as Partial<typeof sessionAdapters>)
    .turnRecordEligibilityFence;
  if (!turnRecordEligibilityFence) {
    throw new Error('PostgreSQL session composition requires a TurnRecord eligibility fence');
  }
  const conversationalActivityWorkset = (sessionAdapters as Partial<typeof sessionAdapters>)
    .conversationalActivityWorkset;
  if (!conversationalActivityWorkset) {
    throw new Error('PostgreSQL session composition requires a conversational activity workset');
  }
  const sessionStore = new SessionStore(sessionsDir, {
    integrityProvider: options.sessionIntegrityProvider ?? null,
    sessionArchivePort: sessionAdapters.sessionArchivePort,
    transcriptProjection: sessionAdapters.transcriptProjection,
    turnRecordStore: sessionAdapters.turnRecordStore,
    turnRecordEligibilityFence,
    tailCache: sessionTailCache,
    ...(options.sessionIntegrityProvider
      ? {
        backgroundWorkHandoffRecoveryDisposition:
          createBackgroundWorkHandoffRecoveryDisposition({
            sessionsDir,
            backupRootDir: options.sessionIntegrityRepairBackupRootDir
              ?? resolveBackupsDir(companionDataDir),
            integrityProvider: options.sessionIntegrityProvider,
            audit: createSafeguardAuditTrail(companionDataDir),
          }),
      }
      : {}),
    automataRetentionWriteBarrier: exactSessionWriteBarrier,
    ...(options.config.sessionTombstoneAuthorityOwners !== undefined
      ? { turnTombstoneAuthorityOwners: options.config.sessionTombstoneAuthorityOwners }
      : {}),
  });
  // psfn-framework-5jx2v: canonical L0 turn-tombstone verification no longer
  // runs inside the constructor. Warm it through the forked authority worker so
  // startup timers and admin work keep advancing; owners this pass does not
  // reach stay fail-closed and are rebuilt from the journal on first demand.
  void sessionStore.primeTurnTombstoneAuthority()
    .then((report) => {
      log.debug('Primed L0 turn-tombstone authority off the primary event loop', {
        considered: report.considered,
        primed: report.primed,
        alreadyCurrent: report.alreadyCurrent,
        deferred: report.deferred.length,
        bytesReadOffPrimary: report.bytesReadOffPrimary,
      });
    })
    .catch((error: unknown) => {
      log.warn('Deferred L0 turn-tombstone authority priming failed; '
        + 'authority will be rebuilt fail-closed on demand', {
        error: toErrorMessage(error),
      });
    });
  const sessionManager = new SessionManager(
    sessionStore,
    options.config,
    options.eventBus,
    options.promptRegistry ?? null,
    sessionAdapters.transcriptSearch,
  );
  const internalRoleEnvelopeLedger = wireInternalRoleEnvelopeRuntime(sessionManager, options.config);

  let continuityStore: UserContinuityStore | null = null;
  if (options.enableContinuity) {
    if (!options.continuityChannelIds && !options.continuityChannelPrefixes) {
      throw new Error('Enabled cross-channel continuity requires configured channels.json channel ids or channel plugin prefixes');
    }
    const continuityChannelIds = new Set(options.continuityChannelIds ?? []);
    const continuityChannelPrefixes = options.continuityChannelPrefixes ?? [];
    if (continuityChannelPrefixes.some(prefix => prefix.length === 0)) {
      throw new Error('Cross-channel continuity channel prefixes must be non-empty');
    }
    continuityStore = new UserContinuityStore(resolveContinuityDir(companionDataDir));
    sessionManager.crossChannelContinuity = createUserContinuityPort(
      continuityStore,
      (channelId, minId, maxId) => sessionStore.getEntriesInRange(channelId, minId, maxId),
      channelId => continuityChannelIds.has(channelId)
        || continuityChannelPrefixes.some(prefix => channelId.startsWith(prefix)),
    );
  } else {
    sessionManager.crossChannelContinuity = createDisabledCrossChannelContinuityPort();
  }

  return {
    sessionStore,
    sessionManager,
    continuityStore,
    internalRoleEnvelopeLedger,
    sessionTailCache,
    sessionsDir,
    exactSessionProjection: sessionAdapters.exactSessionProjection,
    conversationalActivityWorkset,
    exactSessionWriteBarrier,
  };
}

export async function composeSessionRuntimeAsync(
  options: SessionCompositionOptions,
): Promise<SessionComposition> {
  assertProductionSessionIntegrityComposition(options);
  const companionDataDir = resolveConfiguredCompanionDataDir(options.config);
  migrateLegacyPersistenceLayout(companionDataDir);

  const sessionsDir = options.sessionsDir ?? resolveSessionsDir(companionDataDir);
  if (options.config.persistenceBackend !== 'postgres') {
    throw new Error('PostgreSQL session composition requires config.persistenceBackend=postgres');
  }
  const databaseUrl = options.postgresDatabaseUrl?.trim()
    || options.config.postgresDatabaseUrl?.trim();
  if (!databaseUrl) {
    throw new Error('PostgreSQL session composition requires config.postgresDatabaseUrl');
  }
  const tenantScope = resolveConfigTenantPoolScope(options.config);
  const postgresSchema = tenantScope?.schema ?? options.config.postgresSchema?.trim();
  const postgresRole = tenantScope?.role;
  const automataRetentionCompanionId = options.automataRetentionCompanionId?.trim()
    || options.config.companionId?.trim();
  if (!automataRetentionCompanionId) {
    throw new Error('PostgreSQL session composition requires an Automata retention companionId');
  }
  const exactSessionWriteBarrier = new FilesystemAutomataRetentionWriteBarrier(
    sessionsDir,
    automataRetentionCompanionId,
  );
  const sessionAdapters = await awaitPostgresStoreReadiness(
    'session_transcripts',
    () => createDefaultPostgresSessionAdapters(databaseUrl, {
      sessionsDir,
      automataRetentionWriteBarrier: exactSessionWriteBarrier,
      ...(postgresSchema ? { schema: postgresSchema } : {}),
      ...(postgresRole ? { role: postgresRole } : {}),
    }),
  );
  const sessionTailCache = composeSessionTailCache(options.config, options.sessionTailCache);
  return createSessionComposition(
    options,
    sessionAdapters,
    sessionsDir,
    sessionTailCache,
    exactSessionWriteBarrier,
  );
}

export async function composeMemoryStoreAsync(
  config: SubstrateConfig,
  embeddingDims: number,
): Promise<MemoryStorePort> {
  const companionDataDir = resolveConfiguredCompanionDataDir(config);
  migrateLegacyPersistenceLayout(companionDataDir);

  if (config.persistenceBackend !== 'postgres') {
    throw new Error('PostgreSQL memory composition requires config.persistenceBackend=postgres');
  }
  const databaseUrl = config.postgresDatabaseUrl?.trim();
  if (!databaseUrl) {
    throw new Error('PostgreSQL memory composition requires config.postgresDatabaseUrl');
  }
  const tenantScope = resolveConfigTenantPoolScope(config);
  const postgresSchema = tenantScope?.schema ?? config.postgresSchema?.trim();

  return await awaitPostgresStoreReadiness(
    'memory',
    () => createPostgresMemoryStore(databaseUrl, embeddingDims, {
      notesDir: resolveNotesDir(companionDataDir),
      scratchpadMirrorPath: resolveScratchpadMirrorPath(companionDataDir),
      journal: new MemoryJournal(resolveMemoryJournalPath(companionDataDir)),
      ...(postgresSchema
        ? {
            schema: postgresSchema,
            ...(tenantScope ? { role: tenantScope.role } : {}),
          }
        : {}),
    }),
  );
}

export interface IdentityComposition {
  companionId: RuntimeCompanionId;
  card: CharacterCardV2;
  systemPrompt: string;
}

export function composeIdentity(config: SubstrateConfig): IdentityComposition {
  const card = loadCharacterCard(config.characterCardPath);
  return {
    companionId: resolveCompanionIdFromConfig(config),
    card,
    systemPrompt: composeSystemPrompt(card),
  };
}

export interface SubstrateAgentCompositionOptions {
  eventBus: EventBus;
  llmProvider: LLMProviderPort;
  runtime?: ProviderRuntime;
  sessionManager: SessionManager;
  systemPrompt: string;
  characterName?: string;
  characterPromptVariables?: Record<string, string>;
  characterPromptVariablesProvider?: () => Record<string, string>;
  config: CoreSubstrateConfig;
  runtimeMode?: ToolWiringValidationMode;
  emotionRuntime?: EmotionRuntimeWiring;
  observerEvalSidecar?: ObserverEvalSidecarRuntime | null;
  streamRuntimeOptions?: SubstrateAgentOptions['streamRuntimeOptions'];
  streamTransport?: SubstrateAgentOptions['streamTransport'];
  appCache?: AppCache;
  /** Contact-tracking policy gate (E3.4). Absent gate behaves as 'auto' everywhere. */
  contactTrackingGate?: ContactTrackingGate | null;
  /** Places soft-registry (S10). Absent behaves as an empty registry. */
  placesRegistryConfig?: PlacesRegistryConfig;
  backgroundWorkStore?: SubstrateAgentOptions['backgroundWorkStore'];
  backgroundWorkTuning?: SubstrateAgentOptions['backgroundWorkTuning'];
  backgroundWorkDisabled?: boolean;
  backgroundWorkWelfare?: SubstrateAgentOptions['backgroundWorkWelfare'];
  backgroundWorkAutomataLifecycle?: SubstrateAgentOptions['backgroundWorkAutomataLifecycle'];
  intentionHooksAutomataRunner?: SubstrateAgentOptions['intentionHooksAutomataRunner'];
  classifySessionAtCreation?: SubstrateAgentOptions['classifySessionAtCreation'];
}

export function composeSubstrateAgent(options: SubstrateAgentCompositionOptions): SubstrateAgent {
  return new SubstrateAgent(
    options.eventBus,
    options.llmProvider,
    options.sessionManager,
    options.systemPrompt,
    options.config,
    {
      ...(options.characterName ? { characterName: options.characterName } : {}),
      ...(options.characterPromptVariables ? { characterPromptVariables: options.characterPromptVariables } : {}),
      ...(options.characterPromptVariablesProvider
        ? { characterPromptVariablesProvider: options.characterPromptVariablesProvider }
        : {}),
      ...(options.runtimeMode ? { runtimeMode: options.runtimeMode } : {}),
      ...(options.emotionRuntime ? { emotionRuntime: options.emotionRuntime } : {}),
      ...(options.runtime ? { runtime: options.runtime } : {}),
      ...(options.observerEvalSidecar ? { observerEvalSidecar: options.observerEvalSidecar } : {}),
      ...(options.streamRuntimeOptions ? { streamRuntimeOptions: options.streamRuntimeOptions } : {}),
      ...(options.streamTransport ? { streamTransport: options.streamTransport } : {}),
      ...(options.appCache ? { appCache: options.appCache } : {}),
      ...(options.contactTrackingGate ? { contactTrackingGate: options.contactTrackingGate } : {}),
      ...(options.placesRegistryConfig ? { placesRegistryConfig: options.placesRegistryConfig } : {}),
      ...(options.backgroundWorkStore ? { backgroundWorkStore: options.backgroundWorkStore } : {}),
      ...(options.backgroundWorkTuning
        ? { backgroundWorkTuning: options.backgroundWorkTuning }
        : {}),
      ...(options.backgroundWorkDisabled ? { backgroundWorkDisabled: true } : {}),
      ...(options.backgroundWorkWelfare ? { backgroundWorkWelfare: options.backgroundWorkWelfare } : {}),
      ...(options.backgroundWorkAutomataLifecycle
        ? { backgroundWorkAutomataLifecycle: options.backgroundWorkAutomataLifecycle }
        : {}),
      ...(options.intentionHooksAutomataRunner
        ? { intentionHooksAutomataRunner: options.intentionHooksAutomataRunner }
        : {}),
      ...(options.classifySessionAtCreation
        ? { classifySessionAtCreation: options.classifySessionAtCreation }
        : {}),
    },
  );
}

export interface SelfModelRuntimeTarget {
  setSelfModelRuntimeRequired(required: boolean): void;
}

export function wireSelfModelRuntime(target: SelfModelRuntimeTarget): void {
  target.setSelfModelRuntimeRequired(true);
}

export function wireDiagnosticsRuntime(eventBus: EventBus): void {
  wireRuntimeDiagnosticsEventCapture(eventBus);
}

export interface CoreMemoryRuntimeOptions {
  agentLoop: SubstrateAgent;
  sessionManager: SessionManager;
  config: SubstrateConfig;
  concernStore?: ConcernStorePort | null;
  introspectionConsentStore?: IntrospectionConsentStore | null;
  introspectionTurnSensitivityDecisions?: IntrospectionTurnSensitivityDecisions | null;
  /** Event bus for the concern resolution-as-appraisal relief-delta event (vw3w.1). */
  eventBus?: EventBus | null;
}

export function wireCoreMemoryRuntime(options: CoreMemoryRuntimeOptions): CoreMemoryStorePort {
  const companionDataDir = resolveConfiguredCompanionDataDir(options.config);
  const store = createCoreMemoryStorePort(
    new CoreMemoryStore(resolveCoreMemoryPath(companionDataDir)),
  );
  const valuesJournal = new ValuesJournalStore(resolveValuesJournalPath(companionDataDir), {
    legacyFilePaths: [resolveLegacyValuesJournalPath(companionDataDir)],
  });
  options.sessionManager.setCoreMemoryProvider(store);
  options.agentLoop.registerTool(createOrientTool(store, {
    valuesJournal,
    concernStore: options.concernStore ?? null,
    introspectionConsentStore: options.introspectionConsentStore ?? null,
    introspectionTurnSensitivityDecisions: options.introspectionTurnSensitivityDecisions ?? null,
    eventBus: options.eventBus ?? null,
    // Resolution-as-appraisal (vw3w.1): snapshot the agent's live VAD when the
    // companion decides to resolve/terminally-transition a concern.
    resolutionVadProvider: concern => resolveCurrentInternalStateConcernVAD(
      concern,
      options.agentLoop.getCurrentInternalState(),
      new Date().toISOString(),
    ),
  }));
  return store;
}

export interface MemoryRuntimeOptions {
  agentLoop: SubstrateAgent;
  llmProvider: LLMProviderPort;
  /** Typed decision runtime for opt-in retrieval sites (epic 4lf3r). */
  decisionRuntime?: RetrievalDecisionPort;
  sessionManager: SessionManager;
  sessionStore?: SessionStore | null;
  memoryStore: MemoryStorePort;
  embeddingService: EmbeddingProviderPort;
  eventBus: EventBus;
  config?: SubstrateConfig;
  promptRegistry?: PromptRegistryStatePort | null;
  contactStore?: ContactStorePort | null;
  episodicStore?: EpisodicRetrievalStore | null;
  concernCandidateSink?: ConcernCandidateExtractionSink | null;
  /** Contact-tracking policy gate predicate (E3.4); absent behaves as 'auto'. */
  isAutoContactCreationAllowed?: ((channelId: string) => boolean) | null;
  /** Shared persona preamble service (E6.1); soft persona framing before extraction/profile prompts. */
  personaPreamble?: PersonaPreamblePort | null;
  biographicalProjection?: Pick<MemoryProvider, 'projectBiographicalContext'> | null;
  biographicalRebuild?: MemoryExtractorFormationOptions['biographicalRebuild'];
  /** Eligible extraction-only Bus access; foreground MemoryRetriever never receives it. */
  automataBusWorkerAccess?: AutomataBusWorkerAccess | null;
  /** Authoritative lifecycle for extraction workers admitted to the Bus. */
  automataRunRegistry?: AutomataRunRegistry | null;
  /** Durable terminal handoff adapter shared with the bounded subagent class. */
  automataTerminalLifecycle?: AutomataTerminalLifecyclePort | null;
}

export function wireMemoryRuntime(options: MemoryRuntimeOptions): MemoryExtractor {
  const costTelemetry = createEventBusCostTelemetryPort(options.eventBus);
  const roomMembershipAuthority = options.sessionStore
    ? createCompanionRoomMembershipAuthority(options.sessionStore)
    : null;
  const memoryRetriever = options.config
    ? new MemoryRetriever(
      options.memoryStore,
      options.embeddingService,
      options.config,
	      costTelemetry,
	      options.contactStore ?? null,
	      options.llmProvider,
	      options.episodicStore ?? null,
	      options.sessionManager,
	      true,
	      options.biographicalProjection ?? null,
	      roomMembershipAuthority,
	    )
	    : new MemoryRetriever(
	      options.memoryStore,
	      options.embeddingService,
      undefined,
	      costTelemetry,
	      options.contactStore ?? null,
	      options.llmProvider,
	      options.episodicStore ?? null,
	      options.sessionManager,
	      true,
	      options.biographicalProjection ?? null,
	      roomMembershipAuthority,
	    );
  if (options.decisionRuntime) memoryRetriever.setDecisionRuntime(options.decisionRuntime);
  options.agentLoop.memoryProvider = memoryRetriever;

  const extractorFormationOptions = {
    ...(options.decisionRuntime ? { decisions: options.decisionRuntime } : {}),
    ...(options.concernCandidateSink
      ? { emitConcernCandidates: options.concernCandidateSink }
      : {}),
    ...(options.isAutoContactCreationAllowed
      ? { isAutoContactCreationAllowed: options.isAutoContactCreationAllowed }
      : {}),
    ...(options.personaPreamble
      ? { personaPreamble: options.personaPreamble }
      : {}),
    ...(options.biographicalRebuild
      ? { biographicalRebuild: options.biographicalRebuild }
      : {}),
    ...(options.automataBusWorkerAccess
      ? { automataBusWorkerAccess: options.automataBusWorkerAccess }
      : {}),
    ...(options.automataRunRegistry
      ? { automataRunRegistry: options.automataRunRegistry }
      : {}),
    ...(options.automataTerminalLifecycle
      ? { automataTerminalLifecycle: options.automataTerminalLifecycle }
      : {}),
  };
  const memoryExtractor = options.config
    ? new MemoryExtractor(
      options.llmProvider,
      options.sessionManager,
      options.memoryStore,
      options.embeddingService,
      costTelemetry,
      options.config,
      options.promptRegistry ?? null,
      options.sessionStore ?? null,
      options.contactStore ?? null,
      extractorFormationOptions,
    )
    : new MemoryExtractor(
      options.llmProvider,
      options.sessionManager,
      options.memoryStore,
      options.embeddingService,
      costTelemetry,
      undefined,
      options.promptRegistry ?? null,
      options.sessionStore ?? null,
      options.contactStore ?? null,
      extractorFormationOptions,
    );
  options.sessionManager.setPreCompactionExtractionHandler(async ({
    channelId,
    entries,
    canonicalContactId,
  }) => {
    await memoryExtractor.queueCompactionExtraction(
      channelId,
      entries,
      canonicalContactId,
    );
  });
  options.agentLoop.memoryExtractor = memoryExtractor;
  return memoryExtractor;
}


export interface SubagentRuntimeOptions {
  agentLoop: SubstrateAgent;
  eventBus: EventBus;
  llmProvider: LLMProviderPort;
  sessionStore: SessionStore;
  embeddingService: EmbeddingProviderPort;
  memoryStore: MemoryStorePort;
  sessionManager: SessionManager;
  config: SubstrateConfig;
  parentSystemPrompt: string;
  companionDataDir?: string;
  runtimeMode?: ToolWiringValidationMode;
  /** Donor main.ts passes the safeguard audit trail as shardAuditTrail. */
  auditTrail?: SubagentAuditTrail | null;
  snapshotParentCapabilityGrant: () => CapabilityGrantSnapshot;
  automataRunRegistry?: AutomataRunRegistry;
  automataSessionClassification?: Pick<AutomataSessionClassificationService, 'classifyAtCreation'>;
  automataBusWorkerAccess?: AutomataBusWorkerAccess | null;
  automataLifecyclePort?: AutomataTerminalLifecyclePort | null;
  /** Lite (operator automata rule 4): see SubagentFacultyDeps.hostExecution. */
  hostExecution?: SubagentHostExecutionPort | null;
}

/**
 * Lite cut of the donor wireShardAndThinkRuntime (seam 3.11): the shard
 * manager, its execution port and Postgres schema lifecycle, and the analysis
 * workbench tool are cut. The fold-review queue, the subagent faculty and the
 * subagent tool are composed exactly as the donor composed them.
 */
export interface SubagentRuntime {
  subagentFaculty: SubagentFaculty;
  /** The fold-review queue (donor: reached through ShardManager.listFoldReviews / getFoldReview). */
  foldReviewController: ShardFoldReviewController;
}

export function wireSubagentRuntime(options: SubagentRuntimeOptions): SubagentRuntime {
  const companionDataDir = options.companionDataDir ?? resolveConfiguredCompanionDataDir(options.config);
  // htm9.3: shard fold-back memory writes gate at the memory_write sink; the
  // gate is late-bound onto the session manager by composition.
  const foldReviewMemoryWriter = new MemoryWriter(options.memoryStore, options.embeddingService, {
    memoryRetrievalPolicy: () => options.config.memoryRetrievalPolicy,
    ...(options.config.companionId ? { companionId: options.config.companionId } : {}),
    roomMembershipAuthority: createCompanionRoomMembershipAuthority(options.sessionStore),
  });
  foldReviewMemoryWriter.intakeSinkGateProvider = () => options.sessionManager.intakeSinkGate;
  const foldReviewController = new ShardFoldReviewController(
    resolveShardFoldReviewStorePath(companionDataDir),
    foldReviewMemoryWriter,
    () => ({
      screening: options.sessionManager.intakeScreening,
      sinkGate: options.sessionManager.intakeSinkGate,
    }),
  );
  const subagentFaculty = new SubagentFaculty({
    eventBus: options.eventBus,
    llmProvider: options.llmProvider,
    sessionStore: options.sessionStore,
    completionNoticeDelivery: {
      deliver: input => options.agentLoop.deliverCompletionNotice(input),
    },
    embeddingService: options.embeddingService,
    memoryProvider: options.agentLoop.memoryProvider,
    config: options.config,
    parentSystemPrompt: options.parentSystemPrompt,
    toolCatalogProvider: () => options.agentLoop.getToolCatalog(),
    auditTrail: options.auditTrail ?? undefined,
    runtimeMode: options.runtimeMode,
    snapshotParentCapabilityGrant: options.snapshotParentCapabilityGrant,
    // c7d: restricted-class subagent memory candidates stage through the same
    // fold-review queue the shard runtime uses (no parallel review system).
    foldReviewController,
    // hrmrq.54: subagent tool results screen like the parent's. Lazy — the
    // agent entrypoint assigns intakeScreening onto the parent SessionManager
    // after this composition runs.
    intakeScreeningProvider: () => options.sessionManager.intakeScreening,
    completionIntakeProvider: () => ({
      screening: options.sessionManager.intakeScreening,
      sinkGate: options.sessionManager.intakeSinkGate,
    }),
    activeTurnIntakeEnvelopesProvider: () => options.agentLoop.getActiveTurnIntakeEnvelopes(),
    automataRunRegistry: options.automataRunRegistry,
    automataSessionClassification: options.automataSessionClassification,
    automataBusWorkerAccess: options.automataBusWorkerAccess,
    automataLifecyclePort: options.automataLifecyclePort,
    hostExecution: options.hostExecution ?? null,
  });
  options.agentLoop.registerTool(createSubagentTool(subagentFaculty), 'core');
  return { subagentFaculty, foldReviewController };
}
