/**
 * Embedding capability. pi-ai has no embeddings API, so the host chooses
 * explicitly: an OpenAI-compatible `/embeddings` endpoint, or none. Without
 * one every embed call is `unavailable`; memory writes then stay `pending`
 * and the maintenance backfill embeds them once a provider is configured.
 * Nothing is ever embedded with a stand-in vector.
 */
import { isRecord, ok, unavailable, type EmbeddingPort, type Result } from './core.ts';

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
