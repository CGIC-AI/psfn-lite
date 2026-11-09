/**
 * The Pi model and embedding adapters for the extracted companion core. A
 * host builds one Pi model runtime (a pi-ai model collection, one model and
 * the host's key) and hands the core its provider runtime and its
 * `models.json` registry entry; it picks an embedding port and hands the core
 * its embedding provider. The companion core never imports this package.
 */
export {
  companionEmbeddingProviderOf,
  createDisabledEmbeddings,
  createOpenAiCompatibleEmbeddings,
  type CompanionEmbeddingProvider,
  type OpenAiCompatibleEmbeddingOptions,
} from './embeddings.ts';
export {
  NO_AMBIENT_CREDENTIALS,
  companionModelRegistryEntryOf,
  companionProviderRuntimeOf,
  createCatalogModelRuntime,
  createPiModelRuntime,
  type CompanionModelRegistryEntry,
  type CompanionProviderRuntime,
  type PiModelRuntime,
} from './model-runtime.ts';
export { invalid, isRecord, ok, unavailable, type AdapterError, type EmbeddingPort, type Result } from './result.ts';
