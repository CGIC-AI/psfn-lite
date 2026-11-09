// ── Lite companion composition root (plan seam 3.11) ──
//
// Replays the donor agent registration sequence at e6a9546 in one process:
// src/app/agent/main.ts (main), core-bootstrap.ts (bootstrapAgentCoreRuntime)
// and core-runtime.ts (buildAgentCoreRuntime), with the scheduler lanes of
// scheduler-runtime.ts (promoted, cut in place). Steps keep the donor order;
// each block cites the donor lines it replays. Everything the donor reached
// through the gateway process is a host port here (docs/extraction.md, B6):
// the LLM provider runtime and embedding provider (seam 3.1), the optional
// operator notifier, outbound sender and heartbeat channel, the optional text
// emotion classifier, the session integrity provider and the availability
// projection.
//
// Removed with their subsystems (extraction/cuts.tsv, seam 3.11): the gateway
// connection, disconnect recovery and RPC callbacks; fleet tenancy, presence
// and maintenance; the health event stream, incident alerts and human
// escalation; CogSec intake screening, sink gates, quarantine, receipts,
// custody and the blind-review / drift / second-arrow lanes; the speaking
// arbiter, room participation and observed-group passive appraisal lanes; the
// partner-affect shadow bridge; the module loader, shard / think, analysis
// workbench, git / shell / beads / vault / world / web / filesystem / image /
// MCP / skills / wiki / self-status / publication tools; the model-usage
// ledger; the API and Garden admin surfaces; backups and health detectors;
// world exploration. The memory-deletion RPC, the external-memory service and
// the gateway message handlers are cut with the gateway: the host calls
// `agentLoop.handleMessage` directly.

import { randomUUID } from 'node:crypto';

import {
  sanitizeCoreSubstrateConfig,
  type SubstrateConfig,
} from '../../system/config/runtime-config-contracts.js';
import type { InnerLifeConfig } from '../../system/config/inner-life-config.js';
import { setRuntimeTrustPolicy } from '../../system/trust/runtime-policy.js';
import { DEFAULT_BACKGROUND_WORK_WELFARE_CONFIG } from '../../system/config/scheduler-config.js';
import { EventBus } from '../../shared/event-bus.js';
import { createComponentLogger } from '../../shared/logger.js';
import { createMemoryAppCache } from '../../shared/cache/memory-cache.js';
import { emitGardenQueueChanged } from '../../shared/garden-queue-change.js';
import { resolveHealthEventOwner } from '../../shared/contracts/health-event.js';
import type {
  NotificationPort,
  NotifyNtfyParams,
  NotifyNtfyResult,
} from '../../shared/contracts/notification-port.js';
import { EMPTY_PERSONAL_PROJECTS } from '../../shared/contracts/personal-projects-port.js';
import type { ChannelType } from '../../shared/contracts/channel-types.js';
import type { MessageSender } from '../../system/lifecycle/notifications.js';
import { OutboundReplyDeduper } from '../../system/lifecycle/outbound-reply-dedupe.js';
import type { CapabilityAccess, CapabilityGrantSnapshot } from '../../system/capabilities/access.js';
import { createEligibilityGate } from '../../system/capabilities/eligibility.js';
import { normalizeCapabilityTier, resolveTierCapabilityTokens } from '../../system/capabilities/tiers.js';
import type { CapabilityToken } from '../../system/capabilities/tokens.js';
import { ConfirmationQueue } from '../../system/capabilities/confirmation-queue.js';
import { createApprovalQueuePortFromConfirmationQueue } from '../../system/capabilities/approval-queue-port.js';
import { trustOrd } from '../../system/trust/types.js';
import { resolveMemoryRetrievalPolicy } from '../../system/config/memory-retrieval-policy.js';
import { createDefaultBiographicalDepthPolicy } from '../../system/config/biographical-depth-policy.js';
import { createDefaultBiographicalCandidatePolicy } from '../../system/config/biographical-candidate-policy.js';
import { createProviderRuntimeServices } from '../../system/config/provider-runtime-factory.js';
import type { LLMClientRuntimeOptions } from '../../primitives/llm/client.js';
import type { ProviderRuntime } from '../../primitives/llm/provider-runtime.js';
import { getRequestContext } from '../../primitives/llm/request-context.js';
import {
  resolveCharacterCardHistoryPath,
  resolveConcernResolutionArcJournalPath,
  resolveContactBlockListPath,
  resolveContactsDir,
  resolveIntrospectionConsentLedgerPath,
  resolveOutreachOutboxLedgerPath,
  resolvePendingContactApprovalsPath,
  resolveRuntimePathSnapshotFromConfig,
  resolveSocialGraphBuilderWatermarkPath,
  resolveSocialGraphProposalsPath,
  type RuntimePathSnapshot,
} from '../../persistence/layout.js';
import {
  createAgentPersistenceRuntime,
  type AgentPersistenceRuntime,
} from '../../persistence/runtime-factory.js';
import { createPostgresPool } from '../../persistence/postgres.js';
import { PostgresPoolOwner, runWithPostgresPoolOwner } from '../../persistence/postgres/pool-owner.js';
import { awaitPostgresStoreReadiness, sealPostgresStoreReadinessBeforeReady } from '../../persistence/postgres/runtime-readiness.js';
import { resolveConfigTenantPoolScope } from '../../persistence/postgres/tenant-pool-scope.js';
import { assertBackgroundWorkFitsTurnRecordFenceLane } from '../../persistence/postgres/turn-record-eligibility-fence.js';
import { ReflectionJournalStore } from '../../persistence/journals/reflection-journal.js';
import type { SessionIntegrityProvider } from '../../persistence/sessions/store.js';
import { createLLMProviderPort, type LLMProviderPort } from '../../core/agent/contracts.js';
import type { SubstrateAgent } from '../../core/agent/substrate-agent.js';
import type { SubstrateStreamTransport } from '../../core/agent/stream-adapter.js';
import { CompanionAvailabilityRuntime, attachToolAvailability } from '../../core/agent/companion-availability.js';
import { createMemoryStorePort } from '../../faculties/memory/memory-store-port.js';
import type { MemoryDeletionApprovalPort } from '../../faculties/memory/deletion-proposals.js';
import { EmotionObserver, type TextEmotionClassifierLike } from '../../core/emotion/observer.js';
import { EmotionState } from '../../core/emotion/state.js';
import type { EmoSimProactivityImpulse } from '../../core/emotion/emosim-proactivity-port.js';
import { CharacterCardVersionStore } from '../../core/identity/card-versioning.js';
import { composeSystemPromptTemplate } from '../../core/identity/loader.js';
import { createPersonaPreambleService } from '../../core/identity/persona-preamble.js';
import { createPromptStatePort } from '../../core/identity/prompt-state-port.js';
import { resolveCompanionIdFromConfig, resolveCoreCompanionIdFromConfig } from '../../core/identity/companion-runtime.js';
import { registerContactRuntime } from '../../core/contacts/runtime-wiring.js';
import { createContactTrackingGate, type ContactTrackingChannelLabels } from '../../core/contacts/tracking-gate.js';
import { createFilePendingContactApprovalStore } from '../../core/contacts/pending-contact-approvals.js';
import { ContactBlockListStore } from '../../core/cogsec/contact-block-list.js';
import {
  createIntentionAppraisalHooks,
  createIntentionBehavioralPatternHooks,
  wireIntentionRuntimeStores,
  type LongHorizonFollowUpInput,
} from '../../core/intention/runtime-wiring.js';
import { createAutomatedConcernRuntime } from '../../core/intention/concern-candidates.js';
import { createConcernResolutionArcRecorder } from '../../core/intention/concern-resolution-arc.js';
import { resolveCurrentInternalStateConcernVAD } from '../../core/intention/concern-grooming.js';
import {
  applyConcernCandidateDecision,
  listPendingConcernCandidates as listPendingConcernCandidatesFrom,
} from '../../core/intention/concern-candidate-prompt.js';
import { createLongHorizonFollowUpRouter } from '../../core/intention/long-horizon-follow-up.js';
import {
  ProactiveOutboundDispatcher,
  createApprovedPrimaryChannelPolicy,
} from '../../core/intention/proactive-outbound.js';
import { openFileOutreachOutboxStore } from '../../core/intention/outreach-outbox.js';
import { createSocialOutreachDraftRegistry } from '../../core/intention/social-outreach-turn/drafts.js';
import { createBehavioralPatternMemoryPromotionHook } from '../../core/intention/patterns.js';
import { rehydratePersistedInternalState } from '../../core/self-model/internal-state-persistence.js';
import { registerEmoSimProactivitySampling } from '../../core/scheduler/emosim-proactivity-lane.js';
import { createObserverEvalSidecarRuntimeFromConfig } from '../../core/eval/observer-sidecar/config.js';
import { LetterService } from '../../core/letters/service.js';
import { wireLetterMemoryExtraction } from '../../core/letters/memory-extraction.js';
import { createLetterTool } from '../../core/tools/letter.js';
import { DoingMirrorService } from '../../core/doing-mirror/service.js';
import { FoldPackageDoingMirrorSource } from '../../core/doing-mirror/sources.js';
import { MemoryWriter } from '../../faculties/memory/writer.js';
import { createCompanionRoomMembershipAuthority } from '../../faculties/memory/companion-provenance.js';
import {
  EPISODE_SEARCH_DOCUMENT_SCHEMA,
  wireEpisodeSemanticIndexRuntime,
} from '../../faculties/memory/episodic/index.js';
import { EpisodicSynthesizer } from '../../faculties/memory/episodic/synthesis.js';
import { SleepCycleEpisodeConsolidator } from '../../faculties/memory/episodic/sleep-consolidation.js';
import { EpisodeArcWeaver } from '../../faculties/memory/episodic/arc-formation.js';
import { DreamMeaningPass } from '../../faculties/memory/episodic/dream-meaning-pass.js';
import { createDisabledSleeptimeWikiPass } from '../../faculties/memory/sleeptime-wiki-stage.js';
import { createHybridEpisodeSearch } from '../../faculties/memory/retrieval/episode-search.js';
import { registerMemoryTools } from '../../faculties/memory/runtime-wiring.js';
import {
  createSubjectAuthorizedMemoryStore,
  memorySubjectAccessContextFromCorrelation,
} from '../../faculties/memory/subject-authorized-store.js';
import {
  createFileSocialGraphBuilderWatermarkStore,
  createFileSocialGraphProposalStore,
} from '../../faculties/memory/social-graph/proposals.js';
import { ObservedGroupMemoryScheduler } from '../../faculties/memory/extraction/group-observed-scheduler.js';
import { JsonGroupMemoryWatermarkStore } from '../../faculties/memory/extraction/group-ranges.js';
import { createPostgresBiographicalProfileStore } from '../../faculties/memory/biographical/postgres-store.js';
import { MemoryBackedBiographicalSourceRevalidator } from '../../faculties/memory/biographical/memory-source.js';
import { BiographySynthesisService } from '../../faculties/memory/biographical/synthesis-service.js';
import { BiographyCompanionReviewService } from '../../faculties/memory/biographical/companion-review-service.js';
import { createBiographySynthesisTargetPort } from '../../faculties/memory/biographical/synthesis-targets.js';
import type { BiographicalSubjectRef } from '../../faculties/memory/biographical/types.js';
import { createRuntimeBiographicalProjection } from '../../faculties/memory/biographical/runtime-projection.js';
import { resolveEmbeddingProviderProvenanceFromConfig, type EmbeddingRuntimeProvider } from '../../faculties/memory/embedding.js';
import { IntrospectionConsentStore } from '../../faculties/introspection/consent-store.js';
import { IntrospectionTurnSensitivityDecisions } from '../../faculties/introspection/turn-sensitivity.js';
import { createAutomataBusProductionRuntime } from '../../faculties/automata/bus/production-runtime.js';
import {
  CanonicalAutomataBusWriter,
  automataBusWorkerBoundsFromOwnerPolicy,
  createAutomataTerminalLifecycleAdapter,
  createProductionAutomataBusWorkerAccess,
} from '../../faculties/automata/bus/production-worker-adapter.js';
import {
  createAutomataBusReviewerFindingAdapter,
  createAutomataBusReviewerModelAdapter,
  createAutomataBusReviewerMutationAdapter,
  createAutomataBusReviewerOutcomeAdapter,
  PostgresAutomataBusReviewerNominationAdapter,
} from '../../faculties/automata/bus/production-reviewer-adapters.js';
import { createAutomataBusReviewerTask } from '../../faculties/automata/bus/reviewer-service.js';
import type { AutomataClassLifecycleRuntime } from '../../faculties/automata/bus/class-lifecycle.js';
import { resolveForegroundSessionOwner } from '../../faculties/automata/session-classification.js';
import { createProductionAutomataRetentionRuntime } from '../../faculties/automata/production-retention-runtime.js';
import { staggerQuietHoursRelease } from '../../core/scheduler/quiet-hours-release-stagger.js';
import type { Scheduler } from '../../core/scheduler/scheduler.js';
import { buildAgentDecisionRuntime } from './decision/decision-runtime.js';
import {
  createBackgroundWorkAutomataLifecycle,
  createIntentionPostTurnHooksAutomataRunner,
} from './automata-background-work-lifecycle.js';
import { createDefaultConcernRouteDispatcher } from './concern-route-wiring.js';
import { reconcileConcernResolutionArcsAtStartup } from './concern-resolution-arc-startup.js';
import { hydrateStartupContinuity } from './startup-continuity.js';
import { writeStartupSessionMetadata } from './session-activity.js';
import { buildAgentSchedulerRuntime } from './scheduler-runtime.js';
import { wireIcpInitiationSources } from './icp-initiation-source-wiring.js';
import { createIntentionFollowUpDestinationResolver } from './intention-follow-up-destination.js';
import { registerMarkdownJournalTools, createOptionalJournalAutoPublisher } from './journal-runtime.js';
import { registerTemporalWakeupLane } from './startup/temporal-wakeup-lane.js';
import { registerFreeTimeLane } from './startup/free-time-lane.js';
import { registerWeightedThoughtOutreachLane } from './startup/weighted-thought-outreach-lane.js';
import { registerSocialDesireLane } from './startup/social-desire-lane.js';
import { registerSocialImpulseOutreachLane } from './startup/social-impulse-outreach-lane.js';
import { registerIntrospectionLane } from './startup/introspection-lane.js';
import type { SocialImpulseOutreachRuntime } from '../../core/emotion/social-impulse-outreach.js';
import {
  composeIdentity,
  composeSessionRuntimeAsync,
  composeSubstrateAgent,
  wireCoreMemoryRuntime,
  wireDiagnosticsRuntime,
  wireMemoryRuntime,
  wireSelfModelRuntime,
  wireSubagentRuntime,
} from '../startup/composition/composition.js';
import {
  buildCharacterPromptVariablesProvider,
  wireCharacterCardRuntime,
  wirePromptRuntime,
  wireReflectionRuntime,
  wireSessionToolsRuntime,
  wireSettingsRuntime,
  wireStaticPromptRegistry,
} from '../startup/composition/parity.js';
import {
  createActiveMemoryRefreshFailureAlertHandler,
  createBackupFailureAlertHandler,
  createPromptGenerationFailureAlertHandler,
  createQuarantineExpiryAlertHandler,
  createScheduledTaskFailureAlertHandler,
  createSleepConsolidationFailureAlertHandler,
} from '../startup/support/operator-alerts.js';
import { createRuntimeSafeguardSurfaces } from '../startup/support/safeguard-surfaces.js';
import {
  createRetryableShutdown,
  runShutdownSequence,
  runShutdownStep,
} from '../startup/support/shutdown-helpers.js';
import {
  createStartupTextEmotionClassifier,
  warmRuntimeMlServices,
  type StartupTextEmotionClassifier,
} from '../startup/support/ml-warmup.js';

