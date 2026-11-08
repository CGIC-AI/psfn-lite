/**
 * The model capability the host supplies to the harness: a Pi model
 * collection, the one model every companion, worker and inference call uses,
 * and the API key the host read from its environment at start. The key is
 * held in memory only and never appears in an error or a record.
 */
import { invalid, ok, type Result } from './core.ts';
import { builtinProviders, createModels, type Api, type AuthContext, type Model, type Models, type SimpleStreamOptions, type StreamFn } from './pi.ts';

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
