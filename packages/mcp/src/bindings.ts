/**
 * Operator-configured principal bindings: each transport credential is
 * bound to exactly one host attestation (surface, principal, room and turn
 * kind) for a channel account. A standing credential never binds a
 * companion-internal principal; a self-audience scope is reached only with
 * the per-turn credentials in internal-turns.ts. The binding configuration names where each credential lives and
 * never holds a credential itself. Core's trusted ingress then resolves the
 * attested principal through its contact authority, so the transport never
 * decides caller, contact, trust or audience on its own, and tool arguments
 * never contribute to them.
 */
import {
  deepFreeze,
  denied,
  invalid,
  isNonEmptyString,
  isRecord,
  ok,
  type CallerAuthenticatorPort,
  type HostAttestation,
  type Result,
} from './core.ts';
import type { McpCallers } from './callers.ts';
import {
  createCredentialIndex,
  credentialDigest,
  describeSource,
  readCredential,
  type CredentialEnvironment,
  type CredentialSource,
} from './credentials.ts';

/** Evidence the MCP transports hand to core ingress: the credential presented on this call. */
export interface McpCredentialEvidence {
  readonly kind: 'mcp_credential';
  readonly credential: string;
}

export interface McpPrincipalBindings extends McpCallers {
  /** Bound principal names, in configuration order. */
  readonly principals: readonly string[];
  /** The principal a presented credential is bound to, or null. */
  identify(credential: string): string | null;
  /**
   * The authenticator to build core's trusted ingress with. It accepts only
   * `McpCredentialEvidence` whose credential is bound, and returns that
   * binding's attestation; anything else is unknown authority.
   */
  readonly authenticator: CallerAuthenticatorPort;
}

const PRINCIPAL_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const BINDING_KEYS = ['principal', 'credential', 'attestation'];

/**
 * Parses the operator's binding configuration and reads every credential.
 * Startup fails on any malformed binding, a missing or weak credential, a
 * principal named twice, or one credential bound twice.
 */
export function loadPrincipalBindings(config: unknown, env: CredentialEnvironment): Result<McpPrincipalBindings> {
  if (!isRecord(config) || !Array.isArray(config['bindings']) || Object.keys(config).some((k) => k !== 'bindings')) {
    return invalid('binding configuration must be { "bindings": [...] }');
  }
  const issues: string[] = [];
  const entries: { digest: Buffer; principal: string }[] = [];
  const attestations = new Map<string, HostAttestation>();
  config['bindings'].forEach((raw: unknown, index) => {
    const at = `bindings[${index}]`;
    if (!isRecord(raw) || Object.keys(raw).some((k) => !BINDING_KEYS.includes(k))) {
      issues.push(`${at} must have only ${BINDING_KEYS.join(', ')}`);
      return;
    }
    const principal = raw['principal'];
    if (typeof principal !== 'string' || !PRINCIPAL_PATTERN.test(principal)) {
      issues.push(`${at}.principal must be 1-64 characters of [a-z0-9._-]`);
      return;
    }
    if (attestations.has(principal)) {
      issues.push(`${at}: principal ${principal} is bound twice`);
      return;
    }
    const source = parseSource(raw['credential']);
    const attestation = parseAttestation(raw['attestation']);
    if (!source.ok) issues.push(`${at}.credential: ${issuesOf(source.error)}`);
    if (!attestation.ok) issues.push(`${at}.attestation: ${issuesOf(attestation.error)}`);
    if (!source.ok || !attestation.ok) return;
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
    attestations.set(principal, attestation.value);
  });
  if (issues.length > 0) return invalid(...issues);
  if (entries.length === 0) return invalid('at least one binding is required');

  const index = createCredentialIndex(entries);
  return ok({
    principals: [...attestations.keys()],
    identify: (credential) => index.match(credential),
    authenticator: {
      authenticate(evidence) {
        if (!isRecord(evidence) || evidence['kind'] !== 'mcp_credential' || typeof evidence['credential'] !== 'string') {
          return Promise.resolve(denied('unknown_authority', 'evidence is not an MCP credential'));
        }
        const principal = index.match(evidence['credential']);
        const attestation = principal === null ? undefined : attestations.get(principal);
        return Promise.resolve(attestation === undefined ? denied('unknown_authority', 'credential is not bound to a principal') : ok(attestation));
      },
    },
  });
}

function parseSource(raw: unknown): Result<CredentialSource> {
  if (isRecord(raw) && Object.keys(raw).length === 1) {
    if (isNonEmptyString(raw['env']) && /^[A-Z_][A-Z0-9_]*$/.test(raw['env'])) return ok({ env: raw['env'] });
    if (isNonEmptyString(raw['file']) && raw['file'].startsWith('/')) return ok({ file: raw['file'] });
  }
  return invalid('must be { "env": "NAME" } or { "file": "/absolute/path" }; a credential value is never configured inline');
}

/**
 * Structural check so a bad binding stops startup. Core ingress validates
 * the attestation again on every admission and decides what it may do.
 */
function parseAttestation(raw: unknown): Result<HostAttestation> {
  if (!isRecord(raw)) return invalid('must be an object');
  const issues: string[] = [];
  if (!isNonEmptyString(raw['surface'])) issues.push('surface must be a non-empty string');
  if (raw['turnKind'] !== 'foreground' && raw['turnKind'] !== 'background') issues.push('turnKind must be foreground or background');
  const principal = raw['principal'];
  if (isRecord(principal) && principal['kind'] === 'companion_internal') {
    issues.push(
      'principal.kind companion_internal cannot be bound to a standing credential: it admits all companion-private state, so it is reached only with the credential the host mints for one internal turn',
    );
  } else if (!isRecord(principal) || principal['kind'] !== 'channel_account') {
    issues.push('principal.kind must be channel_account');
  } else {
    const identity = principal['identity'];
    if (!isRecord(identity) || !isNonEmptyString(identity['channelKind']) || !isNonEmptyString(identity['externalId'])) {
      issues.push('principal.identity must name channelKind and externalId');
    }
  }
  const room = raw['room'];
  if (!isRecord(room) || !['self', 'direct', 'group'].includes(String(room['kind']))) issues.push('room.kind must be self, direct or group');
  else if (room['kind'] !== 'self' && !isNonEmptyString(room['channelId'])) issues.push('room.channelId must be named');
  return issues.length > 0 ? invalid(...issues) : ok(deepFreeze(structuredClone(raw)) as unknown as HostAttestation);
}

function issuesOf(error: { readonly kind: string; readonly issues?: readonly string[] }): string {
  return error.issues?.join('; ') ?? error.kind;
}