const log = createComponentLogger('CompanionRuntime');

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/** What the host supplies. Everything else is composed from config, as the donor did. */
export interface StartCompanionRuntimeOptions {
  /**
   * Host-built substrate config (donor: loadAgentConfig, env and settings.json
   * scalars). The root applies the inner-life owner files over it.
   */
  config: SubstrateConfig;
  /** The inner-life owner files (loadInnerLifeConfig, seam 3.10). */
  innerLife: InnerLifeConfig;
  /** Defaults to the layout resolved from config.dataDir / companionDataDir. */
  pathSnapshot?: RuntimePathSnapshot;
  /**
   * Provider runtime for the in-process LLMClient (seam 3.1), for example
   * packages/pi companionProviderRuntimeOf. Default: the donor PiProviderRuntime.
   */
  providerRuntime?: ProviderRuntime;
  llmOptions?: Omit<LLMClientRuntimeOptions, 'runtime'>;
  /** Embedding provider (seam 3.1), for example packages/pi companionEmbeddingProviderOf. */
  embeddingProvider?: EmbeddingRuntimeProvider;
  /**
   * Text emotion classifier. Default: the donor TextEmotionClassifier built
   * from config.textEmotionModel / textEmotionDtype (downloads the model).
   */
  textEmotionClassifier?: StartupTextEmotionClassifier;
  /** Operator notification sink (donor: gateway notify.ntfy). Default: log only. */
  operatorNotifier?: NotificationPort;
  /** Outbound message sender for proactive lanes (donor: gateway.discordSend). */
  outboundSender?: MessageSender;
  /** The primary outward channel (donor: the Discord heartbeat channel). */
  heartbeatChannel?: { channelId: string; channelType: ChannelType };
  /** Channel availability projection (donor: gateway.discordSetAvailability). */
  projectAvailability?: (state: 'available' | 'idle' | 'do_not_disturb') => Promise<'applied' | 'unsupported'>;
  /**
   * Operator confirmation for companion memory-deletion proposals (donor: the
   * gateway). Without it the memory tool reports deletion as not configured.
   */
  memoryDeletionApprovalPort?: MemoryDeletionApprovalPort;
  /** Journal HMAC provider (donor: the gateway session integrity provider). */
  sessionIntegrityProvider?: SessionIntegrityProvider | null;
  /** channels.json context-envelope ids eligible for merged continuity. */
  continuityChannelIds?: readonly string[];
  continuityChannelPrefixes?: readonly string[];
  /** channels.json contextEnvelope.channels (contact-tracking labels). */
  channelLabels?: ContactTrackingChannelLabels;
  primaryUserId?: string;
  eventBus?: EventBus;
  env?: NodeJS.ProcessEnv;
  /**
   * The foreground turn's stream transport (donor core-runtime.ts:724-726
   * passed gateway.stream as SubstrateAgentOptions.streamTransport). It
   * receives the default in-process transport (the LLM provider port's
   * stream, the SubstrateAgent default) and returns the one the agent uses, so a host can answer the model calls of its own
   * host-driven turns and delegate every other call. Default: that port's stream.
   */
  wrapStreamTransport?: (base: SubstrateStreamTransport) => SubstrateStreamTransport;
}

export interface CompanionRuntime {
  readonly agentLoop: SubstrateAgent;
  readonly eventBus: EventBus;
  readonly scheduler: Scheduler;
  readonly llmProvider: LLMProviderPort;
  readonly persistence: AgentPersistenceRuntime;
  readonly sessionManager: SubstrateAgentSessionManager;
  /** Stops the scheduler, the availability runtime and the database pools. */
  stop(): Promise<void>;
}

type SubstrateAgentSessionManager = Awaited<ReturnType<typeof composeSessionRuntimeAsync>>['sessionManager'];

