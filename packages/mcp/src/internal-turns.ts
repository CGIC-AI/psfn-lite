/**
 * Turn-scoped credentials for companion-internal turns. A self-audience
 * scope admits every sensitivity and every conversation's sources, so no
 * static credential ever reaches it: operator bindings refuse
 * `companion_internal` principals. Instead the host's `InternalTurnPort`
 * mints one random credential when core asks it to run an internal turn,
 * hands that credential to the harness that runs the turn, and revokes it
 * when the run settles (completed, failed or thrown). A credential also
 * expires after `ttlMs` even if its turn never settles, and at most
 * `maxOpen` turns hold one at a time; a further turn is refused rather than
 * evicting a live one. The attestation comes from core's own request
 * (the turn's purpose and the surface of the scope core admitted), never
 * from the host or the harness. Core ingress still admits every call made with it.
 *
 * Reuses the donor gateway's permit pattern (opaque, minted per use, TTL,
 * bounded) from src/boundary/gateway/mcp/invocation-authority.ts.
 */
import { randomBytes, timingSafeEqual } from 'node:crypto';
import {
  deepFreeze,
  denied,
  invalid,
  isRecord,
  isTrustedTurnScope,
  ok,
  unavailable,
  type CallerAuthenticatorPort,
  type HostAttestation,
  type InternalTurnPort,
  type InternalTurnRequest,
  type InternalTurnResult,
  type Result,
} from './core.ts';
import { credentialDigest } from './credentials.ts';

export interface McpInternalTurnOptions {
  /** Longest a minted credential lives, in milliseconds, even if its turn has not settled. */
  readonly ttlMs: number;
  /** Most internal turns that may hold a credential at once. */
  readonly maxOpen: number;
  /** Milliseconds since the epoch; `Date.now` in production. */
  readonly now: () => number;
}

/**
 * Runs the harness for one internal turn. The credential is for the
 * harness's MCP client connection (for example its bearer header); it is
 * never placed in the prompt or in any tool argument.
 */
export type InternalTurnLauncher = (request: InternalTurnRequest, credential: string) => Promise<Result<InternalTurnResult>>;

export interface McpInternalTurns {
  /** `internal:<purpose>` for a live turn credential, or null. */
  identify(credential: string): string | null;
  /** Accepts only a live turn credential; anything else is unknown authority. */
  readonly authenticator: CallerAuthenticatorPort;
  /** The host's `InternalTurnPort`: every run mints, launches and revokes. */
  createTurnPort(launch: InternalTurnLauncher): InternalTurnPort;
}

interface OpenTurn {
  readonly digest: Buffer;
  readonly purpose: InternalTurnRequest['purpose'];
  readonly attestation: HostAttestation;
  readonly expiresAt: number;
}

const CREDENTIAL_BYTES = 32;

export function createMcpInternalTurns(options: McpInternalTurnOptions): Result<McpInternalTurns> {
  const issues: string[] = [];
  if (!Number.isSafeInteger(options.ttlMs) || options.ttlMs < 1) issues.push('ttlMs must be a positive integer');
  if (!Number.isSafeInteger(options.maxOpen) || options.maxOpen < 1) issues.push('maxOpen must be a positive integer');
  if (typeof options.now !== 'function') issues.push('now must be a clock function');
  if (issues.length > 0) return invalid(...issues);
  const open = new Set<OpenTurn>();

  const prune = () => {
    const now = options.now();
    for (const turn of open) if (turn.expiresAt <= now) open.delete(turn);
  };
  /** Compares the candidate with every live credential in constant time. */
  const match = (candidate: string): OpenTurn | null => {
    prune();
    const probe = credentialDigest(candidate);
    let found: OpenTurn | null = null;
    for (const turn of open) if (timingSafeEqual(probe, turn.digest)) found = turn;
    return found;
  };

  const run = async (launch: InternalTurnLauncher, request: InternalTurnRequest): Promise<Result<InternalTurnResult>> => {
    const scope = request.scope;
    // Core may run a turn of one purpose under a scope admitted for another (a scheduler tick's
    // scope runs scheduled prompts); the credential carries the purpose of the turn itself.
    if (!isTrustedTurnScope(scope) || scope.caller.kind !== 'companion_internal' || scope.audience.kind !== 'self') {
      return denied('unknown_authority', 'a turn credential is minted only for an ingress-admitted companion-internal self scope');
    }
    prune();
    if (open.size >= options.maxOpen) return unavailable('internal_turn_credentials', 'too many internal turns hold a credential');
    const credential = randomBytes(CREDENTIAL_BYTES).toString('base64url');
    const attestation: HostAttestation = {
      surface: scope.surface,
      principal: { kind: 'companion_internal', purpose: request.purpose },
      room: { kind: 'self' },
      turnKind: 'background',
    };
    const turn: OpenTurn = {
      digest: credentialDigest(credential),
      purpose: request.purpose,
      attestation: deepFreeze(attestation),
      expiresAt: options.now() + options.ttlMs,
    };
    open.add(turn);
    try {
      return await launch(request, credential);
    } finally {
      open.delete(turn);
    }
  };

  return ok({
    identify: (credential) => {
      const turn = match(credential);
      return turn === null ? null : `internal:${turn.purpose}`;
    },
    authenticator: {
      authenticate(evidence) {
        if (!isRecord(evidence) || evidence['kind'] !== 'mcp_credential' || typeof evidence['credential'] !== 'string') {
          return Promise.resolve(denied('unknown_authority', 'evidence is not an MCP credential'));
        }
        const turn = match(evidence['credential']);
        return Promise.resolve(turn === null ? denied('unknown_authority', 'credential belongs to no open internal turn') : ok(turn.attestation));
      },
    },
    createTurnPort: (launch) => ({ run: (request) => run(launch, request) }),
  });
}
