/**
 * The light Garden's services: the donor Garden services the eight screens
 * read and write, composed as the donor's local admin contract composed them
 * (operator/garden/local-admin-contract.ts:393-1067), over the instances the
 * running companion uses (`CompanionRuntime.garden`, seam S8). Only the
 * services of the kept screens are built; the cut ones (dashboard, settings
 * service, values journal routes, wiki, charge, fleet, CogSec, ...) are not.
 * Each composition step cites the donor lines it mirrors.
 */
import {
  AdminAutomataDataService,
  AdminBiographicalReviewService,
  AdminConcernDataService,
  AdminContactsDataService,
  AdminIdentityDataService,
  AdminMemoryDataService,
  AdminPromptsDataService,
  AdminSchedulerService,
  AdminSessionDataService,
  NorthStarStore,
  PostgresAdminAutomataBusReadAdapter,
  PromptRuntimeLayoutStore,
  ReflectionJournalStore,
  ValuesJournalStore,
  createAdminGraphProposalsService,
  createCompanionRoomMembershipAuthority,
  createContactRelationshipScoreReader,
  createSubjectAuthorizedMemoryStore,
  invalidateCachedPromptRuntimeLayoutStore,
  loadSchedulerConfig,
  resolveCompanionNameFromConfig,
  resolveConcernResolutionArcJournalPath,
  resolveLegacyValuesJournalPath,
  resolveMorningWakeSnapshot,
  resolveNorthStarPath,
  resolvePromptRuntimeLayoutPath,
  resolveValuesJournalPath,
  sanitizeCoreSubstrateConfig,
  type CompanionRuntime,
  type SubstrateConfig,
} from './companion.ts';
import { GardenAudit } from './audit.ts';

/** Where the owner files live: the host's data directory and the companion's shipped seeds. */
export interface GardenOwnerFiles {
  readonly dataDir: string;
  readonly seedDir: string;
}

/** Who the Garden's operator is: the companion's primary contact, the one human of a single-operator install. */
export interface GardenOperator {
  readonly contactId: string;
}

export type GardenCompanion = Pick<CompanionRuntime, 'garden' | 'persistence' | 'sessionManager' | 'scheduler' | 'eventBus'>;

export interface GardenServices {
  readonly companionId: string;
  readonly companionDataDir: string;
  readonly ownerFiles: GardenOwnerFiles;
  readonly operator: GardenOperator;
  readonly companion: GardenCompanion;
  readonly audit: GardenAudit;
  readonly memory: AdminMemoryDataService;
  readonly biographicalReview: AdminBiographicalReviewService | null;
  readonly sessions: AdminSessionDataService;
  readonly contacts: AdminContactsDataService;
  readonly graphProposals: ReturnType<typeof createAdminGraphProposalsService>;
  readonly concerns: AdminConcernDataService;
  readonly identity: AdminIdentityDataService;
  readonly prompts: AdminPromptsDataService;
  readonly scheduler: AdminSchedulerService;
  readonly automata: AdminAutomataDataService | null;
}

