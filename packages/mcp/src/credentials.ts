/**
 * Transport credentials. A credential is read at run time from an
 * environment variable or a private file, never from tracked configuration,
 * and is kept only as a SHA-256 digest. Matching hashes the candidate and
 * compares it with every known digest in constant time, without stopping at
 * the first match, so neither timing nor length reveals which credential (if
 * any) was close. No error message ever contains a credential.
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { invalid, ok, type Result } from './core.ts';

export const MIN_CREDENTIAL_LENGTH = 32;
const MAX_CREDENTIAL_LENGTH = 4096;
const CREDENTIAL_PATTERN = /^[\x21-\x7e]+$/;
const BEARER_PATTERN = /^Bearer ([\x21-\x7e]+)$/i;

/** Where an operator keeps a credential. The configuration names the place, never the value. */
export type CredentialSource = { readonly env: string } | { readonly file: string };

/** Environment the credentials are read from; the process environment in production. */
export type CredentialEnvironment = Readonly<Record<string, string | undefined>>;

export function describeSource(source: CredentialSource): string {
  return 'env' in source ? `environment variable ${source.env}` : `file ${source.file}`;
}

/** Reads one credential. A file must be a regular file readable only by its owner. */
export function readCredential(source: CredentialSource, env: CredentialEnvironment): Result<string> {
  const where = describeSource(source);
  let raw: string;
  if ('env' in source) {
    const value = env[source.env];
    if (value === undefined) return invalid(`${where} is not set`);
    raw = value;
  } else {
    try {
      const stat = statSync(source.file);
      if (!stat.isFile()) return invalid(`${where} is not a regular file`);
      if ((stat.mode & 0o077) !== 0) return invalid(`${where} must not be readable by group or others`);
      raw = readFileSync(source.file, 'utf8').replace(/\r?\n$/, '');
    } catch (error) {
      const code = error instanceof Error && 'code' in error && typeof error.code === 'string' ? error.code : 'unreadable';
      return invalid(`${where} could not be read (${code})`);
    }
  }
  if (raw.length < MIN_CREDENTIAL_LENGTH || raw.length > MAX_CREDENTIAL_LENGTH || !CREDENTIAL_PATTERN.test(raw)) {
    return invalid(`${where} must hold ${MIN_CREDENTIAL_LENGTH}-${MAX_CREDENTIAL_LENGTH} printable characters without whitespace`);
  }
  return ok(raw);
}

export function credentialDigest(credential: string): Buffer {
  return createHash('sha256').update(credential, 'utf8').digest();
}

/** The credential carried by an `Authorization: Bearer` header, or null. */
export function bearerCredential(header: string | readonly string[] | undefined): string | null {
  if (typeof header !== 'string') return null;
  const match = BEARER_PATTERN.exec(header.trim());
  return match?.[1] ?? null;
}

/** Index of credential digests to the principal each one is bound to. */
export interface CredentialIndex<P> {
  /** The bound principal, or null. Every digest is compared, whatever the outcome. */
  match(candidate: string): P | null;
}

export function createCredentialIndex<P>(entries: readonly { readonly digest: Buffer; readonly principal: P }[]): CredentialIndex<P> {
  const frozen = entries.map((e) => ({ digest: Buffer.from(e.digest), principal: e.principal }));
  return {
    match(candidate) {
      const probe = credentialDigest(candidate);
      let found: P | null = null;
      for (const entry of frozen) {
        if (timingSafeEqual(probe, entry.digest)) found = entry.principal;
      }
      return found;
    },
  };
}
