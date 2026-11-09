// Lite cut (seam 3.11, extraction/cuts.tsv): the donor agent persistence
// runtime minus the scaffolding stores (fleet tenancy preflight and shared
// schema, companion presence, fleet system health and escalation stores, fleet
// maintenance, ICP initiation candidates, social pot, speaking arbiter, room
// participation leases, hub identity enrollment, CogSec receipts, custody
// snapshots, egress delivery records, the custody chain reader, partner
// affect shadow, human escalations and the health event stream). Each kept
// store applies its own migration chain on connect, so this is the Lite
// migration chain.
import { MemoryJournal } from '../faculties/memory/journal.js';
import type { MemoryStorePort } from '../faculties/memory/memory-store-port.js';
import type { MemoryDeletionProposalStorePort } from '../faculties/memory/deletion-proposals.js';
import { createPostgresMemoryStore } from '../faculties/memory/postgres-store.js';
import {
  createPostgresEpisodicStore,
  type EpisodicStorePort,
} from '../faculties/memory/episodic/index.js';
import type {
  CompanionAuthoredEpisodicStorePort,
  EpisodeEmbeddingRuntimeStorePort,
  FirstPersonPreservingEpisodicStorePort,
} from '../faculties/memory/episodic/store-port.js';
import { createPostgresContactStore } from '../core/contacts/postgres-adapter.js';
import type { ContactStorePort } from '../core/contacts/contact-store-port.js';
import { createPostgresIntentionPorts } from '../core/intention/postgres-adapters.js';
import type {
  IntentionRuntimeProviders,
  IntentionRuntimeWiring,
} from '../core/intention/runtime-wiring.js';
import type { WeightedThoughtStorePort } from '../core/intention/weighted-thought-store-port.js';
import type { SocialDesireStorePort } from '../core/intention/social-desire-store-port.js';
import type {
  PersistenceBackend,
  SubstrateConfig,
} from '../system/config/runtime-config-contracts.js';
import {
  migrateLegacyPersistenceLayout,
  resolveContactsDir,
  resolveMemoryJournalPath,
  resolveNotesDir,
  resolveReflectionMetacognitionJournalPath,
  resolveScratchpadMirrorPath,
  type RuntimePathSnapshot,
} from './layout.js';
import {
  ReflectionMetacognitionJournalStore,
} from './journals/reflection-metacognition-journal.js';
import { PostgresReflectionMetacognitionMirrorStore } from './reflections/postgres-mirror.js';
import { PostgresInternalStateStore } from './postgres/internal-state-store.js';
import type { InternalStateStorePort } from '../core/self-model/internal-state-persistence.js';
import { PostgresParticipantTrendStore } from './postgres/participant-trend-store.js';
import type { ParticipantTrendStorePort } from '../core/emotion/participant-trend-persistence.js';
import { PostgresScheduledPromptStore } from './postgres/scheduled-prompt-store.js';
import { PostgresSchedulerLaneStateStore } from './postgres/scheduler-lane-state-store.js';
import type { RestSilenceStorePort } from '../core/scheduler/rest-window-policy.js';
import type { WorldExplorationStatePort } from '../core/scheduler/world-exploration-state.js';
import type { ScheduledPromptStorePort } from '../core/scheduler/scheduled-prompt-store-port.js';
import { PostgresCompanionAvailabilityStore } from './postgres/companion-availability-store.js';
import type { CompanionAvailabilityStorePort } from '../core/agent/companion-availability.js';
import { PostgresIcpFeltImpulseFunnelStore } from './postgres/icp-felt-impulse-funnel-store.js';
import type { IcpFeltImpulseFunnelStorePort } from '../core/icp/felt-impulse-funnel.js';
import { PostgresEmoSimProactivityStateStore } from './postgres/emosim-proactivity-state-store.js';
import type { EmoSimProactivityStateStorePort } from '../core/emotion/emosim-proactivity-port.js';
import { PostgresSocialImpulseOutreachStore } from './postgres/social-impulse-outreach-store.js';
import type { SocialImpulseOutreachStorePort } from '../core/emotion/social-impulse-outreach.js';
import { createPostgresPool, ensurePostgresSchemaExists } from './postgres.js';
import { IntrospectionLandmarkPostgresStore } from '../faculties/introspection/postgres-store.js';
import { PostgresBackgroundWorkStore } from './postgres/background-work-store.js';
import type { BackgroundWorkStorePort } from '../core/agent/background-work/store-port.js';
import type { ContactLifecycleGatewayPort } from '../core/contacts/contact-lifecycle-gateway-port.js';
import { ContactLifecycleRecoveryRuntime } from '../core/contacts/contact-lifecycle-recovery-runtime.js';
import { awaitPostgresStoreReadiness } from './postgres/runtime-readiness.js';
import { PostgresAutomataRunStore } from './postgres/automata-run-store.js';
import { AutomataRunRegistry } from '../faculties/automata/run-registry.js';
import { createBackgroundWorkRunRedeliveryOracle } from '../core/agent/background-work/automata-run-redelivery.js';
import {
  connectPostgresAutomataBusRuntimeStore,
  type PostgresAutomataBusRuntimeStore,
} from '../faculties/automata/bus/runtime-store.js';
import { PostgresAutomataRetentionStore } from '../faculties/automata/retention-postgres-store.js';
import { AutomataSessionClassificationService } from '../faculties/automata/session-classification.js';
import { PostgresExactSessionPurgeSagaStore } from './postgres/automata-exact-session-purge-store.js';
import { resolveConfigTenantPoolScope } from './postgres/tenant-pool-scope.js';
import { PostgresLetterStore } from './postgres/letter-store.js';
import type { LetterStorePort } from '../core/letters/contracts.js';
import { PostgresDoingMirrorStore } from './postgres/doing-mirror-store.js';
import type { DoingMirrorStorePort } from '../core/doing-mirror/contracts.js';

