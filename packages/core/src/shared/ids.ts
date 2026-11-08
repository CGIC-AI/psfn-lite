import { invalid, ok, type Result } from './result.ts';

declare const idBrand: unique symbol;

/** A string identifier that cannot be confused with another kind of id. */
export type Id<Kind extends string> = string & { readonly [idBrand]: Kind };

export type CompanionId = Id<'companion'>;
export type ContactId = Id<'contact'>;
export type ChannelId = Id<'channel'>;
export type SessionId = Id<'session'>;
export type TurnId = Id<'turn'>;
export type ActivityId = Id<'activity'>;
export type WorkerRunId = Id<'worker_run'>;
export type IdempotencyKey = Id<'idempotency_key'>;
/** A harness or transport surface, for example a native harness or a tool transport. */
export type SurfaceId = Id<'surface'>;

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,199}$/;

/**
 * Validates an untrusted string as an id of the given kind. Ids are opaque,
 * bounded and restricted to a conservative character set.
 */
export function parseId<Kind extends string>(kind: Kind, raw: unknown): Result<Id<Kind>> {
  if (typeof raw !== 'string' || !ID_PATTERN.test(raw)) {
    return invalid(`${kind} id must be 1-200 characters of [A-Za-z0-9:._-] starting alphanumeric`);
  }
  return ok(raw as Id<Kind>);
}

/** Source of fresh identifiers, supplied by the host composition. */
export interface IdSource {
  next<Kind extends string>(kind: Kind): Id<Kind>;
}
