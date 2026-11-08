import type {
  SessionArchivePort,
  SessionCatalogPort,
  TurnLedgerPort,
  TurnOutcome,
  TurnOwner,
  TurnRecord,
  TurnTrigger,
} from '../sessions/index.ts';
import {
  conflict,
  denied,
  fail,
  invalid,
  isNonEmptyString,
  notFound,
  ok,
  sameAudience,
  type Clock,
  type IdSource,
  type IdempotencyKey,
  type InternalOrigin,
  type Result,
  type SessionId,
} from '../shared/index.ts';
import { digest, sameOwner, triggerEntry, turnEntries } from './turn-history.ts';
import { isTrustedTurnScope, type TrustedTurnScope } from './trusted-scope.ts';

/** The trigger as the harness supplies it; the speaker is bound from the scope, not from input. */
export type TriggerInput =
  | { readonly kind: 'participant_message'; readonly text: string }
  | { readonly kind: 'internal'; readonly origin: InternalOrigin; readonly purpose: string; readonly text: string };

export interface PrepareTurnInput {
  readonly sessionId: SessionId;
  readonly owner: TurnOwner;
  readonly idempotencyKey: IdempotencyKey;
  /** The session revision the harness assembled its context against. */
  readonly expectedRevision: number;
  readonly trigger: TriggerInput;
}

export interface PreparedTurn {
  readonly scope: TrustedTurnScope;
  readonly record: TurnRecord;
}

/** A retried request whose turn already settled: replay the outcome, do not re-execute. */
export interface ReplayedTurn {
  readonly kind: 'replayed';
  readonly record: TurnRecord;
}

export type PrepareTurnResult = { readonly kind: 'prepared'; readonly turn: PreparedTurn } | ReplayedTurn;

/** A successor harness claiming a session whose open turn's owner is gone. */
export interface RecoverTurnInput {
  readonly sessionId: SessionId;
  readonly owner: TurnOwner;
}

export interface TurnLifecycle {
  prepareTurn(scope: TrustedTurnScope, input: PrepareTurnInput): Promise<Result<PrepareTurnResult>>;
  commitTurn(
    turn: PreparedTurn,
    owner: TurnOwner,
    outcome: Extract<TurnOutcome, { kind: 'completed' }>,
  ): Promise<Result<TurnRecord>>;
  abortTurn(
    turn: PreparedTurn,
    owner: TurnOwner,
    outcome: Exclude<TurnOutcome, { kind: 'completed' }>,
  ): Promise<Result<TurnRecord>>;
  /**
   * Settles an abandoned open turn as interrupted by the host once its lease
   * has expired, so a successor can prepare the next turn. The caller then
   * prepares against the new revision.
   */
  recoverTurn(scope: TrustedTurnScope, input: RecoverTurnInput): Promise<Result<TurnRecord>>;
}

export interface TurnLifecycleDeps {
  readonly ledger: TurnLedgerPort;
  readonly archive: SessionArchivePort;
  /** Sessions are bound to one audience; a turn from any other audience is refused. */
  readonly sessions: SessionCatalogPort;
  readonly clock: Clock;
  readonly ids: IdSource;
  /** How long an open turn belongs exclusively to its owner before a successor may recover it. */
  readonly turnLeaseMs: number;
}

export function createTurnLifecycle(deps: TurnLifecycleDeps): Result<TurnLifecycle> {
  if (!Number.isInteger(deps.turnLeaseMs) || deps.turnLeaseMs < 1) {
    return invalid('turnLeaseMs must be a positive integer');
  }
  return ok({
    prepareTurn: (scope, input) => prepareTurn(deps, scope, input),
    commitTurn: async (turn, owner, outcome) =>
      (outcome.kind as string) === 'completed'
        ? settleTurn(deps, turn, owner, outcome)
        : invalid('commitTurn records completed turns; use abortTurn for interrupted or failed ones'),
    abortTurn: async (turn, owner, outcome) =>
      (outcome.kind as string) === 'completed'
        ? invalid('abortTurn records interrupted or failed turns; use commitTurn for completed ones')
        : settleTurn(deps, turn, owner, outcome),
    recoverTurn: (scope, input) => recoverTurn(deps, scope, input),
  });
}

