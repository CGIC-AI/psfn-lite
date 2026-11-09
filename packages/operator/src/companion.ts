/**
 * The single place the light Garden reaches the extracted companion core
 * (packages/companion): the donor Garden's route builders and services
 * (re-vendored in seam S8), the route authorization catalogue, the stores
 * the donor's Garden composition built over the companion's data directory,
 * and the owner-file loaders. The boundary test lists exactly these modules.
 */
export type { CompanionRuntime, CompanionGardenHandles } from '../../companion/src/app/agent/companion-runtime.js';

// Route builders, in the donor's buildAdminApiRoutes order (api-routes.ts:581-1136).
export { buildAdminAutomataRoutes } from '../../companion/src/operator/garden/routes/automata-routes.js';
export { buildAdminMemoryRoutes } from '../../companion/src/operator/garden/api-routes-memory.js';
export { buildAdminBiographicalReviewRoutes } from '../../companion/src/operator/garden/api-routes-biographical-review.js';
export { buildAdminSessionRoutes } from '../../companion/src/operator/garden/routes/session-routes.js';
export { buildAdminContactRoutes } from '../../companion/src/operator/garden/routes/contact-routes.js';
export { buildAdminGraphProposalRoutes } from '../../companion/src/operator/garden/api-routes-graph-proposals.js';
export { buildAdminConcernRoutes } from '../../companion/src/operator/garden/routes/concern-routes.js';
export { buildAdminIdentityRoutes } from '../../companion/src/operator/garden/routes/identity-routes.js';
export { buildAdminPromptRoutes } from '../../companion/src/operator/garden/routes/prompt-routes.js';
export { buildAdminSchedulerRoutes } from '../../companion/src/operator/garden/routes/scheduler-routes.js';
export type { AdminApiRoute, AdminBodyReader } from '../../companion/src/operator/garden/routes/types.js';

// Request handling: the catalogue, the standalone request context, the response primitives.
export { assertGardenRouteDeclarationsCovered, compileGardenRouteDeclarations, type AuthorizedGardenRoute } from '../../companion/src/boundary/fleet-auth/garden-route-capabilities.js';
export { createStandaloneGardenRequestContext, type GardenRequestContext } from '../../companion/src/operator/garden/garden-request-context.js';
export { gardenRequestCompanionScopeDenial } from '../../companion/src/operator/garden/garden-companion-scope.js';
export { bindRequestForResponse, readBodyWithLimit, sendJson } from '../../companion/src/channels/backplane/http/primitives.js';
export type {
  AdminAuditActionType,
  AdminAuditActor,
  AdminAuditDecision,
  AdminAuditHistoryEntry,
  AdminAuditRequestAttribution,
} from '../../companion/src/operator/garden/types.js';

// The donor Garden services.
export { AdminMemoryDataService } from '../../companion/src/operator/garden/services/memory-service.js';
export { AdminSessionDataService } from '../../companion/src/operator/garden/services/session-service.js';
export { AdminContactsDataService } from '../../companion/src/operator/garden/services/contacts-service.js';
export { createAdminGraphProposalsService } from '../../companion/src/operator/garden/services/graph-proposals-service.js';
export { AdminConcernDataService } from '../../companion/src/operator/garden/services/concern-service.js';
export { AdminIdentityDataService } from '../../companion/src/operator/garden/services/identity-service.js';
export { AdminPromptsDataService } from '../../companion/src/operator/garden/services/prompts-service.js';
export { AdminSchedulerService } from '../../companion/src/operator/garden/services/scheduler-service.js';
export { AdminAutomataDataService } from '../../companion/src/operator/garden/services/automata-service.js';
export { PostgresAdminAutomataBusReadAdapter } from '../../companion/src/operator/garden/services/automata-bus-read-adapter.js';
export { AdminBiographicalReviewService } from '../../companion/src/operator/garden/services/biographical-review-service.js';

// Stores the donor's Garden composition opened over the companion data directory (local-admin-contract.ts:393-500).
export { createSubjectAuthorizedMemoryStore } from '../../companion/src/faculties/memory/subject-authorized-store.js';
export { createCompanionRoomMembershipAuthority } from '../../companion/src/faculties/memory/companion-provenance.js';
export { createContactRelationshipScoreReader } from '../../companion/src/core/contacts/trust-drift-signals.js';
export { ValuesJournalStore } from '../../companion/src/faculties/values/store.js';
export { NorthStarStore } from '../../companion/src/faculties/north-star/store.js';
export { ReflectionJournalStore } from '../../companion/src/persistence/journals/reflection-journal.js';
export {
  resolveConcernResolutionArcJournalPath,
  resolveLegacyValuesJournalPath,
  resolveNorthStarPath,
  resolveValuesJournalPath,
} from '../../companion/src/persistence/layout.js';
export { PromptRuntimeLayoutStore, resolvePromptRuntimeLayoutPath } from '../../companion/src/core/identity/prompt-runtime.js';
export { invalidateCachedPromptRuntimeLayoutStore } from '../../companion/src/core/identity/prompt-runtime-store-cache.js';
export { resolveCompanionNameFromConfig } from '../../companion/src/core/identity/companion-runtime.js';
export { sanitizeCoreSubstrateConfig, type SubstrateConfig } from '../../companion/src/system/config/runtime-config-contracts.js';
export { resolveMorningWakeSnapshot } from '../../companion/src/core/scheduler/temporal-wakeup.js';
export { appendJsonLine } from '../../companion/src/shared/utils/jsonl.js';
export type { MemoryDeletionProposal } from '../../companion/src/faculties/memory/deletion-proposals.js';

// The owner files Settings shows and writes (decision b), with the donor's own loaders and savers.
export { loadCapabilityTierConfig, saveCapabilityTierConfig } from '../../companion/src/system/config/capability-tier-config.js';
export { loadSchedulerConfig, saveSchedulerConfig } from '../../companion/src/system/config/scheduler-config.js';