/** Donor operator alerting "unconfigured" (main.ts:375-381): a missing sink is logged, never silent. */
function createLoggingOperatorNotifier(): NotificationPort {
  return {
    notify: async (params: NotifyNtfyParams): Promise<NotifyNtfyResult> => {
      log.warn('Operator notification has no host sink; logged only', {
        title: params.title ?? '',
        provenance: params.sender.provenance,
      });
      return { status: 'debounced', topic: 'unconfigured' };
    },
  };
}

/**
 * The fixed capability access a Lite host runs with (seam 3.17): the tier from
 * config.capabilityTier (default nursery) and its default tokens, the same
 * access SubstrateAgent derives when no access is injected.
 */
function createFixedCapabilityAccess(config: SubstrateConfig): CapabilityAccess & {
  snapshotOwnerGrant(): CapabilityGrantSnapshot;
} {
  const tier = normalizeCapabilityTier(config.capabilityTier);
  const granted = new Set<CapabilityToken>(resolveTierCapabilityTokens(tier));
  return {
    getTier: () => tier,
    getGrantedTokens: () => granted,
    has: token => granted.has(token),
    snapshotOwnerGrant: () => Object.freeze({
      tier,
      customTokens: Object.freeze([]),
      grantedTokens: Object.freeze([...granted]),
    }),
  };
}

export async function startCompanionRuntime(
  options: StartCompanionRuntimeOptions,
): Promise<CompanionRuntime> {
  // donor main.ts:2539-2543: the whole agent runs under one PostgreSQL pool
  // owner, closed as the last shutdown step.
  const postgresPoolOwner = new PostgresPoolOwner('agent');
  try {
    return await runWithPostgresPoolOwner(
      postgresPoolOwner,
      () => composeCompanionRuntime(options, postgresPoolOwner),
    );
  } catch (error) {
    await postgresPoolOwner.close().catch(() => undefined);
    throw error;
  }
}

/**
 * donor bootstrap-helpers.ts:244 (the inner-life policy keys of settings.json),
 * :271-272 (trust policy) and :423-425 (subagent roles, Automata policy).
 */
function applyInnerLifeConfig(config: SubstrateConfig, innerLife: InnerLifeConfig): void {
  Object.assign(config, innerLife.settings);
  setRuntimeTrustPolicy(innerLife.trustPolicy);
  config.subagentRoles = innerLife.subagentRoles;
  config.automataPolicy = innerLife.automataPolicy;
}

