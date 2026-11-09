/**
 * The native Pi companion harness. It runs conversation turns, companion-
 * internal turns and bounded workers through core's lifecycle contracts and
 * implements core's host ports over Pi (`@earendil-works/pi-agent-core`'s
 * public agent loop and `@earendil-works/pi-ai` models). Core never imports
 * this package; hosts compose it with core and the storage adapters.
 */
export {
  createCompanionHarness,
  type CompanionHarness,
  type CompanionHarnessDeps,
  type ConversationRequest,
  type HarnessLimits,
  type PostTurnReport,
  type ReplyDeliveryPort,
  type TurnReport,
} from './companion-harness.ts';
export { assembleTurnContext, type ContextLimits, type TurnContext, type TurnContextSources } from './context.ts';
export {
  companionEmbeddingProviderOf,
  createDisabledEmbeddings,
  createOpenAiCompatibleEmbeddings,
  type CompanionEmbeddingProvider,
  type OpenAiCompatibleEmbeddingOptions,
} from './embeddings.ts';
export { createPiAffectEstimator, createPiModelPort } from './inference.ts';
export { runModelLoop, type LoopOutcome, type LoopRequest, type LoopUsage, type NextCallGate } from './loop.ts';
export {
  companionModelRegistryEntryOf,
  companionProviderRuntimeOf,
  createCatalogModelRuntime,
  createPiModelRuntime,
  producerOf,
  type CompanionModelRegistryEntry,
  type CompanionProviderRuntime,
  type PiModelRuntime,
} from './model-runtime.ts';
export { TurnInterruption, type InterruptedBy, type SettledStatus } from './settlement.ts';
export { ToolRefusal, describeError, piTools, type ActionFilter, type ToolInvoker } from './tools.ts';
export { createPiWorkerHost, effectKey, type PiWorkerHost, type WorkerDiagnostic, type WorkerHostOptions } from './worker-host.ts';
