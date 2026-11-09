/**
 * The single place the standalone app reaches the extracted companion core
 * (packages/companion): its composition root, its config loaders and default
 * helpers, and the session keyring. The boundary test lists exactly these
 * donor modules.
 */
export { startCompanionRuntime, type CompanionRuntime, type StartCompanionRuntimeOptions } from '../../../packages/companion/src/app/agent/companion-runtime.js';
export { loadInnerLifeConfig, type InnerLifeConfig } from '../../../packages/companion/src/system/config/inner-life-config.js';
export {
  DEFAULT_MOOD_CONGRUENCE_WEIGHT,
  createDefaultCompositionalPolicyConfig,
  createDefaultEmoSimProactivitySettings,
  createDefaultObserverEvalSidecarSettings,
  createDefaultSessionTailCacheSettings,
  type SubstrateConfig,
} from '../../../packages/companion/src/system/config/runtime-config-contracts.js';
export { createDefaultMemoryRetrievalPolicy } from '../../../packages/companion/src/system/config/memory-retrieval-policy.js';
export { createDefaultBiographicalDepthPolicy } from '../../../packages/companion/src/system/config/biographical-depth-policy.js';
export { createDefaultBiographicalCandidatePolicy } from '../../../packages/companion/src/system/config/biographical-candidate-policy.js';
export { createDefaultMemoryPresentationProfile } from '../../../packages/companion/src/system/config/memory-presentation-profile.js';
export { createDefaultGroupMemorySettings } from '../../../packages/companion/src/system/config/group-memory-config.js';
export { createDefaultEmotionScopingSettings } from '../../../packages/companion/src/system/config/emotion-scoping-config.js';
export { createDefaultNarrativeEmotionAppraisalSettings } from '../../../packages/companion/src/system/config/narrative-emotion-appraisal-config.js';
export { MEMORY_RETRIEVAL_BUDGET_PCT_DEFAULT, SESSION_HISTORY_BUDGET_PCT_DEFAULT } from '../../../packages/companion/src/shared/context-budget.js';
export { createSessionHmacBoundaryService } from '../../../packages/companion/src/persistence/journals/hmac-boundary.js';
export { createKeyringIntegrityProvider, type SessionIntegrityProvider } from '../../../packages/companion/src/persistence/sessions/store-primitives.js';
export type { SessionHmacKeyring } from '../../../packages/companion/src/persistence/journals/journal/types.js';
export type { JournalEntry } from '../../../packages/companion/src/core/session/types.js';
export type { ProviderRuntime } from '../../../packages/companion/src/primitives/llm/provider-runtime.js';
export {
  DEFAULT_TRANSFORMERS_EMBEDDING_CONFIG,
  resolveProjectTransformersCacheDir,
  type EmbeddingProviderKind,
  type EmbeddingRuntimeProvider,
} from '../../../packages/companion/src/faculties/memory/embedding.js';
export { envCredential } from '../../../packages/companion/src/shared/contracts/credential-contracts.js';
export type { ModelUsageEventInput, ModelUsageRecorder } from '../../../packages/companion/src/shared/telemetry/model-usage.js';
export type { SubstrateMessage, AgentResponse } from '../../../packages/companion/src/shared/contracts/runtime-base.js';
export type { TrustLevel } from '../../../packages/companion/src/shared/contracts/trust-contracts.js';
export { createTurnId } from '../../../packages/companion/src/core/turns/id.js';
export { resolveRuntimePathSnapshotFromConfig } from '../../../packages/companion/src/persistence/layout.js';
export { HostedAutomataExecutor, type HostedAutomataEvent } from '../../../packages/companion/src/faculties/subagents/host-execution.js';

/** The seed owner files the companion ships (packages/companion/config); `init` copies them into the data directory. */
export const COMPANION_SEED_DIR = new URL('../../../packages/companion/config/', import.meta.url);
