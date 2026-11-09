/**
 * The small result shape the pi adapters return (a host checks a result
 * instead of catching), and the embedding port a host implements or picks.
 */
export type AdapterError =
  | { readonly kind: 'invalid'; readonly issues: readonly string[] }
  | { readonly kind: 'unavailable'; readonly capability: string; readonly detail: string };

export type Result<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: AdapterError };

export function ok<T>(value: T): Result<T> {
  return { ok: true, value };
}

export function invalid<T = never>(...issues: readonly string[]): Result<T> {
  return { ok: false, error: { kind: 'invalid', issues } };
}

export function unavailable<T = never>(capability: string, detail: string): Result<T> {
  return { ok: false, error: { kind: 'unavailable', capability, detail } };
}

export function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Text embeddings, one vector per text in order. */
export interface EmbeddingPort {
  embed(texts: readonly string[]): Promise<Result<readonly (readonly number[])[]>>;
}
