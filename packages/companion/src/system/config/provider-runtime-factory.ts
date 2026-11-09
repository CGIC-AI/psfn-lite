import type { SubstrateConfig } from './runtime-config-contracts.js';
import { LLMClient, type LLMClientRuntimeOptions } from '../../primitives/llm/client.js';
import {
  PiProviderRuntime,
  type ProviderRuntime,
} from '../../primitives/llm/provider-runtime.js';
import {
  createEmbeddingProviderFromConfig,
  type EmbeddingRuntimeProvider,
} from '../../faculties/memory/embedding.js';

// Lite cut (seam 3.1, extraction/cuts.tsv): the Postgres model-usage store and
// the embedding usage accounting are cut with the charge ledger, so this is the
// donor's no-usage-store branch. A host may pass its own provider runtime (for
// example the packages/pi adapter) and embedding provider; without them the
// donor defaults are built from config and the environment.
export interface ProviderRuntimeServices {
  runtime: ProviderRuntime;
  llmClient: LLMClient;
  embeddingProvider: EmbeddingRuntimeProvider;
}

export interface ProviderRuntimeFactoryOptions {
  config: SubstrateConfig;
  providerEnv?: NodeJS.ProcessEnv;
  llmOptions?: LLMClientRuntimeOptions;
  /** Host embedding provider; replaces createEmbeddingProviderFromConfig. */
  embeddingProvider?: EmbeddingRuntimeProvider;
}

export function createProviderRuntimeServices(
  options: ProviderRuntimeFactoryOptions,
): ProviderRuntimeServices {
  const providerEnv = options.providerEnv ?? process.env;
  const runtime = options.llmOptions?.runtime ?? new PiProviderRuntime(undefined, options.config);
  const embeddingProvider = options.embeddingProvider
    ?? createEmbeddingProviderFromConfig(options.config, providerEnv);
  const llmOptions = {
    ...(options.llmOptions ?? {}),
    runtime,
  };
  return {
    runtime,
    llmClient: new LLMClient(options.config, llmOptions),
    embeddingProvider,
  };
}
