/**
 * Operator-configured principal bindings: each transport credential is bound
 * to exactly one principal, and each principal to one contact the host
 * provisions in the companion's contact store. The binding configuration
 * names where each credential lives and never holds a credential itself.
 * Identity therefore comes from the transport credential only: no tool
 * argument or request field names a caller, contact or audience.
 */
import {
  createCredentialIndex,
  credentialDigest,
  describeSource,
  readCredential,
  type CredentialEnvironment,
  type CredentialSource,
} from './credentials.ts';
import { invalid, isNonEmptyString, isRecord, ok, type Result } from './result.ts';

export interface PrincipalBinding {
  readonly principal: string;
  /** The host's contact key for the principal (`operator`, or a key of the host's contact list). */
  readonly contact: string;
}

export interface McpPrincipalBindings {
  /** The bindings, in configuration order. */
  readonly bindings: readonly PrincipalBinding[];
  /** The principal a presented credential is bound to, or null. Every digest is compared, whatever the outcome. */
  identify(credential: string): string | null;
  contactOf(principal: string): string | null;
}

const NAME_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const BINDING_KEYS = ['principal', 'credential', 'contact'];

/**
 * Parses the operator's binding list and reads every credential. Startup
 * fails on any malformed binding, a missing or weak credential, a principal
 * named twice, or one credential bound twice.
 */
export function loadPrincipalBindings(config: unknown, env: CredentialEnvironment): Result<McpPrincipalBindings> {
  if (!Array.isArray(config)) return invalid('bindings must be a list');
  const issues: string[] = [];
  const entries: { digest: Buffer; principal: string }[] = [];
  const bindings: PrincipalBinding[] = [];
  config.forEach((raw: unknown, index) => {
    const at = `bindings[${index}]`;
    if (!isRecord(raw) || Object.keys(raw).some((k) => !BINDING_KEYS.includes(k))) {
      issues.push(`${at} must have only ${BINDING_KEYS.join(', ')}`);
      return;
    }
    const principal = raw['principal'];
    if (typeof principal !== 'string' || !NAME_PATTERN.test(principal)) {
      issues.push(`${at}.principal must be 1-64 characters of [a-z0-9._-]`);
      return;
    }
    if (bindings.some((b) => b.principal === principal)) {
      issues.push(`${at}: principal ${principal} is bound twice`);
      return;
    }
    const contact = raw['contact'];
    if (typeof contact !== 'string' || !NAME_PATTERN.test(contact)) {
      issues.push(`${at}.contact must name a configured contact key`);
      return;
    }
    const source = parseSource(raw['credential']);
    if (!source.ok) {
      issues.push(`${at}.credential: ${issuesOf(source.error)}`);
      return;
    }
    const credential = readCredential(source.value, env);
    if (!credential.ok) {
      issues.push(`${at}: ${issuesOf(credential.error)}`);
      return;
    }
    const digest = credentialDigest(credential.value);
    if (entries.some((e) => e.digest.equals(digest))) {
      issues.push(`${at}: the credential in ${describeSource(source.value)} is already bound to another principal`);
      return;
    }
    entries.push({ digest, principal });
    bindings.push(Object.freeze({ principal, contact }));
  });
  if (issues.length > 0) return invalid(...issues);
  if (entries.length === 0) return invalid('at least one binding is required');
  const index = createCredentialIndex(entries);
  const frozen = Object.freeze([...bindings]);
  return ok({
    bindings: frozen,
    identify: (credential) => index.match(credential),
    contactOf: (principal) => frozen.find((b) => b.principal === principal)?.contact ?? null,
  });
}

function parseSource(raw: unknown): Result<CredentialSource> {
  if (isRecord(raw) && Object.keys(raw).length === 1) {
    if (isNonEmptyString(raw['env']) && /^[A-Z_][A-Z0-9_]*$/.test(raw['env'])) return ok({ env: raw['env'] });
    if (isNonEmptyString(raw['file']) && raw['file'].startsWith('/')) return ok({ file: raw['file'] });
  }
  return invalid('must be { "env": "NAME" } or { "file": "/absolute/path" }; a credential value is never configured inline');
}

function issuesOf(error: { readonly kind: string; readonly issues?: readonly string[] }): string {
  return error.issues?.join('; ') ?? error.kind;
}