export interface AgentPersistenceRuntime {
  backend: PersistenceBackend;
  memoryStore: MemoryStorePort;
  /** Postgres-only durable deletion proposal and linked audit authority. */
  memoryDeletionProposalStore: MemoryDeletionProposalStorePort;
  episodicStore: EpisodicStorePort & EpisodeEmbeddingRuntimeStorePort;
  /** Consolidation-only capability for source-proven first-person preservation. */
  firstPersonPreservingEpisodicStore: EpisodicStorePort & FirstPersonPreservingEpisodicStorePort;
  /** Narrow capability for the companion's own first-person affect/meaning writes. */
  companionAuthoredEpisodicStore: CompanionAuthoredEpisodicStorePort;
  reflectionStore: ReflectionMetacognitionJournalStore;
  contactStore?: ContactStorePort;
  intentionRuntime?: IntentionRuntimeWiring;
  intentionProviders?: IntentionRuntimeProviders;
  weightedThoughtStore?: WeightedThoughtStorePort;
  /** Per-contact durable social desire store (bead oth4.1); Postgres-backed, hydrated at startup. */
  socialDesireStore?: SocialDesireStorePort;
  internalStateStore: InternalStateStorePort;
  participantTrendStore: ParticipantTrendStorePort;
  scheduledPromptStore: ScheduledPromptStorePort;
  /** Companion-private scheduler lane state (rest silence, world exploration). */
  schedulerLaneStateStore: RestSilenceStorePort & WorldExplorationStatePort;
  companionAvailabilityStore: CompanionAvailabilityStorePort & { close(): Promise<void> };
  /** Companion-private durable asynchronous correspondence bin. */
  letterStore: LetterStorePort;
  /** Companion-private outcome mirror with durable partner-Letter delivery metadata. */
  doingMirrorStore: DoingMirrorStorePort;
  introspectionLandmarkStore: IntrospectionLandmarkPostgresStore;
  backgroundWorkStore: BackgroundWorkStorePort;
  automataRunRegistry: AutomataRunRegistry;
  /** Exact durable run authority retained beyond the bounded registry discovery view. */
  automataRunStore: PostgresAutomataRunStore;
  /** Companion-locked canonical Automata Bus store; derived search indexes are not authority. */
  automataBusStore: PostgresAutomataBusRuntimeStore;
  automataRetentionStore: PostgresAutomataRetentionStore;
  automataSessionClassification: AutomataSessionClassificationService;
  automataPurgeSagaStore: PostgresExactSessionPurgeSagaStore;
  /** Content-free exactly-once provenance for qualified felt-impulse fires. */
  icpFeltImpulseFunnelStore: IcpFeltImpulseFunnelStorePort;
  /** Companion-local production cursor; never stored in eval telemetry rows. */
  emosimProactivityStateStore: EmoSimProactivityStateStorePort & { close(): Promise<void> };
  /** One companion's durable content-free social-impulse disposition ledger. */
  socialImpulseOutreachStore: SocialImpulseOutreachStorePort
    & Pick<PostgresSocialImpulseOutreachStore, 'getHealthSummary'>
    & { close(): Promise<void> };
  /** Leased contact-authority recovery, started before the factory returns. */
  contactLifecycleRecovery?: ContactLifecycleRecoveryRuntime;
}

export interface CreateAgentPersistenceRuntimeOptions {
  config: Pick<
    SubstrateConfig,
    | 'databasePath'
    | 'persistenceBackend'
    | 'postgresDatabaseUrl'
    | 'postgresSchema'
    | 'postgresRole'
    | 'multiCompanion'
    | 'memoryDeletionPolicy'
    | 'companionId'
    | 'automataPolicy'
    | 'observerEvalSidecar'
  >;
  pathSnapshot: RuntimePathSnapshot;
  embeddingDims: number;
  primaryUserId?: string;
  contactLifecycleGateway?: ContactLifecycleGatewayPort;
  onContactLifecycleRecoveryFailure?: (error: unknown) => void;
}

