import { createHash } from 'node:crypto';
import type {
  SessionArchivePort,
  SessionEntry,
  TurnLedgerPort,
  TurnOutcome,
  TurnOwner,
  TurnRecord,
  TurnTrigger,
} from '../sessions/index.ts';
import {
  denied,
  fail,
  invalid,
  isNonEmptyString,
  ok,
  type Clock,
  type IdSource,
  type IdempotencyKey,
  type InternalOrigin,
  type Result,
  type SessionId,
} from '../shared/index.ts';
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
}

export function createTurnLifecycle(deps: {
  readonly ledger: TurnLedgerPort;
  readonly archive: SessionArchivePort;
  readonly clock: Clock;
  readonly ids: IdSource;
}): TurnLifecycle {
  return {
    prepareTurn: (scope, input) => prepareTurn(deps, scope, input),
    commitTurn: async (turn, owner, outcome) =>
      (outcome.kind as string) === 'completed'
        ? settleTurn(deps, turn, owner, outcome)
        : invalid('commitTurn records completed turns; use abortTurn for interrupted or failed ones'),
    abortTurn: async (turn, owner, outcome) =>
      (outcome.kind as string) === 'completed'
        ? invalid('abortTurn records interrupted or failed turns; use commitTurn for completed ones')
        : settleTurn(deps, turn, owner, outcome),
  };
}

async function prepareTurn(
  deps: Parameters<typeof createTurnLifecycle>[0],
  scope: TrustedTurnScope,
  input: PrepareTurnInput,
): Promise<Result<PrepareTurnResult>> {
  if (!isTrustedTurnScope(scope)) return denied('unknown_authority', 'scope was not admitted by ingress');
  const trigger = bindTrigger(scope, input.trigger);
  if (!trigger.ok) return trigger;
  const fingerprint = fingerprintRequest(input.sessionId, scope, trigger.value);

  const existing = await deps.ledger.findByIdempotencyKey(input.sessionId, input.idempotencyKey);
  if (!existing.ok) return existing;
  if (existing.value !== null) {
    const record = existing.value;
    if (record.requestFingerprint !== fingerprint) {
      return conflict('idempotency_mismatch', 'idempotency key was reused for a different request');
    }
    if (!sameOwner(record.owner, input.owner)) return conflict('turn_ownership', 'turn is owned by another harness');
    if (record.settlement !== null) return ok({ kind: 'replayed', record });
    const archived = await deps.archive.append([triggerEntry(record)]);
    if (!archived.ok) return archived;
    return ok({ kind: 'prepared', turn: { scope, record } });
  }

  const head = await deps.ledger.head(input.sessionId);
  if (!head.ok) return head;
  if (head.value.openTurnId !== null) {
    return conflict('turn_already_open', 'session has an open turn; settle or abort it first');
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
  const opened = await deps.ledger.open({
    turnId: deps.ids.next('turn'),
    sessionId: input.sessionId,
    owner: input.owner,
    idempotencyKey: input.idempotencyKey,
    requestFingerprint: fingerprint,
    baseRevision: head.value.revision,
    audience: scope.audience,
    trigger: trigger.value,
    openedAt: deps.clock.now().toISOString(),
    settlement: null,
  });
  if (!opened.ok) return opened;
  // Archive the trigger at open so lived history is complete even if the turn never settles.
  const archived = await deps.archive.append([triggerEntry(opened.value)]);
  if (!archived.ok) return archived;
  return ok({ kind: 'prepared', turn: { scope, record: opened.value } });
}

async function settleTurn(
  deps: Parameters<typeof createTurnLifecycle>[0],
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
    if (digest(record.settlement.outcome) === digest(outcome)) return ok(record);
    return conflict('turn_already_settled', `turn already settled as ${record.settlement.outcome.kind}`);
  }
  const at = deps.clock.now().toISOString();
  const entries = outcomeEntries(record, outcome, at);
  if (entries.length > 0) {
    const archived = await deps.archive.append(entries);
    if (!archived.ok) return archived;
  }
  return deps.ledger.settle({
    turnId: record.turnId,
    owner,
    outcome,
    settledAt: at,
    expectedRevision: record.baseRevision,
  });
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

function triggerEntry(record: TurnRecord): SessionEntry {
  const { trigger } = record;
  return {
    entryId: `${record.turnId}:trigger`,
    sessionId: record.sessionId,
    turnId: record.turnId,
    origin: trigger.kind === 'participant_message' ? { kind: 'participant_speech', speaker: trigger.speaker } : trigger.origin,
    text: trigger.text,
    at: record.openedAt,
  };
}

function outcomeEntries(record: TurnRecord, outcome: TurnOutcome, at: string): SessionEntry[] {
  const base = { sessionId: record.sessionId, turnId: record.turnId, at };
  const reply = outcome.kind === 'completed' ? outcome.reply : outcome.partialReply;
  const entries: SessionEntry[] = [];
  if (reply !== null) {
    entries.push({ ...base, entryId: `${record.turnId}:reply`, origin: { kind: 'companion_speech' }, text: reply });
  }
  if (outcome.kind !== 'completed') {
    const text =
      outcome.kind === 'interrupted'
        ? `turn interrupted by ${outcome.by}`
        : `turn failed: ${outcome.error.code}: ${outcome.error.message}`;
    entries.push({ ...base, entryId: `${record.turnId}:outcome`, origin: { kind: 'system_note', source: 'turn_lifecycle' }, text });
  }
  return entries;
}

function sameOwner(a: TurnOwner, b: TurnOwner): boolean {
  return a.surface === b.surface && a.instance === b.instance;
}

function fingerprintRequest(sessionId: SessionId, scope: TrustedTurnScope, trigger: TurnTrigger): string {
  return digest({ sessionId, caller: scope.caller, audience: scope.audience, trigger });
}

function digest(value: unknown): string {
  return createHash('sha256').update(stableJson(value)).digest('hex');
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (typeof value === 'object' && value !== null) {
    const entries = Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableJson(v)}`).join(',')}}`;
  }
  if (value === undefined) return 'null';
  return JSON.stringify(value);
}

function conflict(reason: 'turn_ownership' | 'turn_already_open' | 'turn_already_settled' | 'idempotency_mismatch', detail: string) {
  return fail({ kind: 'conflict', reason, detail } as const);
}