async function composeCompanionRuntime(
  options: StartCompanionRuntimeOptions,
  postgresPoolOwner: PostgresPoolOwner,
): Promise<CompanionRuntime> {
  const { config, innerLife } = options;
  const schedulerConfig = innerLife.scheduler;
  applyInnerLifeConfig(config, innerLife);
  const env = options.env ?? process.env;
  const pathSnapshot = options.pathSnapshot ?? resolveRuntimePathSnapshotFromConfig(config);
  // donor startup-context.ts:162-174 (EventBus, capability runtime, eligibility gate)
  const eventBus = options.eventBus ?? new EventBus();
  const capabilityAccess = createFixedCapabilityAccess(config);
  config.capabilityTier = capabilityAccess.getTier();
  const eligibilityGate = createEligibilityGate(() => capabilityAccess);

  // donor main.ts:315-316, 401 (embedding dims, primary user, LLM provider port)
  const providerServices = createProviderRuntimeServices({
    config,
    providerEnv: env,
    llmOptions: {
      ...(options.llmOptions ?? {}),
      ...(options.providerRuntime ? { runtime: options.providerRuntime } : {}),
    },
    ...(options.embeddingProvider ? { embeddingProvider: options.embeddingProvider } : {}),
  });
  const { llmClient, embeddingProvider } = providerServices;
  const llmProvider = createLLMProviderPort(llmClient);
  const embeddingDims = embeddingProvider.dims;
  // donor main.ts preferred settings.json voiceTargetUserId; voice is cut, so the
  // primary user comes from the host option or PRIMARY_USER_ID (B7).
  const primaryUserId = options.primaryUserId ?? env.PRIMARY_USER_ID;

  // donor main.ts:405-445 (persistence runtime; the gateway contact-lifecycle port is cut)
  assertBackgroundWorkFitsTurnRecordFenceLane(
    schedulerConfig.backgroundWork.supervisor.maxConcurrentSessions,
  );
  const persistenceRuntime = await createAgentPersistenceRuntime({
    config,
    pathSnapshot,
    embeddingDims,
    ...(primaryUserId ? { primaryUserId } : {}),
  });

  // donor main.ts:497-540 (companion availability; projection is a host port)
  const companionAvailability = new CompanionAvailabilityRuntime({
    store: persistenceRuntime.companionAvailabilityStore,
    project: async snapshot => (options.projectAvailability
      ? await options.projectAvailability(snapshot.state)
      : 'unsupported'),
    queueReadBatchSize: schedulerConfig.backgroundWork.supervisor.maxConcurrentSessions,
    drainRetryDelayMs: schedulerConfig.backgroundWork.supervisor.retryBaseDelayMs,
    returnContextMaxChars: schedulerConfig.freeTime.returnNote.summaryMaxTokens,
    onProjectionDegraded: snapshot => {
      log.warn('Channel does not support companion availability projection', {
        state: snapshot.state,
        revision: snapshot.revision,
      });
    },
    onProjectionError: (error, snapshot) => {
      log.error('Channel availability projection failed; durable state remains authoritative', {
        state: snapshot.state,
        revision: snapshot.revision,
        error: error instanceof Error ? error.message : String(error),
      });
    },
    onDrainError: (error, queued) => {
      log.error('Protected message queue drain paused after delivery failure', {
        channelId: queued.message.channelId,
        messageId: queued.message.id,
        error: error instanceof Error ? error.message : String(error),
      });
    },
    onDrainRuntimeError: error => {
      log.error('Protected message queue persistence failure paused draining', {
        error: error instanceof Error ? error.message : String(error),
      });
    },
  });
  await companionAvailability.initialize();
  const detachToolAvailability = attachToolAvailability({
    eventBus,
    runtime: companionAvailability,
    isLongRunningTool: toolName => toolName === 'analysis_workbench',
    onError: error => {
      log.error('Long-running tool availability projection failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    },
  });

  // donor main.ts:640-676 (contact approvals, social graph stores, tracking gate)
  const operatorNotifier = options.operatorNotifier ?? createLoggingOperatorNotifier();
  const pendingContactApprovals = createFilePendingContactApprovalStore(
    resolvePendingContactApprovalsPath(pathSnapshot.companionDataDir),
  );
  const socialGraphProposalStore = createFileSocialGraphProposalStore(
    resolveSocialGraphProposalsPath(pathSnapshot.companionDataDir),
  );
  const socialGraphWatermarkStore = createFileSocialGraphBuilderWatermarkStore(
    resolveSocialGraphBuilderWatermarkPath(pathSnapshot.companionDataDir),
  );
  const contactTrackingGate = createContactTrackingGate({
    channelLabels: options.channelLabels ?? {},
    pendingApprovals: pendingContactApprovals,
    notifyOperatorPendingContact: async (entry) => {
      await operatorNotifier.notify({
        sender: { kind: 'system', provenance: 'system.contacts.pending_approval' },
        title: 'PSFN contact approval required',
        priority: 4,
        message: [
          `New speaker awaiting contact approval: ${entry.displayName}`,
          `Channel: ${entry.channel} (${entry.channelId})`,
          `First seen: ${entry.firstSeenAt}`,
          'Review in admin: /contact-approvals',
        ].join('\n'),
      });
    },
    logger: log,
    onQueueChanged: () => emitGardenQueueChanged(eventBus, 'contact-approvals'),
  });

  const postgresDatabaseUrl = config.postgresDatabaseUrl?.trim();
  if (!postgresDatabaseUrl) {
    throw new Error('Agent core runtime requires POSTGRES_DATABASE_URL');
  }

  // donor main.ts:678-688 (late-bound long-horizon follow-up router)
  let longHorizonFollowUpRouter:
    | ((input: LongHorizonFollowUpInput) => Promise<string>)
    | null = null;
  const routeLongHorizonFollowUp = async (input: LongHorizonFollowUpInput): Promise<string> => {
    if (!longHorizonFollowUpRouter) {
      throw new Error('Long-horizon intention follow-up scheduler is not ready');
    }
    return longHorizonFollowUpRouter(input);
  };

  // ── donor core-bootstrap.ts (bootstrapAgentCoreRuntime) ──
  // donor startup-context.ts:112, main.ts:700: the core runtime gets the
  // secret-sanitized copy; persistence and the main.ts lanes keep the full config.
  const coreConfig = sanitizeCoreSubstrateConfig(config);
  const { card, systemPrompt } = composeIdentity(coreConfig);
  const cardVersionStore = new CharacterCardVersionStore(
    coreConfig.characterCardPath,
    resolveCharacterCardHistoryPath(pathSnapshot.companionDataDir),
  );
  const cardProposalQueue = createApprovalQueuePortFromConfirmationQueue(new ConfirmationQueue({
    idFactory: () => `card-${randomUUID()}`,
  }));
  log.info(`Loaded character: ${card.data.name}`);
  coreConfig.characterName = card.data.name;
  const textClassifier = options.textEmotionClassifier ?? createStartupTextEmotionClassifier({
    model: coreConfig.textEmotionModel,
    cacheDir: coreConfig.textEmotionCacheDir,
    dtype: coreConfig.textEmotionDtype,
  });
  await warmRuntimeMlServices({
    textClassifier,
    embeddingService: embeddingProvider,
    textEmotionModel: coreConfig.textEmotionModel?.trim() || 'host-supplied',
    logger: log,
  });
  // Lite: the audio classifier is cut with voice (EmotionObserver accepts none).
  const emotionObserver = new EmotionObserver({
    textClassifier: textClassifier as TextEmotionClassifierLike,
  });
  const emotionState = new EmotionState();
  const { safeguardAuditTrail, identityCoolingOff, externalRateLimiter } = createRuntimeSafeguardSurfaces(
    pathSnapshot.companionDataDir,
    env,
  );

  // ── donor core-runtime.ts (buildAgentCoreRuntime) ──
  const companionId = resolveCompanionIdFromConfig(coreConfig);
  const invalidatePromptCache = (reason: string): void => {
    coreConfig.runtimeHooks?.invalidatePromptPrefixCache?.(reason);
  };
  const promptRegistry = wireStaticPromptRegistry(pathSnapshot.companionDataDir, {
    invalidatePromptCache,
  });
  // Lite: the donor app cache in its memory mode (the Redis mode is cut).
  const appCache = createMemoryAppCache({ name: 'app-cache' });
  const decisionRuntime = buildAgentDecisionRuntime({
    config: coreConfig,
    llmProvider,
    companionDataDir: pathSnapshot.companionDataDir,
  });
  const automataPolicy = coreConfig.automataPolicy ?? (() => {
    throw new Error('Automata Bus runtime requires automata-policy.json');
  })();
  const automataStore = persistenceRuntime.automataBusStore;
  const automataRegistry = persistenceRuntime.automataRunRegistry;
  const automataBusProductionRuntime = createAutomataBusProductionRuntime({
    pool: automataStore.getQueryPool(),
    store: automataStore,
    companionId,
    embeddingProvider,
    embeddingIdentity: resolveEmbeddingProviderProvenanceFromConfig(coreConfig, embeddingProvider.dims),
    appCache,
    policy: automataPolicy.bus.query,
    reindexLeaseDurationMs: automataPolicy.bus.reindex.leaseDurationMs,
  });
  const automataWriter = new CanonicalAutomataBusWriter({
    companionId,
    store: automataStore,
    runtime: automataBusProductionRuntime,
  });
  const automataReviewer = createAutomataBusReviewerTask({
    nominations: new PostgresAutomataBusReviewerNominationAdapter({
      pool: automataStore.getQueryPool(),
      companionId,
    }),
    findings: createAutomataBusReviewerFindingAdapter({ store: automataStore, companionId }),
    model: createAutomataBusReviewerModelAdapter({ llmProvider }),
    mutations: createAutomataBusReviewerMutationAdapter({
      companionId,
      registry: automataRegistry,
      store: automataStore,
      writer: automataWriter,
    }),
    outcomes: createAutomataBusReviewerOutcomeAdapter({
      companionId,
      registry: automataRegistry,
      store: automataStore,
      writer: automataWriter,
    }),
    policy: automataPolicy.bus.reviewer,
  });
  const automataWorkerAccess = createProductionAutomataBusWorkerAccess({
    companionId,
    registry: automataRegistry,
    store: automataStore,
    runtime: automataBusProductionRuntime,
    writer: automataWriter,
    bounds: automataBusWorkerBoundsFromOwnerPolicy({
      query: automataPolicy.bus.query,
      recentRunLimit: automataPolicy.recentRunLimit,
    }),
  });
  const automataTerminalLifecycle = createAutomataTerminalLifecycleAdapter({
    companionId,
    registry: automataRegistry,
    store: automataStore,
    writer: automataWriter,
    health: {
      publisher: eventBus,
      source: { owner: resolveHealthEventOwner(companionId), process: 'agent' },
    },
  });
  const automataClassLifecycle: AutomataClassLifecycleRuntime = {
    registry: automataRegistry,
    workerAccess: automataWorkerAccess,
    terminal: automataTerminalLifecycle,
    telemetry: event => log.debug('Automata class lifecycle stage', { ...event }),
  };
  const observerEvalSidecar = createObserverEvalSidecarRuntimeFromConfig(coreConfig, {
    postgresDatabaseUrl,
    eventBus,
    ...(resolveConfigTenantPoolScope(coreConfig) ? { tenant: resolveConfigTenantPoolScope(coreConfig)! } : {}),
    emitProactivityImpulse: async (impulse: EmoSimProactivityImpulse) => {
      await eventBus.emit('emotion.proactive.transition', {
        correlationId: impulse.correlationId,
        lever: impulse.kind,
        stage: 'would_message',
        outcome: 'qualified',
        firedAtMs: impulse.firedAtMs,
        timestamp: impulse.firedAtMs,
      });
      await eventBus.emitRequired('emotion.emosim.proactivity.impulse', impulse);
    },
    proactivityStateStore: persistenceRuntime.emosimProactivityStateStore,
  });
  const sessionIntegrityProvider = options.sessionIntegrityProvider ?? null;
  const sessionComposition = await composeSessionRuntimeAsync({
    ...(sessionIntegrityProvider
      ? { runtimeMode: 'production' as const, sessionIntegrityProvider }
      : { runtimeMode: 'non-production' as const }),
    config: coreConfig,
    postgresDatabaseUrl,
    eventBus,
    enableContinuity: true,
    continuityChannelIds: options.continuityChannelIds ?? [],
    ...(options.continuityChannelPrefixes ? { continuityChannelPrefixes: options.continuityChannelPrefixes } : {}),
    promptRegistry,
    sessionIntegrityRepairBackupRootDir: pathSnapshot.runtimePathLayout.backupsDir,
    automataRetentionCompanionId: companionId,
  });
  const { sessionStore, sessionManager } = sessionComposition;
  const letterService = new LetterService({ store: persistenceRuntime.letterStore, sessionStore });
  const automataRetention = createProductionAutomataRetentionRuntime({
    companionId,
    sessionsDir: sessionComposition.sessionsDir,
    batchLimit: automataPolicy.recentRunLimit,
    registry: automataRegistry,
    runs: persistenceRuntime.automataRunStore,
    bus: automataStore,
    retentionStore: persistenceRuntime.automataRetentionStore,
    sagaStore: persistenceRuntime.automataPurgeSagaStore,
    projection: sessionComposition.exactSessionProjection,
    // Lite: the Redis session tail is cut, so there is no Redis tail to purge.
    redisTail: null,
    writeBarrier: {
      seal: async (input, target) => {
        sessionComposition.exactSessionWriteBarrier.seal(input, target);
        await Promise.all([
          sessionComposition.sessionStore.flushSessionTailWrites(),
          sessionComposition.exactSessionProjection.flushPendingWrites(),
        ]);
      },
    },
  });
  sessionManager.characterName = card.data.name;
  // Lite: CogSec intake sink gates and screening are cut (donor: null when
  // intake-policy.json mode is 'off'), so every sink runs ungated.
  sessionManager.intakeSinkGate = null;
  const selfAuthoredMutationIntake = {
    getIntakeSinkGate: () => null,
    getIntakeScreening: () => sessionManager.intakeScreening,
    getActiveTurnIntakeEnvelopes: () => agentLoop.getActiveTurnIntakeEnvelopes(),
    getActiveTurnSessionIdentity: () => agentLoop.getActiveTurnSessionIdentity(),
  };
  const memoryStore = createMemoryStorePort(persistenceRuntime.memoryStore);
  const characterPromptVariablesProvider = buildCharacterPromptVariablesProvider(cardVersionStore);
  const personaPreamble = createPersonaPreambleService({
    registry: promptRegistry,
    personaVariables: characterPromptVariablesProvider,
  });
  const agentLoop = composeSubstrateAgent({
    eventBus,
    llmProvider,
    runtime: providerServices.runtime,
    sessionManager,
    systemPrompt,
    characterName: card.data.name,
    characterPromptVariablesProvider,
    config: coreConfig,
    // Lite: in-process provider; the donor's 'gateway' wiring mode named the
    // gateway transport. The stream transport defaults to llmClient.stream;
    // a host may wrap it (wrapStreamTransport) to serve host-driven turns.
    ...(options.wrapStreamTransport
      ? { streamTransport: options.wrapStreamTransport({ stream: llmProvider.stream.bind(llmProvider) }) }
      : {}),
    streamRuntimeOptions: {
      onTerminalFailure: createPromptGenerationFailureAlertHandler(operatorNotifier, card.data.name),
    },
    emotionRuntime: {
      observer: emotionObserver,
      state: emotionState,
      requireWiring: true,
    },
    observerEvalSidecar,
    appCache,
    backgroundWorkStore: persistenceRuntime.backgroundWorkStore,
    backgroundWorkTuning: schedulerConfig.backgroundWork,
    backgroundWorkWelfare:
      schedulerConfig.backgroundWorkWelfare ?? DEFAULT_BACKGROUND_WORK_WELFARE_CONFIG,
    backgroundWorkAutomataLifecycle: createBackgroundWorkAutomataLifecycle(automataRegistry),
    intentionHooksAutomataRunner: createIntentionPostTurnHooksAutomataRunner(automataClassLifecycle),
    classifySessionAtCreation: async (message) => {
      const owner = resolveForegroundSessionOwner({
        channelId: message.channelId,
        channelType: message.channelType,
        hasIcpCorrelation: message.routing?.icpCorrelation !== undefined,
        ...(message.routing?.canonicalContactId
          ? { canonicalContactId: message.routing.canonicalContactId }
          : {}),
      });
      await persistenceRuntime.automataSessionClassification.ensureClassifiedAtCreation({
        companionId,
        sessionId: sessionManager.resolveSessionChannelId(message.channelId),
        createdAtMs: message.timestamp.getTime(),
        ...(owner ? { owner } : {}),
      });
    },
    contactTrackingGate,
  });
  agentLoop.artifactApprovalQueue = cardProposalQueue;
  agentLoop.artifactApprovalNotifier = operatorNotifier;
  agentLoop.scratchpadProvider = memoryStore;
  agentLoop.intakeSinkGate = null;
  agentLoop.setCapabilityAccess(capabilityAccess);
  wireDiagnosticsRuntime(eventBus);
  // donor core-runtime.ts:405-440 (operator alert handlers)
  eventBus.on(
    'memory.active_context.refresh',
    createActiveMemoryRefreshFailureAlertHandler({
      notifier: operatorNotifier,
      companionName: card.data.name,
      failureThreshold: coreConfig.memoryRefreshFailureAlertThreshold,
    }),
  );
  eventBus.on('backup.failed', createBackupFailureAlertHandler(operatorNotifier, card.data.name));
  eventBus.on('schedule.task.failed', createScheduledTaskFailureAlertHandler(operatorNotifier, card.data.name));
  eventBus.on(
    'memory.sleep_consolidation.failure',
    createSleepConsolidationFailureAlertHandler(operatorNotifier, card.data.name),
  );
  eventBus.on('intake.quarantine.expired', createQuarantineExpiryAlertHandler(operatorNotifier, card.data.name));
  // The repeated intake-screening failure alert is cut with the CogSec intake
  // firewall (seam 3.4): nothing in Lite emits intake.screening.fail_closed, and
  // its threshold is a cut settings.json key (B7).
  // donor core-runtime.ts:558-573 (doing mirror; the wishlist source is cut with the wiki)
  const doingMirrorService = new DoingMirrorService({
    store: persistenceRuntime.doingMirrorStore,
    letters: letterService,
  });
  // donor core-runtime.ts:599-618 (prompt stack, card, settings, session tools, letter tool)
  const promptStore = wirePromptRuntime(
    agentLoop,
    pathSnapshot.companionDataDir,
    composeSystemPromptTemplate(),
    {
      cardStore: cardVersionStore,
      confirmationQueue: cardProposalQueue,
      identityCoolingOff,
      getCapabilityTier: () => capabilityAccess.getTier(),
      invalidatePromptCache,
      intake: selfAuthoredMutationIntake,
    },
  );
  wireCharacterCardRuntime(agentLoop, cardVersionStore, {
    getCapabilityTier: () => capabilityAccess.getTier(),
    confirmationQueue: cardProposalQueue,
  });
  wireSettingsRuntime(agentLoop, coreConfig, { registerSystemTool: false });
  wireSessionToolsRuntime(agentLoop, sessionManager, pathSnapshot.companionDataDir, llmProvider, promptRegistry);
  agentLoop.registerTool(createLetterTool(letterService, doingMirrorService), 'core');
  // donor core-runtime.ts:619-650 (contacts; multi-companion permit invalidation and peers are cut)
  const contactStore = await registerContactRuntime(
    agentLoop,
    persistenceRuntime.contactStore ?? (() => {
      throw new Error('PostgreSQL core runtime requires an injected contact store');
    })(),
    primaryUserId,
    {
      exportDir: resolveContactsDir(pathSnapshot.companionDataDir),
      proposalQueue: cardProposalQueue,
      blockList: new ContactBlockListStore(resolveContactBlockListPath(pathSnapshot.companionDataDir)),
      intake: selfAuthoredMutationIntake,
    },
  );
  // donor core-runtime.ts:651-740 (biography projection, synthesis and companion review)
  const biographicalPool = createPostgresPool(postgresDatabaseUrl, {
    applicationName: 'biographical-projection',
    allowExitOnIdle: true,
    ...resolveConfigTenantPoolScope(coreConfig),
  });
  let biographicalStore;
  try {
    biographicalStore = await awaitPostgresStoreReadiness(
      'biographical_projection',
      () => createPostgresBiographicalProfileStore(biographicalPool),
    );
  } catch (error) {
    await biographicalPool.end();
    throw error;
  }
  const biographicalDepthPolicy = coreConfig.biographicalDepthPolicy ?? createDefaultBiographicalDepthPolicy();
  const biographicalRevalidator = new MemoryBackedBiographicalSourceRevalidator(memoryStore);
  const biographicalProjection = createRuntimeBiographicalProjection({
    store: biographicalStore,
    revalidator: biographicalRevalidator,
    contactStore,
    companionId,
    policy: biographicalDepthPolicy,
  });
  const biographyCompanionSubject: Extract<BiographicalSubjectRef, { kind: 'companion' }> = {
    kind: 'companion',
    companionId,
    subjectVersion: 1,
  };
  const biographySynthesis = new BiographySynthesisService({
    memoryStore,
    profileStore: biographicalStore,
    llmClient: llmProvider,
    promptRegistry,
    companionSubject: biographyCompanionSubject,
    targets: createBiographySynthesisTargetPort({
      contactStore,
      companionSubject: biographyCompanionSubject,
      depthPolicy: () => coreConfig.biographicalDepthPolicy ?? biographicalDepthPolicy,
    }),
    candidatePolicy: () => (
      coreConfig.biographicalCandidatePolicy ?? createDefaultBiographicalCandidatePolicy()
    ),
    depthPolicy: () => coreConfig.biographicalDepthPolicy ?? biographicalDepthPolicy,
  });
  const biographyCompanionReview = new BiographyCompanionReviewService({
    profileStore: biographicalStore,
    llmClient: llmProvider,
    personaPreamble,
    companionId,
    candidatePolicy: () => (
      coreConfig.biographicalCandidatePolicy ?? createDefaultBiographicalCandidatePolicy()
    ),
  });
  // donor core-runtime.ts:780-825 (intention stores, introspection consent, core memory, concern arcs)
  const intentionRuntime = persistenceRuntime.intentionRuntime ?? (() => {
    throw new Error('PostgreSQL core runtime requires injected intention persistence stores');
  })();
  wireIntentionRuntimeStores(agentLoop, intentionRuntime, persistenceRuntime.intentionProviders ?? {
    concernProvider: null,
    pendingFollowUpProvider: null,
    behavioralPatternProvider: null,
  });
  const introspectionConsentStore = new IntrospectionConsentStore(
    resolveIntrospectionConsentLedgerPath(pathSnapshot.companionDataDir),
  );
  introspectionConsentStore.load();
  const introspectionTurnSensitivityDecisions = new IntrospectionTurnSensitivityDecisions();
  agentLoop.setIntrospectionTurnSensitivityDecisions(introspectionTurnSensitivityDecisions);
  const coreMemoryStore = wireCoreMemoryRuntime({
    agentLoop,
    sessionManager,
    config: coreConfig,
    concernStore: intentionRuntime.concernStore,
    introspectionConsentStore,
    introspectionTurnSensitivityDecisions,
    eventBus,
  });
  const concernResolutionArcRecorder = createConcernResolutionArcRecorder({
    concernStore: intentionRuntime.concernStore,
    journal: new ReflectionJournalStore(
      resolveConcernResolutionArcJournalPath(pathSnapshot.companionDataDir),
    ),
    emotionSink: {
      applyConcernResolutionDelta: (concern, generationId, delta) => (
        agentLoop.applyConcernResolutionDelta(concern.contactId, generationId, delta)
      ),
    },
  });
  eventBus.on('intention.concern.resolution_appraisal', concernResolutionArcRecorder);
  await reconcileConcernResolutionArcsAtStartup({
    concernStore: intentionRuntime.concernStore,
    recorder: concernResolutionArcRecorder,
  });
  wireSelfModelRuntime(agentLoop);
  const intentionAppraisalHooks = createIntentionAppraisalHooks(
    intentionRuntime.concernStore,
    intentionRuntime.pendingFollowUpStore,
    {
      completionVadProvider: (followUp, asOf) => resolveCurrentInternalStateConcernVAD(
        followUp,
        agentLoop.getCurrentInternalState(),
        asOf,
      ),
      nearTermFollowUpHorizonMs: schedulerConfig.intentionFollowUp.nearTermHorizonMs,
      routeLongHorizonFollowUp,
      eventBus,
    },
  );
  const intentionBehavioralHooks = createIntentionBehavioralPatternHooks(
    intentionRuntime.behavioralPatternTracker,
  );
  const automatedConcernRuntime = await createAutomatedConcernRuntime({
    eventBus,
    llmProvider,
    concernStore: intentionRuntime.concernStore,
    personaPreamble,
    routeDispatcher: createDefaultConcernRouteDispatcher({
      companionDataDir: pathSnapshot.companionDataDir,
      eventBus,
      pendingFollowUpStore: intentionRuntime.pendingFollowUpStore,
      sessionActivity: sessionManager,
    }),
    automataClassLifecycle,
  });
  const episodicStore = persistenceRuntime.episodicStore;
  const memoryExtractor = wireMemoryRuntime({
    agentLoop,
    llmProvider,
    decisionRuntime,
    sessionManager,
    sessionStore,
    memoryStore,
    embeddingService: embeddingProvider,
    eventBus,
    config: coreConfig,
    promptRegistry,
    contactStore,
    episodicStore,
    concernCandidateSink: automatedConcernRuntime.extractionSink,
    biographicalProjection,
    biographicalRebuild: {
      profileStore: biographicalStore,
      companionSubject: biographyCompanionSubject,
      policy: biographicalDepthPolicy,
    },
    isAutoContactCreationAllowed: (channelId: string) => contactTrackingGate.isAutoContactCreationAllowed(channelId),
    personaPreamble,
    automataBusWorkerAccess: automataWorkerAccess,
    automataTerminalLifecycle,
    automataRunRegistry: automataRegistry,
  });
  const promptState = createPromptStatePort({ layers: promptStore, registry: promptRegistry });

  // ── back in donor main.ts ──
  // main.ts:783-785 (background work runs under do-not-disturb availability)
  agentLoop.setBackgroundWorkExecutionScope(
    handler => companionAvailability.run('do_not_disturb', handler),
  );
  // main.ts:955-993 (session metadata, startup continuity, internal state rehydration)
  writeStartupSessionMetadata(
    sessionManager,
    pathSnapshot.companionDataDir,
    config.sessionRestartBehavior ?? 'reuse_latest_session',
  );
  await hydrateStartupContinuity({
    memoryProvider: agentLoop.memoryProvider,
    sessionManager,
  });
  agentLoop.setInternalStateStore(persistenceRuntime.internalStateStore);
  const internalStateRehydration = await rehydratePersistedInternalState({
    store: persistenceRuntime.internalStateStore,
    agent: agentLoop,
  });
  if (internalStateRehydration.outcome === 'restored') {
    log.info('Rehydrated persisted internal state', {
      savedAt: internalStateRehydration.savedAt,
      ageMs: internalStateRehydration.ageMs,
    });
  } else if (internalStateRehydration.outcome === 'gap_detected') {
    log.warn('Persisted internal state too stale to rehydrate; continuity gap surfaced', {
      offlineSince: internalStateRehydration.gap.offlineSince,
      gapMs: internalStateRehydration.gap.gapMs,
    });
    await eventBus.emit('internal_state.gap_detected', {
      offlineSince: internalStateRehydration.gap.offlineSince,
      gapMs: internalStateRehydration.gap.gapMs,
      timestamp: Date.now(),
    });
  } else {
    log.info('No persisted internal state snapshot found; starting fresh');
  }

  // main.ts:1015-1067 (scheduler runtime)
  const {
    scheduler,
    postTurnActions,
    backgroundMaintenance,
  } = buildAgentSchedulerRuntime({
    eventBus,
    eligibilityGate,
    config,
    schedulerConfig,
    sessionManager,
    llmProvider,
    embeddingDims,
    memoryStore,
    agentLoop,
    concernStore: intentionRuntime.concernStore,
    concernReviewWorker: automatedConcernRuntime.worker,
    pathSnapshot,
    contactStore,
    socialGraphProposalStore,
    socialGraphWatermarkStore,
    companionAvailability,
    automataReviewer: { task: automataReviewer, companionId },
    automataLifecycle: automataClassLifecycle,
    automataRetention,
    doingMirrorService,
    biographySynthesis,
    biographyCompanionReview,
  });
  // main.ts:1068-1072
  wireLetterMemoryExtraction({
    actions: postTurnActions,
    letters: letterService,
    memoryExtractor,
  });
  // main.ts:1073-1093 (episode search)
  const embeddingProvenance = resolveEmbeddingProviderProvenanceFromConfig(config, embeddingProvider.dims);
  const episodeEmbeddingProfile = {
    documentSchema: EPISODE_SEARCH_DOCUMENT_SCHEMA,
    ...embeddingProvenance,
  };
  const episodeSessionQuarantineFilter = {
    isSessionRetiredOrQuarantined: (sessionId: string) => (
      sessionManager.isSessionRetiredOrQuarantined(sessionId)
    ),
    getRetiredLogicalSessionIds: () => sessionManager.getRetiredLogicalSessionIds(),
  };
  const episodeSearch = createHybridEpisodeSearch({
    store: episodicStore,
    embeddingService: embeddingProvider,
    profile: episodeEmbeddingProfile,
    memoryRetrievalPolicy: () => config.memoryRetrievalPolicy,
    onDegraded: diagnostic => {
      log.warn('Episode search semantic mode degraded', diagnostic);
    },
  });
  // main.ts:1094-1139 (ICP initiation sources in the donor no-broker mode)
  let socialImpulseOutreachRuntime: SocialImpulseOutreachRuntime | undefined;
  const {
    weightedThoughtCandidateAdapter: icpWeightedThoughtCandidateAdapter,
    intentionCandidateAdapter: icpIntentionCandidateAdapter,
    unregisterFeltImpulseAdapter: unregisterIcpFeltImpulseAdapter,
    stopCandidateLifecycleSupervisor: stopIcpCandidateLifecycleSupervisor,
  } = wireIcpInitiationSources({
    config: schedulerConfig.icpAutonomy,
    localCompanionId: config.companionId,
    candidateStore: undefined,
    feltImpulseFunnelStore: persistenceRuntime.icpFeltImpulseFunnelStore,
    peers: undefined,
    isExternalCompanionAuthorized: () => capabilityAccess.has('external.companion'),
    llmProvider,
    eventBus,
    pendingFollowUpStore: intentionRuntime.pendingFollowUpStore,
    concernStore: intentionRuntime.concernStore,
    presenceEnabled: false,
    contactStore,
    weightedThoughtStore: persistenceRuntime.weightedThoughtStore,
    socialDesireStore: persistenceRuntime.socialDesireStore,
    handleFeltImpulse: async signal => {
      if (!socialImpulseOutreachRuntime) {
        throw new Error('social impulse outreach runtime is not composed');
      }
      await socialImpulseOutreachRuntime.onImpulse(signal);
    },
    lifecycleConfig: schedulerConfig.weightedThoughtOutreach.lifecycle,
  });
  // main.ts:1140-1150 (introspection lane, operator ruling: kept with its donor default)
  registerIntrospectionLane({
    scheduler,
    schedulerConfig,
    sessionManager,
    sessionStore,
    llmProvider,
    systemPrompt,
    introspectionConsentStore,
    persistenceRuntime,
    companionDataDir: pathSnapshot.companionDataDir,
  });
  // main.ts:1184-1229 (Lite: subagents and fold review without the shard manager)
  const { foldReviewController } = wireSubagentRuntime({
    agentLoop,
    eventBus,
    llmProvider,
    sessionStore,
    embeddingService: embeddingProvider,
    memoryStore,
    sessionManager,
    config,
    parentSystemPrompt: systemPrompt,
    auditTrail: safeguardAuditTrail,
    snapshotParentCapabilityGrant: () => capabilityAccess.snapshotOwnerGrant(),
    automataRunRegistry: automataRegistry,
    automataSessionClassification: persistenceRuntime.automataSessionClassification,
    automataBusWorkerAccess: automataWorkerAccess,
    automataLifecyclePort: automataTerminalLifecycle,
  });
  doingMirrorService.registerSource(new FoldPackageDoingMirrorSource(
    {
      listFoldReviews: () => foldReviewController.listFoldReviews(),
      getFoldReview: shardId => foldReviewController.getFoldReview(shardId),
    },
    resolveCoreCompanionIdFromConfig(config),
  ));
  // main.ts:1250-1256 (memory writer)
  const roomMembershipAuthority = createCompanionRoomMembershipAuthority(sessionStore);
  const memoryWriter = new MemoryWriter(memoryStore, embeddingProvider, {
    memoryRetrievalPolicy: () => config.memoryRetrievalPolicy,
    ...(config.companionId ? { companionId: config.companionId } : {}),
    roomMembershipAuthority,
  });
  memoryWriter.intakeSinkGateProvider = () => sessionManager.intakeSinkGate;
  // main.ts:1289-1330 (episode semantic index)
  const episodeEmbeddingRuntime = wireEpisodeSemanticIndexRuntime({
    store: episodicStore,
    embedding: embeddingProvider,
    provider: embeddingProvenance.provider,
    model: embeddingProvenance.model,
    backfillLimit: schedulerConfig.episodeSynthesis.maxEpisodesPerRun,
    backgroundMaintenance,
    onBatch: async (source, result) => {
      const health = await episodicStore.getEpisodeEmbeddingIndexHealth(episodeEmbeddingProfile);
      const details = {
        source,
        selected: result.selected,
        written: result.written,
        concurrentlyChanged: result.concurrentlyChanged.length,
        invalid: result.invalid.length,
        failed: result.failed.length,
        noProgress: result.noProgress,
        current: health.current,
        missing: health.missing,
        stale: health.stale,
        persistedFailures: health.failed,
      };
      if (result.failed.length > 0 || result.invalid.length > 0 || result.noProgress) {
        log.warn('Episode semantic index batch completed without full progress', details);
      } else {
        log.info('Episode semantic index batch completed', details);
      }
    },
    onLiveResult: (result) => {
      if (result.status === 'failed' || result.status === 'invalid') {
        log.warn('Live episode semantic indexing failed; persisted for retry', {
          episodeId: result.episodeId,
          error: result.error,
        });
      }
    },
    onLiveError: (error, episode) => {
      log.error('Live episode semantic indexing failed before retry state was persisted', {
        episodeId: episode.id,
        error: error instanceof Error ? error.message : String(error),
      });
    },
  });
  void episodeEmbeddingRuntime.startupBackfill.catch((error: unknown) => {
    log.error('Startup episode semantic index backfill failed', {
      error: error instanceof Error ? error.message : String(error),
    });
  });
  // main.ts:1334-1482 (episodic synthesis, sleep consolidation, arcs, dream meaning)
  const emitThreadAssignment = (event: {
    outcome: 'merged' | 'noop' | 'merge_skipped_oversize' | 'legacy_session_thread_extracted';
    winningThreadId: string;
    losingThreadId: string;
    updatedEpisodeCount: number;
    timestamp: number;
  }): void => {
    eventBus.emit('memory.episodic.thread_assignment', event).catch((error: unknown) => {
      log.warn('Episodic thread-assignment event emit failed', {
        outcome: event.outcome,
        winningThreadId: event.winningThreadId,
        error: String(error),
      });
    });
  };
  const firstPersonPreservingEpisodicStore = persistenceRuntime.firstPersonPreservingEpisodicStore;
  const episodicSynthesizer = new EpisodicSynthesizer(firstPersonPreservingEpisodicStore, sessionManager, {
    onThreadAssignment: emitThreadAssignment,
    transcriptMessageLimit: schedulerConfig.episodeSynthesis.transcriptMessageLimit,
    maxEpisodesPerRun: schedulerConfig.episodeSynthesis.maxEpisodesPerRun,
    maxPriorCandidates: schedulerConfig.episodeSynthesis.maxPriorCandidates,
    gapSplitMinutes: schedulerConfig.episodeSynthesis.gapSplitMinutes,
    maxEntriesPerEpisode: schedulerConfig.episodeSynthesis.maxEntriesPerEpisode,
    minConversationalEntries: schedulerConfig.episodeSynthesis.minConversationalEntries,
    minSingleEntryChars: schedulerConfig.episodeSynthesis.minSingleEntryChars,
    topicSegmentation: {
      enabled: schedulerConfig.episodeSynthesis.topicSegmentationEnabled,
      llmProvider,
      personaPreamble,
      onEvent: (event) => {
        eventBus.emit('memory.episode_synthesis.segmentation', event).catch((error) => {
          log.warn('Episode-synthesis segmentation telemetry emit failed', {
            sessionId: event.sessionId,
            outcome: event.outcome,
            error: String(error),
          });
        });
      },
    },
  });
  const sleepConsolidator = new SleepCycleEpisodeConsolidator(firstPersonPreservingEpisodicStore, sessionManager, llmProvider, {
    reviewWindowMs: schedulerConfig.sleepConsolidation.reviewWindowDays * DAY_MS,
    refinementWindowMs: schedulerConfig.sleepConsolidation.refinementWindowHours * HOUR_MS,
    adjacencyGapMs: schedulerConfig.sleepConsolidation.adjacencyGapMinutes * MINUTE_MS,
    maxRefinementsPerRun: schedulerConfig.sleepConsolidation.maxRefinementsPerRun,
    maxConsolidationsPerRun: schedulerConfig.sleepConsolidation.maxConsolidationsPerRun,
    transcriptMessageLimit: schedulerConfig.sleepConsolidation.transcriptMessageLimit,
    maxTranscriptCharsPerEpisode: schedulerConfig.sleepConsolidation.maxTranscriptCharsPerEpisode,
    personaPreamble,
    onConsolidationFailure: (failure) => {
      eventBus.emit('memory.sleep_consolidation.failure', failure).catch((error: unknown) => {
        log.warn('Sleep-consolidation failure event emit failed', {
          sessionId: failure.sessionId,
          error: String(error),
        });
      });
    },
    onRefinementGate: (event) => {
      eventBus.emit('memory.sleep_consolidation.refinement_gate', event).catch((error: unknown) => {
        log.warn('Sleep-consolidation refinement gate event emit failed', { error: String(error) });
      });
    },
  });
  const arcWeaver = new EpisodeArcWeaver(episodicStore, llmProvider, {
    onThreadAssignment: emitThreadAssignment,
    passIntervalMs: schedulerConfig.arcFormation.passIntervalDays * DAY_MS,
    reviewWindowMs: schedulerConfig.arcFormation.reviewWindowDays * DAY_MS,
    minConfidence: schedulerConfig.arcFormation.minConfidence,
    maxArcsPerRun: schedulerConfig.arcFormation.maxArcsPerRun,
    maxEpisodesPerRun: schedulerConfig.arcFormation.maxEpisodesPerRun,
    onEvent: (event) => {
      eventBus.emit('memory.arc_formation.outcome', event).catch((error: unknown) => {
        log.warn('Arc-formation outcome event emit failed', {
          sessionId: event.sessionId,
          outcome: event.outcome,
          error: String(error),
        });
      });
    },
    personaPreamble,
  });
  const companionAuthoredEpisodicStore = persistenceRuntime.companionAuthoredEpisodicStore;
  const dreamMeaningPass = new DreamMeaningPass({
    getProcessingWatermark: scope => episodicStore.getProcessingWatermark(scope),
    searchByTime: searchOptions => episodicStore.searchByTime(searchOptions),
    upsertProcessingWatermark: input => episodicStore.upsertProcessingWatermark(input),
    updateCompanionAuthoredEpisode: input => (
      companionAuthoredEpisodicStore.updateCompanionAuthoredEpisode(input)
    ),
  }, agentLoop, {
    transcriptReader: sessionManager,
    contactTrust: {
      resolveTrustRanks: async (contactIds) => {
        const entries = await Promise.all(contactIds.map(async (contactId) => {
          const contact = await contactStore.getById(contactId);
          return contact ? ([contactId, trustOrd(contact.trustLevel)] as const) : undefined;
        }));
        return new Map(entries.filter(
          (entry): entry is readonly [string, number] => entry !== undefined,
        ));
      },
    },
    onGateEvent: (event) => {
      eventBus.emit('memory.dream_meaning.gate', event).catch((error: unknown) => {
        log.warn('Dream-meaning gate event emit failed', { error: String(error) });
      });
    },
  });
  // B5 (seam 3.14): the sleeptime wiki pass is the disabled stage.
  const sleeptimeWikiPass = createDisabledSleeptimeWikiPass();
  // main.ts:1483-1525 (behavioural pattern promotion and memory tools)
  intentionRuntime.behavioralPatternTracker.setPromotionHook(
    createBehavioralPatternMemoryPromotionHook(memoryWriter),
  );
  const toolMemoryStore = createSubjectAuthorizedMemoryStore(
    memoryStore,
    () => memorySubjectAccessContextFromCorrelation(getRequestContext()),
  );
  const toolMemoryWriter = new MemoryWriter(toolMemoryStore, embeddingProvider, {
    memoryRetrievalPolicy: () => config.memoryRetrievalPolicy,
    ...(config.companionId ? { companionId: config.companionId } : {}),
    roomMembershipAuthority,
  });
  toolMemoryWriter.intakeSinkGateProvider = () => sessionManager.intakeSinkGate;
  registerMemoryTools(agentLoop, {
    writer: toolMemoryWriter,
    companionId: config.companionId,
    roomMembershipAuthority,
    memoryStore: toolMemoryStore,
    episodicStore,
    episodeSearch,
    sessionReader: sessionStore,
    sessionQuarantineFilter: episodeSessionQuarantineFilter,
    retrievalAccessScope: () => {
      const context = getRequestContext();
      return context?.requesterProvenance === 'self_directed'
        && context.channelId?.startsWith('internal:reflection:') === true
        ? 'companion_self_reflection'
        : undefined;
    },
    contactStore,
    memoryDeletionProposalStore: persistenceRuntime.memoryDeletionProposalStore,
    ...(options.memoryDeletionApprovalPort
      ? { memoryDeletionApprovalPort: options.memoryDeletionApprovalPort }
      : {}),
    memoryDeletionPolicy: () => config.memoryDeletionPolicy,
    memoryRetrievalPolicy: () => config.memoryRetrievalPolicy,
  });
  // main.ts:1691 (markdown journal tool)
  registerMarkdownJournalTools(agentLoop, pathSnapshot.workspaceRoot);
  // main.ts:1710-1717 (long-horizon follow-ups; sender is the host port)
  const outboundSender: MessageSender = options.outboundSender ?? {
    send: async (channelId: string) => {
      throw new Error(`No host outbound sender is wired; cannot deliver to ${channelId}`);
    },
  };
  longHorizonFollowUpRouter = createLongHorizonFollowUpRouter({
    store: persistenceRuntime.scheduledPromptStore,
    scheduler,
    agentLoop,
    sender: outboundSender,
  });
  // main.ts:1922-1925 (outreach outbox)
  const outreachOutbox = await openFileOutreachOutboxStore(
    resolveOutreachOutboxLedgerPath(pathSnapshot.companionDataDir),
    { readLimitSettings: config },
  );
  // main.ts:2021-2027 (social impulse outreach lane)
  const heartbeatChannel = options.heartbeatChannel;
  const heartbeatChannelId = heartbeatChannel?.channelId;
  const socialImpulseOutreachLane = registerSocialImpulseOutreachLane({
    companionId: resolveCoreCompanionIdFromConfig(config),
    store: persistenceRuntime.socialImpulseOutreachStore,
    getMode: () => config.emosimProactivity?.mode ?? 'off',
  });
  socialImpulseOutreachRuntime = socialImpulseOutreachLane.runtime;
  const socialOutreachDrafts = createSocialOutreachDraftRegistry();
  const listPendingConcernCandidates = () => listPendingConcernCandidatesFrom(intentionRuntime.concernStore);
  // main.ts:2140-2150 (proactive outbound, only with a heartbeat channel)
  const outboundReplyGuard = new OutboundReplyDeduper();
  const proactiveOutbound = heartbeatChannelId
    ? new ProactiveOutboundDispatcher({
      sender: outboundSender,
      rateLimiter: externalRateLimiter,
      isApprovedPrimaryChannel: createApprovedPrimaryChannelPolicy(heartbeatChannelId),
      eventBus,
    })
    : null;
  // Single companion: no fleet stagger (donor: undefined without a fleet coordinator).
  const outwardQuietHours = staggerQuietHoursRelease(schedulerConfig.episodicProcessing, undefined);
  // main.ts:2192-2276 (temporal wakeup, free time, weighted thought, social desire, EmoSim sampling)
  registerTemporalWakeupLane({
    scheduler,
    sessionManager,
    config: schedulerConfig.temporalWakeup,
    quietHours: outwardQuietHours,
    eventBus,
    agentLoop,
    llmProvider,
    promptRegistry: promptState.registry,
    proactiveOutbound,
    companionName: card.data.name,
    postTurnActions,
  });
  registerFreeTimeLane({
    scheduler,
    sessionManager,
    config: schedulerConfig.freeTime,
    restWindow: schedulerConfig.episodicProcessing,
    chooserSettings: schedulerConfig.socialAutonomy.freeTimeChooser,
    eventBus,
    agentLoop,
    llmProvider,
    promptRegistry: promptState.registry,
    companionName: card.data.name,
    companionId: config.companionId,
    chargePolicy: config.chargePolicy,
    personalProjects: EMPTY_PERSONAL_PROJECTS,
    contactStore,
    automataLifecycle: automataClassLifecycle,
    listPendingConcernCandidates,
    restSilenceStore: persistenceRuntime.schedulerLaneStateStore,
  });
  registerWeightedThoughtOutreachLane({
    scheduler,
    schedulerConfig,
    eventBus,
    weightedThoughtStore: persistenceRuntime.weightedThoughtStore,
    llmProvider,
    companionName: card.data.name,
    heartbeatChannelId,
    contactStore,
    concernStore: intentionRuntime.concernStore,
    icpWeightedThoughtCandidateAdapter,
  });
  const { socialDesireOutbound, socialDesireHumanDeliveryPolicy, impulseTarget } = registerSocialDesireLane({
    schedulerConfig,
    scheduler,
    postTurnActions,
    eventBus,
    log,
    socialDesireStore: persistenceRuntime.socialDesireStore,
    outreachOutbox,
    heartbeatChannel,
    contactStore,
    icpPeers: undefined,
    localCompanionId: config.companionId,
    turns: agentLoop,
    sessions: sessionStore,
    readEmotion: () => emotionState.getState(),
    drafts: socialOutreachDrafts,
    concernStore: intentionRuntime.concernStore,
    companionName: card.data.name,
    attachFeltSignalWriter: (writer) => {
      agentLoop.socialDesireFeltSignals = writer;
    },
  });
  socialImpulseOutreachLane.setDesireTarget(impulseTarget);
  registerEmoSimProactivitySampling(scheduler, observerEvalSidecar);
  // main.ts:2278-2295 (journal auto-publisher, observed group memory scope classifier)
  const journalAutoPublisher = createOptionalJournalAutoPublisher(pathSnapshot.workspaceRoot, config);
  const observedGroupMemoryScheduler = new ObservedGroupMemoryScheduler({
    // Lite: no channel adapter publishes group-memory channels (donor: the Discord channel view).
    channelGroupMemory: undefined,
    sessionReader: sessionStore,
    watermarkStore: new JsonGroupMemoryWatermarkStore(
      `${pathSnapshot.companionDataDir}/group-memory-watermarks.json`,
    ),
    memoryExtractor,
    contactStore,
    companionNames: [card.data.name],
    companionAuthorIds: config.discordBotId ? [config.discordBotId] : [],
    ...(config.groupMemory ? { groupMemory: config.groupMemory } : {}),
  });
  // main.ts:2338-2453 (reflection runtime; the drift / second-arrow lanes and
  // fleet maintenance are cut)
  await wireReflectionRuntime(
    agentLoop,
    scheduler,
    agentLoop,
    outboundSender,
    pathSnapshot.companionDataDir,
    heartbeatChannelId,
    {
      eventBus,
      llmProvider,
      decisionRuntime,
      automataClassLifecycle,
      capabilityTier: config.capabilityTier,
      compositionalPolicy: config.compositionalPolicy,
      characterPromptVariablesProvider: buildCharacterPromptVariablesProvider(cardVersionStore),
      memoryWriter,
      promptRegistry: promptState.registry,
      reflectionStore: persistenceRuntime.reflectionStore,
      sessionManager,
      conversationalActivityWorkset: sessionComposition.conversationalActivityWorkset,
      emotionState,
      contactStore,
      getActiveConcerns: intentionAppraisalHooks.getActiveConcerns,
      getRecentResolvedConcerns: intentionAppraisalHooks.getRecentResolvedConcerns,
      onIntentionConcernDecision: intentionAppraisalHooks.onIntentionConcernDecision,
      onIntentionFollowUpDecision: intentionAppraisalHooks.onIntentionFollowUpDecision,
      resolveIntentionFollowUpDestination: createIntentionFollowUpDestinationResolver({
        ...(heartbeatChannelId
          ? { heartbeatChannel: { channelId: heartbeatChannelId, channelType: 'discord' as const } }
          : {}),
        contactStore,
        sessionStore,
        capabilityRuntime: capabilityAccess,
      }),
      getPendingFollowUpsForResurfacing: intentionAppraisalHooks.getPendingFollowUpsForResurfacing,
      onIntentionFollowUpActivated: intentionAppraisalHooks.onIntentionFollowUpActivated,
      onIntentionFollowUpDampened: intentionAppraisalHooks.onIntentionFollowUpDampened,
      onBehavioralPatternOutcome: intentionBehavioralHooks.onBehavioralPatternOutcome,
      pendingFollowUpStore: intentionRuntime.pendingFollowUpStore,
      intentionFollowUpHorizonMs: schedulerConfig.intentionFollowUp.nearTermHorizonMs,
      routeLongHorizonFollowUp,
      ...(icpIntentionCandidateAdapter ? { icpIntentionCandidateAdapter } : {}),
      scheduledPromptStore: persistenceRuntime.scheduledPromptStore,
      coreMemoryStore,
      episodicSynthesizer,
      sleepConsolidator,
      arcWeaver,
      dreamMeaningPass,
      episodicReviewStore: episodicStore,
      sleeptimeWikiPass,
      proactiveOutbound,
      outboundReplyGuard,
      outreachOutbox,
      ...(socialDesireOutbound ? { socialDesireOutbound } : {}),
      ...(socialDesireHumanDeliveryPolicy ? { socialDesireHumanDeliveryPolicy } : {}),
      listPendingConcernCandidates,
      concernCandidateReview: {
        list: listPendingConcernCandidates,
        decide: ({ id, decision, actionId }) => applyConcernCandidateDecision(intentionRuntime.concernStore, {
          id,
          decision,
          evidenceRef: { kind: 'runtime', ref: `sleeptime-review:${actionId}` },
        }),
      },
      // Lite: no personal projects (wiki cut), so no project is live.
      verifyPersonalProjectLive: async () => false,
      memoryMaintenanceStore: memoryStore,
      episodicDiagnosticsStore: episodicStore,
      postTurnActions,
      backgroundMaintenance,
      episodicProcessingRestWindow: schedulerConfig.episodicProcessing,
      orientationRewriteGate: schedulerConfig.orientationRewrite,
      resolvedConcernStore: intentionRuntime.concernStore,
      reflectionNoveltyGate: schedulerConfig.reflectionNovelty,
      nearTurnMemoryCadence: schedulerConfig.nearTurnMemory,
      episodeSynthesis: schedulerConfig.episodeSynthesis,
      episodicWatermarkStore: episodicStore,
      companionNames: [card.data.name],
      companionAuthorIds: config.discordBotId ? [config.discordBotId] : [],
      memoryScopeClassifier: observedGroupMemoryScheduler,
      intentionAppraisalEnabled: config.intentionAppraisalEnabled !== false,
      ...(journalAutoPublisher ? { vaultAutoPublisher: journalAutoPublisher } : {}),
    },
  );

  // main.ts:2501-2511 (readiness seal, scheduler start, init/ready events)
  const postgresReadiness = await sealPostgresStoreReadinessBeforeReady();
  if (postgresReadiness.degraded.length > 0) {
    log.warn('Optional PostgreSQL stores degraded at startup', {
      stores: postgresReadiness.degraded.map(entry => entry.store).join(','),
      mismatches: postgresReadiness.degraded.map(entry => entry.mismatch).join('; '),
    });
  }
  scheduler.start();
  await eventBus.emit('system.init', {});
  await eventBus.emit('system.ready', {});
  log.info('Ready — waiting for messages');

  // donor main.ts:2114-2128 (stopFn) and control-plane.ts:226-288 (the
  // shutdown sequence) minus the cut steps: gateway, debug observer, health
  // watchdog, module loader, API / admin servers, charge ledger, fatigue
  // reservations, session tail cache, skill telemetry and the observed-group
  // drain (registered only by the cut gateway message handlers).
  const stopSequence = createRetryableShutdown(async () => {
    unregisterIcpFeltImpulseAdapter();
    await stopIcpCandidateLifecycleSupervisor();
    const timeoutMs = 10_000;
    await runShutdownSequence([
      { step: 'emit system.shutdown event', action: () => eventBus.emit('system.shutdown', {}) },
      {
        step: 'abort background work recovery',
        action: () => agentLoop.abortBackgroundWorkRecovery(),
        failClosed: true,
      },
      { step: 'stop scheduler', action: () => scheduler.stop() },
      {
        step: 'stop durable background work supervisor',
        action: () => runShutdownStep(
          'stop durable background work supervisor',
          () => agentLoop.stopBackgroundWork(),
          log,
          2,
          true,
        ),
        maxAttempts: 1,
        failClosed: true,
      },
      {
        step: 'drain memory extractor',
        action: async () => {
          const drained = await memoryExtractor.stop({ timeoutMs });
          if (!drained) {
            log.warn('Proceeding with shutdown before extraction drain completed', { timeoutMs });
          }
        },
      },
      {
        step: 'write graceful shutdown markers',
        action: () => {
          const markedChannels = sessionStore.markGracefulShutdownForActiveChannels();
          if (markedChannels.length > 0) {
            log.info('Wrote graceful shutdown markers', { channels: markedChannels });
          }
        },
      },
      {
        // donor main.ts:2050-2084 (closeDatabase), the kept stores in donor order.
        step: 'close database',
        action: async () => {
          await detachToolAvailability();
          await companionAvailability.stop();
          await persistenceRuntime.contactLifecycleRecovery?.stop();
          await biographicalPool.end();
          await persistenceRuntime.icpFeltImpulseFunnelStore.close();
          await persistenceRuntime.emosimProactivityStateStore.close();
          await persistenceRuntime.socialImpulseOutreachStore.close();
          await persistenceRuntime.backgroundWorkStore.close();
          await persistenceRuntime.automataBusStore.close();
          await persistenceRuntime.automataRunRegistry.close();
          await persistenceRuntime.introspectionLandmarkStore.close();
          await persistenceRuntime.companionAvailabilityStore.close();
          await persistenceRuntime.letterStore.close();
          await persistenceRuntime.doingMirrorStore.close();
          await postgresPoolOwner.close();
        },
      },
    ], log);
    log.info('Stopped');
  });
  return {
    agentLoop,
    eventBus,
    scheduler,
    llmProvider,
    persistence: persistenceRuntime,
    sessionManager,
    stop: stopSequence,
  };
}