export async function createAgentPersistenceRuntime(
  options: CreateAgentPersistenceRuntimeOptions,
): Promise<AgentPersistenceRuntime> {
  migrateLegacyPersistenceLayout(options.pathSnapshot.companionDataDir);

  if (options.config.persistenceBackend !== 'postgres') {
    throw new Error('Agent persistence runtime requires config.persistenceBackend=postgres');
  }
  const databaseUrl = options.config.postgresDatabaseUrl?.trim();
  if (!databaseUrl) {
    throw new Error('PostgreSQL persistence requires config.postgresDatabaseUrl');
  }

  // Multi-companion tenancy (sprint 10, W2). When a per-companion schema is
  // configured, every runtime persistence pool below pins its role and
  // search_path to the explicitly provisioned tenant boundary. Startup checks
  // that boundary but never creates or repairs it. When unset, `schema` stays
  // undefined and behavior is byte-identical to single-companion public mode.
  const tenantScope = resolveConfigTenantPoolScope(options.config);
  const schema = tenantScope?.schema ?? (options.config.postgresSchema?.trim() || undefined);
  const tenantRole = tenantScope?.role;
  if (schema) {
    const bootstrapPool = createPostgresPool(databaseUrl, {
      applicationName: 'psfn-schema-bootstrap',
      allowExitOnIdle: true,
      max: 1,
      schema,
    });
    try {
      await awaitPostgresStoreReadiness(
        'tenant_boundary',
        () => ensurePostgresSchemaExists(bootstrapPool, schema),
      );
    } finally {
      await bootstrapPool.end();
    }
  }

  const icpFeltImpulseFunnelStore = await awaitPostgresStoreReadiness(
    'icp_felt_impulse_funnel',
    () => PostgresIcpFeltImpulseFunnelStore.connect(databaseUrl, {
      schema,
      role: tenantRole,
    }),
  );
  const emosimProactivityStateStore = await awaitPostgresStoreReadiness(
    'emosim_proactivity_state',
    () => PostgresEmoSimProactivityStateStore.connect(databaseUrl, {
      schema,
      role: tenantRole,
      legacySidecarId: options.config.observerEvalSidecar?.sidecarId,
    }),
  );
  const socialImpulseOutreachStore = await awaitPostgresStoreReadiness(
    'social_impulse_outreach',
    () => PostgresSocialImpulseOutreachStore.connect(databaseUrl, {
      schema,
      role: tenantRole,
    }),
  );

  const intentionRuntime = await awaitPostgresStoreReadiness(
    'intention',
    () => createPostgresIntentionPorts(databaseUrl, { schema, role: tenantRole }),
  );
  const contactStore = await awaitPostgresStoreReadiness(
    'contacts',
    () => createPostgresContactStore(databaseUrl, options.primaryUserId, {
      exportDir: resolveContactsDir(options.pathSnapshot.companionDataDir),
      schema,
      role: tenantRole,
      ...(options.contactLifecycleGateway
        ? { contactLifecycleGateway: options.contactLifecycleGateway }
        : {}),
    }),
  );
  const episodicStore = createPostgresEpisodicStore(databaseUrl, { schema, role: tenantRole });
  const memoryStore = await awaitPostgresStoreReadiness(
    'memory',
    () => createPostgresMemoryStore(databaseUrl, options.embeddingDims, {
      notesDir: resolveNotesDir(options.pathSnapshot.companionDataDir),
      scratchpadMirrorPath: resolveScratchpadMirrorPath(options.pathSnapshot.companionDataDir),
      journal: new MemoryJournal(resolveMemoryJournalPath(options.pathSnapshot.companionDataDir)),
      schema,
      role: tenantRole,
      memoryDeletionPolicy: () => options.config.memoryDeletionPolicy,
    }),
  );
  const reflectionMirror = await awaitPostgresStoreReadiness(
    'reflection',
    () => PostgresReflectionMetacognitionMirrorStore.connect(databaseUrl, {
      schema,
      role: tenantRole,
    }),
  );
  const companionId = options.config.companionId?.trim();
  if (!companionId) throw new Error('Automata run persistence requires config.companionId');
  if (!options.config.automataPolicy) throw new Error('Automata run persistence requires automata-policy.json');
  const automataRunStore = await awaitPostgresStoreReadiness(
    'automata_runs',
    () => PostgresAutomataRunStore.connect(databaseUrl, companionId, { schema, role: tenantRole }),
  );
  // The durable background-work queue is the only redelivery owner for
  // lease_retry runs, so it must be readable before the registry reconciles
  // runs orphaned by the previous process.
  const backgroundWorkStore = await awaitPostgresStoreReadiness(
    'background_work',
    () => PostgresBackgroundWorkStore.connect(databaseUrl, { schema, role: tenantRole }),
  );
  const automataRunRegistry = await AutomataRunRegistry.hydrate({
    companionId,
    policy: options.config.automataPolicy,
    store: automataRunStore,
    redelivery: createBackgroundWorkRunRedeliveryOracle(backgroundWorkStore),
  });
  const automataBusStore = await awaitPostgresStoreReadiness(
    'automata_bus',
    () => connectPostgresAutomataBusRuntimeStore(
      databaseUrl,
      companionId,
      automataRunRegistry,
      { schema, role: tenantRole },
    ),
  );
  const automataRetentionStore = await awaitPostgresStoreReadiness(
    'automata_retention',
    async () => new PostgresAutomataRetentionStore(automataBusStore.getQueryPool()),
  );
  const automataSessionClassification = new AutomataSessionClassificationService(
    { rawSessionRetentionMs: options.config.automataPolicy.rawSessionRetentionMs },
    automataRetentionStore,
  );
  const automataPurgeSagaStore = new PostgresExactSessionPurgeSagaStore(
    automataBusStore.getQueryPool(),
    companionId,
  );
  const runtime: AgentPersistenceRuntime = {
    backend: 'postgres',
    memoryStore,
    memoryDeletionProposalStore: memoryStore.memoryDeletionProposalStore,
    episodicStore,
    firstPersonPreservingEpisodicStore: episodicStore,
    companionAuthoredEpisodicStore: episodicStore,
    reflectionStore: new ReflectionMetacognitionJournalStore(
      resolveReflectionMetacognitionJournalPath(options.pathSnapshot.companionDataDir),
      {
        mirror: reflectionMirror,
      },
    ),
    contactStore,
    intentionRuntime,
    intentionProviders: intentionRuntime,
    weightedThoughtStore: intentionRuntime.weightedThoughtStore,
    socialDesireStore: intentionRuntime.socialDesireStore,
    internalStateStore: await awaitPostgresStoreReadiness(
      'internal_state',
      () => PostgresInternalStateStore.connect(databaseUrl, { schema, role: tenantRole }),
    ),
    participantTrendStore: await awaitPostgresStoreReadiness(
      'participant_trend',
      () => PostgresParticipantTrendStore.connect(databaseUrl, { schema, role: tenantRole }),
    ),
    scheduledPromptStore: await awaitPostgresStoreReadiness(
      'scheduled_prompts',
      () => PostgresScheduledPromptStore.connect(databaseUrl, { schema, role: tenantRole }),
    ),
    schedulerLaneStateStore: await awaitPostgresStoreReadiness(
      'scheduler_lane_state',
      () => PostgresSchedulerLaneStateStore.connect(databaseUrl, { schema, role: tenantRole }),
    ),
    companionAvailabilityStore: await awaitPostgresStoreReadiness(
      'companion_availability',
      () => PostgresCompanionAvailabilityStore.connect(databaseUrl, { schema, role: tenantRole }),
    ),
    letterStore: await awaitPostgresStoreReadiness(
      'letters',
      () => PostgresLetterStore.connect(databaseUrl, { schema, role: tenantRole }),
    ),
    doingMirrorStore: await awaitPostgresStoreReadiness(
      'doing_mirror',
      () => PostgresDoingMirrorStore.connect(databaseUrl, { schema, role: tenantRole }),
    ),
    introspectionLandmarkStore: await awaitPostgresStoreReadiness(
      'introspection',
      () => IntrospectionLandmarkPostgresStore.connect(databaseUrl, { schema, role: tenantRole }),
    ),
    backgroundWorkStore,
    automataRunRegistry,
    automataRunStore,
    automataBusStore,
    automataRetentionStore,
    automataSessionClassification,
    automataPurgeSagaStore,
    icpFeltImpulseFunnelStore,
    emosimProactivityStateStore,
    socialImpulseOutreachStore,
  };
  if (!options.contactLifecycleGateway) return runtime;
  const contactLifecycleRecovery = new ContactLifecycleRecoveryRuntime({
    store: contactStore,
    ...(options.onContactLifecycleRecoveryFailure
      ? { onFailure: options.onContactLifecycleRecoveryFailure }
      : {}),
  });
  // This is deliberately awaited before returning: callers cannot register
  // contact tools, RPC callbacks, or Garden/admin surfaces first.
  await contactLifecycleRecovery.recoverBeforeExposure();
  contactLifecycleRecovery.start();
  return { ...runtime, contactLifecycleRecovery };
}
