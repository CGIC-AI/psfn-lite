/**
 * Embedding seam for a host that supplies its own embedding port. pi-ai has
 * no embeddings API; the configured embedding providers are the donor's own
 * (transformers, ollama, api: `faculties/memory/embedding.ts`
 * createEmbeddingProviderFromConfig), which the companion core builds itself
 * from its substrate config. A host that serves vectors some other way (a
 * test's deterministic vectors, an embedding host) hands the core its port
 * through this adapter instead. Nothing is ever embedded with a stand-in
 * vector: a failed port answer fails the call.
 */
import type { EmbeddingPort } from './result.ts';

/**
 * The extracted companion core's embedding seam (docs/extraction.md, seam 3.1):
 * the donor `EmbeddingRuntimeProvider` (`faculties/memory/embedding.ts:60-63`
 * over `shared/contracts/embedding-provider.ts:27-31`) over a Lite
 * `EmbeddingPort`. The donor contract throws instead of returning a result:
 * an `unavailable` answer becomes an `Error`, as the donor's own API provider
 * fails a request. `kind` is the donor's `'api'` (the core's embedding usage
 * accounting records it); the core's embedding provenance comes from its
 * substrate config, which names the port's model and dimensions.
 * Structurally typed for the same reason as `companionProviderRuntimeOf`.
 */
export interface CompanionEmbeddingProvider {
  readonly kind: 'api';
  readonly model: string;
  readonly dims: number;
  embed(text: string, options?: { readonly signal?: AbortSignal }): Promise<Float32Array>;
  embedBatch(texts: string[], options?: { readonly signal?: AbortSignal }): Promise<Float32Array[]>;
}

export function companionEmbeddingProviderOf(port: EmbeddingPort, identity: { readonly model: string; readonly dimensions: number }): CompanionEmbeddingProvider {
  const embedBatch = async (texts: string[], options?: { readonly signal?: AbortSignal }): Promise<Float32Array[]> => {
    options?.signal?.throwIfAborted();
    const result = await port.embed(texts);
    options?.signal?.throwIfAborted();
    if (!result.ok) {
      const detail = result.error.kind === 'unavailable' ? result.error.detail : result.error.issues.join('; ');
      throw new Error(`Embedding provider unavailable: ${detail}`);
    }
    return result.value.map((vector, index) => {
      if (vector.length !== identity.dimensions) {
        throw new Error(`Embedding ${index} has ${vector.length} dimensions, expected ${identity.dimensions}`);
      }
      return Float32Array.from(vector);
    });
  };
  return {
    kind: 'api',
    model: identity.model,
    dims: identity.dimensions,
    embed: async (text, options) => {
      const [vector] = await embedBatch([text], options);
      if (vector === undefined) throw new Error('Embedding provider returned no vector');
      return vector;
    },
    embedBatch,
  };
}
