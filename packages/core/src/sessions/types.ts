import type {
  Audience,
  Author,
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

/** An archived entry with its position and integrity hash in its session's chain. */
export interface ArchivedEntry {
  /** 1-based position in the session's canonical history. */
  readonly seq: number;
  /** Chain hash: commits to this entry and every earlier entry of the session. */
  readonly hash: string;
  readonly entry: SessionEntry;
}

/** How much canonical history a session has, and the chain hash of its last entry. */
export interface ArchiveHead {
  readonly sessionId: SessionId;
  readonly count: number;
  readonly hash: string | null;
}

/**
 * Append-only canonical history (filesystem JSONL in the storage adapter).
 * Turn entries are derived from the ledger record after it is written, so a
 * retry re-appends identical entries and repairs a missed append. A broken
 * hash chain is reported as `unavailable`, never silently skipped.
 */
export interface SessionArchivePort {
  append(entries: readonly SessionEntry[]): Promise<Result<void>>;
  readTail(sessionId: SessionId, limit: number): Promise<Result<readonly SessionEntry[]>>;
  /** Entries with `seq >= fromSeq`, oldest first, at most `limit`. */
  readRange(sessionId: SessionId, fromSeq: number, limit: number): Promise<Result<readonly ArchivedEntry[]>>;
  head(sessionId: SessionId): Promise<Result<ArchiveHead>>;
}

/**
 * A logical session: canonical history of one conversation. Its audience is
 * fixed when it is created; turns from another audience are refused, so a
 * session id never mixes rooms. Lineage records the session it follows in the
 * same conversation and, for a resumed session, the one it continues.
 */
export interface SessionRecord {
  readonly sessionId: SessionId;
  readonly audience: Audience;
  readonly createdAt: string;
  readonly lastActivityAt: string;
  readonly previousSessionId: SessionId | null;
  readonly continuesFrom: SessionId | null;
}

/** The session a conversation's turns currently go to. */
export interface ConversationHead {
  readonly conversation: string;
  readonly sessionId: SessionId;
  readonly revision: number;
}

/** Durable session catalog (structured state). `setActive` is compare-and-set. */
export interface SessionCatalogPort {
  get(sessionId: SessionId): Promise<Result<SessionRecord>>;
  create(record: SessionRecord): Promise<Result<SessionRecord>>;
  /** Raises `lastActivityAt`; never lowers it. */
  touch(sessionId: SessionId, at: string): Promise<Result<void>>;
  /** Sessions ordered by most recent activity, then id, starting after `cursor`. */
  list(limit: number, cursor: SessionCursor | null): Promise<Result<readonly SessionRecord[]>>;
  active(conversation: string): Promise<Result<ConversationHead | null>>;
  /** `expectedRevision` 0 means the conversation has no head yet. */
  setActive(conversation: string, sessionId: SessionId, expectedRevision: number): Promise<Result<ConversationHead>>;
}

export interface SessionCursor {
  readonly lastActivityAt: string;
  readonly sessionId: SessionId;
}

export const CONTINUITY_KINDS = ['checkpoint', 'wake_return'] as const;
export type ContinuityKind = (typeof CONTINUITY_KINDS)[number];
export const CONTINUITY_OCCASIONS = ['wake', 'return'] as const;
export type ContinuityOccasion = (typeof CONTINUITY_OCCASIONS)[number];

/** A continuity note bound to a session, attributed to its author. */
export interface ContinuityArtifact {
  readonly id: string;
  readonly sessionId: SessionId;
  readonly kind: ContinuityKind;
  readonly occasion: ContinuityOccasion | null;
  readonly summary: string;
  readonly nextAnchor: string | null;
  readonly author: Author;
  readonly createdAt: string;
}

export interface ContinuityPort {
  append(artifact: ContinuityArtifact): Promise<Result<ContinuityArtifact>>;
  list(sessionIds: readonly SessionId[], limit: number): Promise<Result<readonly ContinuityArtifact[]>>;
}

/** A bounded focus over a session's history, concluded with attributed knowledge. */
export interface FocusRecord {
  readonly focusId: string;
  readonly sessionId: SessionId;
  readonly scope: string;
  readonly startedAt: string;
  /** Archive position when the focus opened; the focus covers later entries. */
  readonly startSeq: number;
  readonly completion: {
    readonly completedAt: string;
    readonly endSeq: number;
    readonly knowledge: string;
    readonly author: Author;
  } | null;
}

/** At most one open focus per session; `complete` succeeds only on an open focus. */
export interface FocusPort {
  open(record: FocusRecord): Promise<Result<FocusRecord>>;
  openFor(sessionId: SessionId): Promise<Result<FocusRecord | null>>;
  complete(focusId: string, completion: NonNullable<FocusRecord['completion']>): Promise<Result<FocusRecord>>;
}

export interface TranscriptHit {
  readonly seq: number;
  readonly entry: SessionEntry;
  readonly rank: number;
}

/**
 * Derived keyword projection of canonical history (Postgres). It records the
 * archive head it reflects so readers can prove it has not diverged from the
 * JSONL canon before serving from it.
 */
export interface TranscriptProjectionPort {
  watermark(sessionId: SessionId): Promise<Result<ArchiveHead>>;
  /** Appends entries after `expected`; a moved watermark is a conflict. */
  project(sessionId: SessionId, entries: readonly ArchivedEntry[], expected: ArchiveHead): Promise<Result<ArchiveHead>>;
  /** Drops a session's projection so it can be rebuilt from the canon. */
  reset(sessionId: SessionId): Promise<Result<void>>;
  search(query: string, sessionIds: readonly SessionId[], limit: number): Promise<Result<readonly TranscriptHit[]>>;
}
