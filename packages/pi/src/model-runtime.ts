/**
 * The model capability the host supplies to the harness: a Pi model
 * collection, the one model every companion, worker and inference call uses,
 * and the API key the host read from its environment at start. The key is
 * held in memory only and never appears in an error or a record.
 */
import { invalid, ok, type Result } from './core.ts';
import {
  builtinProviders,
  createModels,
  type Api,
  type AssistantMessage,
  type AssistantMessageEvent,
  type AuthContext,
  type AuthResult,
  type Context,
  type Model,
  type Models,
  type SimpleStreamOptions,
  type StreamFn,
} from './pi.ts';

export interface PiModelRuntime {
  readonly models: Models;
  readonly model: Model<Api>;
  /**
   * The only credential a request carries. Null sends none: a runtime from
   * `createCatalogModelRuntime` then discovers nothing either, so only a
   * keyless provider can serve it.
   */
  readonly apiKey: string | null;
  /** Output ceiling for one model call. */
  readonly maxOutputTokens: number;
}

/** Validates a host-built runtime; the model must belong to the collection. */
export function createPiModelRuntime(input: PiModelRuntime): Result<PiModelRuntime> {
  const issues: string[] = [];
  if (!Number.isInteger(input.maxOutputTokens) || input.maxOutputTokens < 1) issues.push('maxOutputTokens must be a positive integer');
  if (input.models.getProvider(input.model.provider) === undefined) issues.push(`model provider ${input.model.provider} is not in the model collection`);
  if (input.apiKey?.trim() === '') issues.push('apiKey must be non-empty when given');
  return issues.length > 0 ? invalid(...issues) : ok(Object.freeze({ ...input }));
}

/**
 * pi-ai's default auth context reads provider variables from `process.env`
 * and probes credential files (AWS profiles, Google ADC) whenever a request
 * carries no key. This context answers neither, so a credential reaches the
 * provider only as the explicit `apiKey`.
 */
export const NO_AMBIENT_CREDENTIALS: AuthContext = Object.freeze({
  env: () => Promise.resolve(undefined),
  fileExists: () => Promise.resolve(false),
});

/**
 * A runtime over one built-in pi-ai provider and model. Only that provider is
 * registered, and no ambient credential of any provider is consulted: not the
 * environment, not credential files.
 */
export function createCatalogModelRuntime(input: {
  readonly provider: string;
  readonly modelId: string;
  readonly apiKey: string | null;
  readonly maxOutputTokens: number;
}): Result<PiModelRuntime> {
  const provider = builtinProviders().find((candidate) => candidate.id === input.provider);
  if (provider === undefined) return invalid(`unknown model provider ${input.provider}`);
  const model = provider.getModels().find((candidate) => candidate.id === input.modelId);
  if (model === undefined) return invalid(`provider ${input.provider} has no model ${input.modelId}`);
  const models = createModels({ authContext: NO_AMBIENT_CREDENTIALS });
  models.setProvider(provider);
  return createPiModelRuntime({ models, model, apiKey: input.apiKey, maxOutputTokens: input.maxOutputTokens });
}

/** Per-request options: the host key (when it has one), the output ceiling and the caller's signal. */
export function requestOptions(runtime: PiModelRuntime, signal: AbortSignal | undefined): SimpleStreamOptions {
  return {
    maxTokens: runtime.maxOutputTokens,
    ...(runtime.apiKey === null ? {} : { apiKey: runtime.apiKey }),
    ...(signal === undefined ? {} : { signal }),
  };
}

/** The stream function the agent loop calls, routed through the collection so auth is applied per request. */
export function streamFnOf(runtime: PiModelRuntime): StreamFn {
  return (model, context, options) =>
    runtime.models.streamSimple(model, context, {
      ...options,
      maxTokens: runtime.maxOutputTokens,
      ...(runtime.apiKey === null ? {} : { apiKey: runtime.apiKey }),
    });
}

/** Who produced a machine reading, as core records it. */
export function producerOf(runtime: PiModelRuntime): string {
  return `pi:${runtime.model.provider}/${runtime.model.id}`;
}