async function prepareTurn(
  deps: TurnLifecycleDeps,
  scope: TrustedTurnScope,
  input: PrepareTurnInput,
): Promise<Result<PrepareTurnResult>> {
  if (!isTrustedTurnScope(scope)) return denied('unknown_authority', 'scope was not admitted by ingress');
  const trigger = bindTrigger(scope, input.trigger);
  if (!trigger.ok) return trigger;
  const fingerprint = fingerprintRequest(input.sessionId, scope, trigger.value);
  const session = await deps.sessions.get(input.sessionId);
  if (!session.ok) return session;
  if (!sameAudience(session.value.audience, scope.audience)) {
    return denied('audience_not_admitted', 'the session belongs to another audience');
  }

  const existing = await deps.ledger.findByIdempotencyKey(input.sessionId, input.idempotencyKey);
  if (!existing.ok) return existing;
  if (existing.value !== null) {
    const record = existing.value;
    if (record.requestFingerprint !== fingerprint) {
      return conflict('idempotency_mismatch', 'idempotency key was reused for a different request');
    }
    if (!sameOwner(record.owner, input.owner)) return conflict('turn_ownership', 'turn is owned by another harness');
    // Re-appending repairs history a failed append left incomplete; identical entries are no-ops.
    const archived = await deps.archive.append(turnEntries(record));
    if (!archived.ok) return archived;
    if (record.settlement !== null) return ok({ kind: 'replayed', record });
    return ok({ kind: 'prepared', turn: { scope, record } });
  }

  const head = await deps.ledger.head(input.sessionId);
  if (!head.ok) return head;
  if (head.value.openTurnId !== null) {
    const open = await deps.ledger.get(head.value.openTurnId);
    if (!open.ok) return open;
    return conflict(
      'turn_already_open',
      `session has an open turn owned by ${open.value.owner.surface} until ${open.value.leaseUntil}; ` +
        'the owner settles it, or a successor recovers it after the lease',
    );
  }
  if (head.value.revision !== input.expectedRevision) {
    return fail({
      kind: 'conflict',
      reason: 'stale_revision',
      expectedRevision: input.expectedRevision,
      actualRevision: head.value.revision,
      detail: 'session changed since the context was assembled',
    });
  }
  const now = deps.clock.now();
  const opened = await deps.ledger.open({
    turnId: deps.ids.next('turn'),
    sessionId: input.sessionId,
    owner: input.owner,
    idempotencyKey: input.idempotencyKey,
    requestFingerprint: fingerprint,
    baseRevision: head.value.revision,
    audience: scope.audience,
    trigger: trigger.value,
    openedAt: now.toISOString(),
    leaseUntil: new Date(now.getTime() + deps.turnLeaseMs).toISOString(),
    settlement: null,
  });
  if (!opened.ok) return opened;
  const touched = await deps.sessions.touch(input.sessionId, opened.value.openedAt);
  if (!touched.ok) return touched;
  // Archive the trigger at open so lived history is complete even if the turn never settles.
  const archived = await deps.archive.append([triggerEntry(opened.value)]);
  if (!archived.ok) return archived;
  return ok({ kind: 'prepared', turn: { scope, record: opened.value } });
}

/**
 * The ledger write fixes the outcome first; history is then derived from the
 * settled record. A failed append is returned as a failure and repaired by
 * retrying the same outcome. A different outcome after the ledger settled is a
 * conflict, so history can never show a reply the ledger did not record.
 */
