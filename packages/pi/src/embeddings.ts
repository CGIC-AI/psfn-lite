/**
 * Embedding capability. pi-ai has no embeddings API, so the host chooses
 * explicitly: an OpenAI-compatible `/embeddings` endpoint, or none. The
 * extracted companion core needs one: the donor refused to start without an
 * embedding provider (`faculties/memory/embedding.ts` resolveEmbeddingProviderKind
 * throws "embeddingProvider is required"), its startup warmup fails closed on
 * any embed error (`warmupEmbeddingProvider`, docs/memory/l2-typed.md
 * "Fail-closed warmup"), and every memory write embeds or throws
 * (`faculties/memory/writer.ts`); there is no pending-embedding path. So the
 * disabled port answers every embed call `unavailable`, and a host that
 * configures no provider must supply its own port (the standalone refuses to
 * start otherwise). Nothing is ever embedded with a stand-in vector.
 */
import { isRecord, ok, unavailable, type EmbeddingPort, type Result } from './result.ts';

const CAPABILITY = 'embeddings';

export function createDisabledEmbeddings(): EmbeddingPort {
  return { embed: () => Promise.resolve(unavailable(CAPABILITY, 'no embedding provider is configured')) };
}

export interface OpenAiCompatibleEmbeddingOptions {
  /** Base URL of the API, for example `https://api.openai.com/v1`. */
  readonly baseUrl: string;
  readonly model: string;
  readonly dimensions: number;
  /** Read by the host from its environment; never stored. */
  readonly apiKey: string;
  readonly timeoutMs: number;
  readonly fetch?: typeof globalThis.fetch;
}

export function createOpenAiCompatibleEmbeddings(options: OpenAiCompatibleEmbeddingOptions): EmbeddingPort {
  const doFetch = options.fetch ?? globalThis.fetch;
  const url = `${options.baseUrl.replace(/\/+$/, '')}/embeddings`;
  return {
    async embed(texts) {
      if (texts.length === 0) return ok([]);
      let response: Response;
      try {
        response = await doFetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${options.apiKey}` },
          body: JSON.stringify({ model: options.model, input: texts, dimensions: options.dimensions }),
          signal: AbortSignal.timeout(options.timeoutMs),
        });
      } catch (error) {
        return unavailable(CAPABILITY, `request failed: ${error instanceof Error ? error.name : 'error'}`);
      }
      if (!response.ok) return unavailable(CAPABILITY, `provider answered ${response.status}`);
      let body: unknown;
      try {
        body = await response.json();
      } catch {
        return unavailable(CAPABILITY, 'provider answer was not JSON');
      }
      return parseVectors(body, texts.length, options.dimensions);
    },
  };
}

function parseVectors(body: unknown, count: number, dimensions: number): Result<readonly (readonly number[])[]> {
  const data = isRecord(body) ? body['data'] : undefined;
  if (!Array.isArray(data) || data.length !== count) return unavailable(CAPABILITY, `expected ${count} embeddings`);
  const vectors: (readonly number[])[] = new Array<readonly number[]>(count);
  for (const item of data as unknown[]) {
    if (!isRecord(item)) return unavailable(CAPABILITY, 'embedding item is not an object');
    const index = item['index'];
    const vector = item['embedding'];
    if (typeof index !== 'number' || !Number.isInteger(index) || index < 0 || index >= count || vectors[index] !== undefined) {
      return unavailable(CAPABILITY, 'embedding index is missing or repeated');
    }
    if (!Array.isArray(vector) || vector.length !== dimensions || !vector.every((n) => typeof n === 'number' && Number.isFinite(n))) {
      return unavailable(CAPABILITY, `embedding ${index} does not have ${dimensions} finite dimensions`);
    }
    vectors[index] = vector as number[];
  }
  return ok(vectors);
}

/**
 * The extracted companion core's embedding seam (docs/extraction.md, seam 3.1):
 * the donor `EmbeddingRuntimeProvider` (`faculties/memory/embedding.ts:60-63`
 * over `shared/contracts/embedding-provider.ts:27-31`) over a Lite
 * `EmbeddingPort`. The donor contract throws instead of returning a result:
 * an `unavailable` answer becomes an `Error`, as the donor's own API provider
 * fails a request. `kind` is the donor's `'api'`, so the core's embedding
 * provenance reads `embeddingApiModel` / `embeddingApiDims` from its config.
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