/**
 * The extracted companion core's provider seam (docs/extraction.md, seam 3.1).
 *
 * The core's in-process `LLMProviderPort` is the donor's own `LLMClient`
 * (`packages/companion/src/primitives/llm/client.ts`): purpose routing over
 * the `models.json` registry, retries and fallback, the model-call gate, work
 * specs and correlation all stay donor code. It dispatches through a
 * `ProviderRuntime` (`primitives/llm/provider-runtime.ts:37-72`), the one place
 * that reaches pi-ai. This is that runtime over a host `PiModelRuntime`, so the
 * same host-built model collection and key serve Lite and the companion core.
 *
 * Structurally typed: this package never imports the companion tree (its
 * compiler settings differ); the companion composition accepts any value of
 * this shape as its `ProviderRuntime`, which its typecheck proves.
 *
 * Differences from the donor's `PiProviderRuntime`, all host-side: the
 * collection is the host's (no built-in catalogue, no `local_endpoint` or
 * `providers.json` registration, no credential vault); the only key is the
 * host's, and only for the runtime's own provider; and every request is capped
 * at the host's `maxOutputTokens`.
 */
export interface CompanionProviderRuntime {
  complete(model: Model<Api>, context: Context, options?: SimpleStreamOptions): Promise<AssistantMessage>;
  stream(model: Model<Api>, context: Context, options?: SimpleStreamOptions): AsyncIterable<AssistantMessageEvent>;
  getProviders(): readonly string[];
  getModels(provider: string): readonly Model<Api>[];
  getAuth(provider: string | Model<Api>): Promise<AuthResult | undefined>;
  resolveProviderApiKey(provider: string): string | undefined;
}

export function companionProviderRuntimeOf(runtime: PiModelRuntime): CompanionProviderRuntime {
  const withHostLimits = (options: SimpleStreamOptions | undefined): SimpleStreamOptions => ({
    ...options,
    maxTokens: Math.min(options?.maxTokens ?? runtime.maxOutputTokens, runtime.maxOutputTokens),
    ...(runtime.apiKey === null ? {} : { apiKey: runtime.apiKey }),
  });
  return {
    complete: (model, context, options) => runtime.models.completeSimple(model, context, withHostLimits(options)),
    stream: (model, context, options) => runtime.models.streamSimple(model, context, withHostLimits(options)),
    getProviders: () => runtime.models.getProviders().map((provider) => provider.id),
    getModels: (provider) => runtime.models.getModels(provider),
    getAuth: (provider) => (typeof provider === 'string' ? runtime.models.getAuth(provider) : runtime.models.getAuth(provider)),
    resolveProviderApiKey: (provider) => (provider === runtime.model.provider && runtime.apiKey !== null ? runtime.apiKey : undefined),
  };
}

/** The donor's canonical model purposes a single-model host serves (`runtime-base.ts:1413-1424`, minus `vision`, `import_processing`, `moa`). */
const SINGLE_MODEL_PURPOSES = ['chat', 'background', 'memory', 'extraction', 'summary', 'reasoning', 'longContext'] as const;

/** One `models.json` registry entry (donor `ModelRegistryEntry`, `runtime-base.ts:1554-1566`) routing those purposes to the host model. */
export interface CompanionModelRegistryEntry {
  readonly id: string;
  readonly rank: number;
  readonly identity: { readonly provider: string; readonly model: string; readonly source: { readonly type: string } };
  readonly purposes: readonly { readonly purpose: string; readonly primary: boolean }[];
  readonly capabilities: { readonly maxOutputTokens: number; readonly contextWindow: number; readonly supportsVision: boolean };
}

export function companionModelRegistryEntryOf(runtime: PiModelRuntime, id = 'host-model'): CompanionModelRegistryEntry {
  return {
    id,
    rank: 1,
    identity: { provider: runtime.model.provider, model: runtime.model.id, source: { type: runtime.model.provider } },
    purposes: SINGLE_MODEL_PURPOSES.map((purpose) => ({ purpose, primary: true })),
    capabilities: {
      maxOutputTokens: runtime.maxOutputTokens,
      contextWindow: runtime.model.contextWindow,
      supportsVision: runtime.model.input.includes('image'),
    },
  };
}
