/**
 * Explicit success/failure values for every core operation. There is no
 * silent fallback: an operation either succeeds with a value or returns one of
 * the failure variants below, and callers must branch on it.
 */

export type DenialReason =
  | 'unknown_authority'
  | 'blocked_contact'
  | 'untracked_contact'
  | 'audience_not_admitted'
  | 'background_turn'
  | 'requires_self_audience'
  | 'worker_not_permitted'
  | 'approval_required';

export type ConflictReason =
  | 'stale_revision'
  | 'turn_ownership'
  | 'turn_already_open'
  | 'turn_already_settled'
  | 'idempotency_mismatch';

/** A caller lacks the authority for this operation. */
export interface DeniedError {
  readonly kind: 'denied';
  readonly reason: DenialReason;
  readonly detail: string;
}

/**
 * The subject does not exist, or exists but is not visible to this audience.
 * The two cases are deliberately indistinguishable to the caller.
 */
export interface NotFoundError {
  readonly kind: 'not_found';
  readonly subject: string;
}

/** The operation raced another writer, owner or idempotent request. */
export interface ConflictError {
  readonly kind: 'conflict';
  readonly reason: ConflictReason;
  readonly expectedRevision?: number;
  readonly actualRevision?: number;
  readonly detail: string;
}

/** The request is malformed; nothing was attempted. */
export interface InvalidError {
  readonly kind: 'invalid';
  readonly issues: readonly string[];
}

/** A required capability, port or handler is missing or failed. */
export interface UnavailableError {
  readonly kind: 'unavailable';
  readonly capability: string;
  readonly detail: string;
}

export type CoreError =
  | DeniedError
  | NotFoundError
  | ConflictError
  | InvalidError
  | UnavailableError;

export type Result<T, E extends CoreError = CoreError> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: E };

export function ok<T>(value: T): { readonly ok: true; readonly value: T } {
  return { ok: true, value };
}

export function fail<E extends CoreError>(error: E): { readonly ok: false; readonly error: E } {
  return { ok: false, error };
}

export function denied(reason: DenialReason, detail: string): { readonly ok: false; readonly error: DeniedError } {
  return fail({ kind: 'denied', reason, detail });
}

export function invalid(...issues: readonly string[]): { readonly ok: false; readonly error: InvalidError } {
  return fail({ kind: 'invalid', issues });
}

export function unavailable(capability: string, detail: string): { readonly ok: false; readonly error: UnavailableError } {
  return fail({ kind: 'unavailable', capability, detail });
}

export function notFound(subject: string): { readonly ok: false; readonly error: NotFoundError } {
  return fail({ kind: 'not_found', subject });
}