async function settleTurn(
  deps: TurnLifecycleDeps,
  turn: PreparedTurn,
  owner: TurnOwner,
  outcome: TurnOutcome,
): Promise<Result<TurnRecord>> {
  if (!isTrustedTurnScope(turn.scope)) return denied('unknown_authority', 'scope was not admitted by ingress');
  const current = await deps.ledger.get(turn.record.turnId);
  if (!current.ok) return current;
  const record = current.value;
  if (!sameOwner(record.owner, owner)) return conflict('turn_ownership', 'only the owning harness may settle a turn');
  if (record.settlement !== null) {
    if (!sameOwner(record.settlement.settledBy, owner) || digest(record.settlement.outcome) !== digest(outcome)) {
      return conflict('turn_already_settled', `turn already settled as ${record.settlement.outcome.kind}`);
    }
    return archiveSettled(deps, record);
  }
  const settled = await deps.ledger.settle({
    turnId: record.turnId,
    settledBy: owner,
    outcome,
    settledAt: deps.clock.now().toISOString(),
    expectedRevision: record.baseRevision,
  });
  if (!settled.ok) return settled;
  return archiveSettled(deps, settled.value);
}

async function recoverTurn(
  deps: TurnLifecycleDeps,
  scope: TrustedTurnScope,
  input: RecoverTurnInput,
): Promise<Result<TurnRecord>> {
  if (!isTrustedTurnScope(scope)) return denied('unknown_authority', 'scope was not admitted by ingress');
  if (scope.caller.kind === 'worker') return denied('worker_not_permitted', 'workers cannot recover turns');
  const head = await deps.ledger.head(input.sessionId);
  if (!head.ok) return head;
  if (head.value.openTurnId === null) return notFound(`open turn in session ${input.sessionId}`);
  const open = await deps.ledger.get(head.value.openTurnId);
  if (!open.ok) return open;
  const record = open.value;
  if (digest(record.audience) !== digest(scope.audience)) {
    return denied('audience_not_admitted', 'only a scope for the turn audience may recover it');
  }
  if (sameOwner(record.owner, input.owner)) return invalid('the owning harness settles its own turn with abortTurn');
  const now = deps.clock.now();
  if (now.getTime() < Date.parse(record.leaseUntil)) {
    return conflict('turn_lease_active', `turn is leased to ${record.owner.surface} until ${record.leaseUntil}`);
  }
  const settled = await deps.ledger.settle({
    turnId: record.turnId,
    settledBy: input.owner,
    outcome: { kind: 'interrupted', by: 'host', partialReply: null, delivery: 'unknown' },
    settledAt: now.toISOString(),
    expectedRevision: record.baseRevision,
  });
  if (!settled.ok) return settled;
  return archiveSettled(deps, settled.value);
}

async function archiveSettled(deps: TurnLifecycleDeps, record: TurnRecord): Promise<Result<TurnRecord>> {
  const archived = await deps.archive.append(turnEntries(record));
  if (!archived.ok) return archived;
  return ok(record);
}

function bindTrigger(scope: TrustedTurnScope, input: TriggerInput): Result<TurnTrigger> {
  if (!isNonEmptyString(input.text)) return invalid('trigger text must be non-empty');
  if (input.kind === 'participant_message') {
    if (scope.caller.kind !== 'participant') {
      return denied('unknown_authority', 'only an admitted participant can supply participant speech');
    }
    return ok({ kind: 'participant_message', speaker: scope.caller.contactId, text: input.text });
  }
  if (scope.caller.kind !== 'companion_internal') {
    return denied('unknown_authority', 'internal triggers require a companion-internal scope');
  }
  if ((input.origin.kind as string) === 'participant_speech') {
    return invalid('internal triggers cannot be attributed as participant speech');
  }
  if (!isNonEmptyString(input.purpose)) return invalid('internal trigger purpose must be non-empty');
  return ok({ kind: 'internal', origin: input.origin, purpose: input.purpose, text: input.text });
}

function fingerprintRequest(sessionId: SessionId, scope: TrustedTurnScope, trigger: TurnTrigger): string {
  return digest({ sessionId, caller: scope.caller, audience: scope.audience, trigger });
}
