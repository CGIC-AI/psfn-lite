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
import { withEmbeddingUsageAccounting } from '../../faculties/memory/embedding-accounting.js';
import { resolveModelUsageCostRatesForIdentity } from '../../primitives/llm/model-budget.js';
import type { ModelUsageRecorder } from '../../shared/telemetry/model-usage.js';

// Lite cut (seam 3.1, extraction/cuts.tsv): the donor built its Postgres
// model-usage store here (createPostgresModelUsageStoreFromConfig). Lite cuts
// that store with the charge ledger and takes the host's ModelUsageRecorder in
// its place: with a recorder this is the donor's store branch (the LLMClient
// records every call, so autonomous lanes pass the accountability guard, and
// embeddings are wrapped with usage accounting); without one it is the donor's
// no-store branch, where the guard refuses every autonomous work-spec call.
// Usage budget queries were the store's too; a host may pass its own through
// llmOptions.usageBudgetQuery. A host may also pass its own provider runtime
// (for example the packages/pi adapter) and embedding provider; without them
// the donor defaults are built from config and the environment.
export interface ProviderRuntimeServices {
  runtime: ProviderRuntime;
  llmClient: LLMClient;
  embeddingProvider: EmbeddingRuntimeProvider;
}

export interface ProviderRuntimeFactoryOptions {
  config: SubstrateConfig;
  providerEnv?: NodeJS.ProcessEnv;
  llmOptions?: LLMClientRuntimeOptions;
  /** Host model-usage recorder; takes the place of the donor's model-usage store. */
  modelUsageRecorder?: ModelUsageRecorder;
  /** Host embedding provider; replaces createEmbeddingProviderFromConfig. */
  embeddingProvider?: EmbeddingRuntimeProvider;
}

export function createProviderRuntimeServices(
  options: ProviderRuntimeFactoryOptions,
): ProviderRuntimeServices {
  const providerEnv = options.providerEnv ?? process.env;
  const runtime = options.llmOptions?.runtime ?? new PiProviderRuntime(undefined, options.config);
  const modelUsageRecorder = options.modelUsageRecorder;
  const embeddingProvider = options.embeddingProvider
    ?? createEmbeddingProviderFromConfig(options.config, providerEnv);
  const llmOptions = modelUsageRecorder
    ? {
        ...(options.llmOptions ?? {}),
        runtime,
        usageRecorder: options.llmOptions?.usageRecorder ?? modelUsageRecorder,
      }
    : {
        ...(options.llmOptions ?? {}),
        runtime,
      };
  return {
    runtime,
    llmClient: new LLMClient(options.config, llmOptions),
    embeddingProvider: modelUsageRecorder
      ? withEmbeddingUsageAccounting(embeddingProvider, modelUsageRecorder, {
          estimatedRates: resolveModelUsageCostRatesForIdentity(options.config, {
            provider: embeddingProvider.kind,
            model: embeddingProvider.model,
          }),
          ...(options.config.companionId ? { companionId: options.config.companionId } : {}),
        })
      : embeddingProvider,
  };
}
