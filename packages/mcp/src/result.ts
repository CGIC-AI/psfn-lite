/**
 * The small result and error shape the host adapters share (MCP transport,
 * lifecycle bridge). A failure is one of five kinds; what a client sees of it
 * is `publicError`, which never carries driver or storage text.
 */
export type HostError =
  | { readonly kind: 'denied'; readonly reason: string; readonly detail: string }
  | { readonly kind: 'not_found'; readonly subject: string }
  | { readonly kind: 'conflict'; readonly reason: string; readonly detail: string }
  | { readonly kind: 'invalid'; readonly issues: readonly string[] }
  | { readonly kind: 'unavailable'; readonly capability: string; readonly detail: string };

export type Result<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: HostError };

export function ok<T>(value: T): Result<T> {
  return { ok: true, value };
}

export function invalid<T = never>(...issues: readonly string[]): Result<T> {
  return { ok: false, error: { kind: 'invalid', issues } };
}

export function denied<T = never>(reason: string, detail: string): Result<T> {
  return { ok: false, error: { kind: 'denied', reason, detail } };
}

export function notFound<T = never>(subject: string): Result<T> {
  return { ok: false, error: { kind: 'not_found', subject } };
}

export function conflict<T = never>(reason: string, detail: string): Result<T> {
  return { ok: false, error: { kind: 'conflict', reason, detail } };
}

export function unavailable<T = never>(capability: string, detail: string): Result<T> {
  return { ok: false, error: { kind: 'unavailable', capability, detail } };
}

export function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/**
 * What a client sees of a failure. Denials, conflicts, invalid input and
 * misses keep their own wording. An `unavailable` detail can carry storage or
 * driver text, so it is replaced; the operator sees the original.
 */
export function publicError(error: HostError): Readonly<Record<string, unknown>> {
  switch (error.kind) {
    case 'denied':
      return { kind: 'denied', reason: error.reason, detail: error.detail };
    case 'not_found':
      return { kind: 'not_found', subject: error.subject };
    case 'conflict':
      return { kind: 'conflict', reason: error.reason, detail: error.detail };
    case 'invalid':
      return { kind: 'invalid', issues: error.issues };
    case 'unavailable':
      return { kind: 'unavailable', capability: error.capability, detail: 'the capability is unavailable; try again later' };
  }
}
