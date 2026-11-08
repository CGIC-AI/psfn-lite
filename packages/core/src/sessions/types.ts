import type {
  Audience,
  ContactId,
  IdempotencyKey,
  InternalOrigin,
  Origin,
  Result,
  SessionId,
  SurfaceId,
  TurnId,
} from '../shared/index.ts';

/**
 * The harness instance executing a turn. Only the owner may settle it while its
 * lease runs. `instance` names one harness process lifetime: a harness that
 * keeps it stable across restarts can resume its own open turn with the same
 * idempotency key; any other successor recovers the turn after the lease ends.
 */
export interface TurnOwner {
  readonly surface: SurfaceId;
  readonly instance: string;
}

/** What started a turn, attributed at ingress rather than by the model. */
export type TurnTrigger =
  | { readonly kind: 'participant_message'; readonly speaker: ContactId; readonly text: string }
  | { readonly kind: 'internal'; readonly origin: InternalOrigin; readonly purpose: string; readonly text: string };

export type DeliveryStatus = 'not_attempted' | 'delivered' | 'not_delivered' | 'unknown';

/**
 * The actual outcome of a turn. Interrupted and failed turns are recorded with
 * the same durability as completed ones; a missing outcome is never assumed.
 */
export type TurnOutcome =
  | { readonly kind: 'completed'; readonly reply: string | null; readonly delivery: DeliveryStatus }
  | {
      readonly kind: 'interrupted';
      readonly by: 'participant' | 'host' | 'shutdown';
      readonly partialReply: string | null;
      readonly delivery: DeliveryStatus;
    }
  | {
      readonly kind: 'failed';
      readonly error: { readonly code: string; readonly message: string };
      readonly partialReply: string | null;
      readonly delivery: DeliveryStatus;
    };

export interface TurnSettlement {
  readonly outcome: TurnOutcome;
  /** The owner, or the successor harness that recovered an abandoned turn. */
  readonly settledBy: TurnOwner;
  readonly settledAt: string;
  /** Session revision after this settlement. */
  readonly revision: number;
}

export interface TurnRecord {
  readonly turnId: TurnId;
  readonly sessionId: SessionId;
  readonly owner: TurnOwner;
  readonly idempotencyKey: IdempotencyKey;
  /** Digest of the admitted request, so a reused key with different content is detected. */
  readonly requestFingerprint: string;
  /** Session revision the turn was prepared against. */
  readonly baseRevision: number;
  readonly audience: Audience;
  readonly trigger: TurnTrigger;
  readonly openedAt: string;
  /** Until this instant only the owner may settle the turn; afterwards a successor may recover it. */
  readonly leaseUntil: string;
  readonly settlement: TurnSettlement | null;
}

export interface SessionHead {
  readonly sessionId: SessionId;
  readonly revision: number;
  readonly openTurnId: TurnId | null;
}

/**
 * Durable turn ledger, implemented by a storage adapter. `open` and `settle`
 * are compare-and-set operations: they return a conflict instead of writing
 * when the session head no longer matches.
 */
export interface TurnLedgerPort {
  head(sessionId: SessionId): Promise<Result<SessionHead>>;
  get(turnId: TurnId): Promise<Result<TurnRecord>>;
  findByIdempotencyKey(sessionId: SessionId, key: IdempotencyKey): Promise<Result<TurnRecord | null>>;
  open(record: TurnRecord): Promise<Result<TurnRecord>>;
  settle(input: {
    readonly turnId: TurnId;
    readonly settledBy: TurnOwner;
    readonly outcome: TurnOutcome;
    readonly settledAt: string;
    readonly expectedRevision: number;
  }): Promise<Result<TurnRecord>>;
}

/** One attributed entry of canonical lived history. */
export interface SessionEntry {
  /**
   * Stable id. Appending an entry whose id already exists with identical
   * content is a no-op; with different content it is an `entry_mismatch`
   * conflict and nothing is written.
   */
  readonly entryId: string;
  readonly sessionId: SessionId;
  readonly turnId: TurnId;
  readonly origin: Origin;
  readonly text: string;
  readonly at: string;
}

/**
 * Append-only canonical history (filesystem JSONL in the storage adapter).
 * Turn entries are derived from the ledger record after it is written, so a
 * retry re-appends identical entries and repairs a missed append.
 */
export interface SessionArchivePort {
  append(entries: readonly SessionEntry[]): Promise<Result<void>>;
  readTail(sessionId: SessionId, limit: number): Promise<Result<readonly SessionEntry[]>>;
}