export function composeGardenServices(companion: GardenCompanion, ownerFiles: GardenOwnerFiles, operator: GardenOperator): GardenServices {
  const handles = companion.garden;
  const { config, companionDataDir, companionId } = handles;
  const audit = new GardenAudit(companionDataDir);
  const operatorAudit = audit.appender('operator');
  const companionName = () => resolveCompanionNameFromConfig(config);

  // local-admin-contract.ts:404-420: the values journal (read for the persona's values layer), the concern arcs, the north star.
  const valuesJournal = new ValuesJournalStore(resolveValuesJournalPath(companionDataDir), {
    legacyFilePaths: [resolveLegacyValuesJournalPath(companionDataDir)],
  });
  const concernResolutionArcJournal = new ReflectionJournalStore(resolveConcernResolutionArcJournalPath(companionDataDir));
  const northStarStore = new NorthStarStore(resolveNorthStarPath(companionDataDir));
  // local-admin-contract.ts:486-495.
  const promptRuntimeLayoutPath = resolvePromptRuntimeLayoutPath(companionDataDir);
  const promptRuntimeLayoutStore = new PromptRuntimeLayoutStore(promptRuntimeLayoutPath, {
    onMutation: (reason) => {
      invalidateCachedPromptRuntimeLayoutStore(promptRuntimeLayoutPath);
      config.runtimeHooks?.invalidatePromptPrefixCache?.(reason);
    },
  });
  // local-admin-contract.ts:501-512: the wake window is recomputed from the scheduler owner file on each read.
  const scheduler = new AdminSchedulerService(companion.scheduler, companionDataDir, () => resolveMorningWakeSnapshot({
    sessionManager: companion.sessionManager,
    morning: loadSchedulerConfig(ownerFiles.dataDir, { seedDir: ownerFiles.seedDir }).temporalWakeup.morningWake,
  }));

  // local-admin-contract.ts:766-776: the Garden reads memory through the subject-authorized projection
  // with one frozen context for every request. The donor's legacy token Garden passed an empty one, which
  // hides every memory about a person, the operator's own included. Lite's Garden operator is the primary
  // contact, the only admin of a single-operator install, so it gets the context the donor gave a signed
  // owner on a single-admin deployment (memory-service.ts:189-204 with accessMode `sole_admin`,
  // subject-authorized-store.ts:44-52): the operator as viewer, every subject class visible to them.
  const gardenMemoryStore = createSubjectAuthorizedMemoryStore(handles.memoryStore, Object.freeze({
    viewerContactId: operator.contactId,
    adminAccessMode: 'sole_admin' as const,
  }));
  // local-admin-contract.ts:779-797.
  const memory = new AdminMemoryDataService({
    memoryStore: gardenMemoryStore,
    fleetMemoryStore: handles.memoryStore,
    contactStore: handles.contactStore,
    embeddingService: handles.embeddingService,
    companionId,
    roomMembershipAuthority: createCompanionRoomMembershipAuthority(handles.sessionStore),
    resolveCompanionName: companionName,
    appendAuditTimelineEntry: operatorAudit,
  });

  // local-admin-contract.ts:807-822: the automata read service, with the donor main.ts:784-789 bus read adapter.
  const automataPolicy = config.automataPolicy;
  const bus = automataPolicy === undefined
    ? null
    : new PostgresAdminAutomataBusReadAdapter({
      pool: companion.persistence.automataBusStore.getQueryPool(),
      vector: handles.automataBusVector,
      companionId,
      maxPageLimit: automataPolicy.operatorMutationLimit,
    });
  const automata = automataPolicy === undefined
    ? null
    : new AdminAutomataDataService({
      registry: companion.persistence.automataRunRegistry,
      companionId,
      readPolicy: { defaultPageLimit: automataPolicy.recentRunLimit, maxPageLimit: automataPolicy.operatorMutationLimit },
      coveragePolicy: automataPolicy.bus.health,
      bus,
      lessons: bus,
    });

  // admin-surface.ts:195-215: the biography review over the companion's profile store; no query limit, no service.
  const queryLimit = config.biographicalDepthPolicy?.full.operationClaimLimit;
  const biographicalReview = queryLimit === undefined ? null : new AdminBiographicalReviewService({ store: handles.biographicalStore, queryLimit });

  return {
    companionId,
    companionDataDir,
    ownerFiles,
    operator,
    companion,
    audit,
    memory,
    biographicalReview,
    automata,
    scheduler,
    // local-admin-contract.ts:984-993.
    sessions: new AdminSessionDataService({
      sessionStore: handles.sessionStore,
      sessionManager: companion.sessionManager,
      eventBus: companion.eventBus,
      contactStore: handles.contactStore,
      concernStore: handles.concernStore,
      memoryStore: gardenMemoryStore,
      subsystemOutputRefStore: companion.persistence.backgroundWorkStore,
      config,
    }),
    // local-admin-contract.ts:994-1002.
    contacts: new AdminContactsDataService({
      contactStore: handles.contactStore,
      memoryStore: gardenMemoryStore,
      fleetMemoryStore: handles.memoryStore,
      sessionStore: handles.sessionStore,
      relationshipScoreReader: createContactRelationshipScoreReader(handles.contactStore),
    }),
    // local-admin-contract.ts:1028-1034.
    graphProposals: createAdminGraphProposalsService({ proposalStore: handles.socialGraphProposalStore, contactStore: handles.contactStore }),
    // local-admin-contract.ts:1035-1037.
    concerns: new AdminConcernDataService(handles.concernStore, concernResolutionArcJournal),
    // local-admin-contract.ts:1048-1053, with the donor's public config (local-admin-contract.ts:392).
    identity: new AdminIdentityDataService({
      characterCard: handles.characterCard,
      config: sanitizeCoreSubstrateConfig(config) as SubstrateConfig,
      cardVersionStore: handles.cardVersionStore,
      promptStore: handles.promptStore,
    }),
    // local-admin-contract.ts:1054-1076.
    prompts: new AdminPromptsDataService({
      promptStore: handles.promptStore,
      promptRegistry: handles.promptRegistry,
      northStarStore,
      promptRuntimeLayoutStore,
      sessionStore: handles.sessionStore,
      sessionManager: companion.sessionManager,
      resolveCompanionName: companionName,
      appendAuditTimelineEntry: operatorAudit,
      companionValuesLayerProvider: () => valuesJournal.buildCompanionDerivedLayer(),
    }),
  };
}
