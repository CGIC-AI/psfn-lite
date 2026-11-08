import type {
  Audience,
  Author,
  ChannelId,
  ContactId,
  IdempotencyKey,
  Result,
  Sensitivity,
  SessionId,
  TurnId,
} from '../shared/index.ts';

export type MemoryKind = 'fact' | 'preference' | 'event' | 'relational' | 'procedural' | 'boundary';

/** Where a memory came from. Authorization inputs are stamped by the runtime, never by the model. */
export interface MemoryProvenance {
  readonly author: Author;
  readonly sourceChannelId: ChannelId | null;
  readonly sourceSessionId: SessionId | null;
  readonly sourceTurnIds: readonly TurnId[];
  readonly subjectContactIds: readonly ContactId[];
  /** Conversation time for live writes; null for imports and patches (fail closed for epoch disclosure). */
  readonly sourceConversationAt: string | null;
}

export interface MemoryRecord {
  readonly id: string;
  readonly kind: MemoryKind;
  readonly content: string;
  readonly sensitivity: Sensitivity;
  readonly provenance: MemoryProvenance;
  readonly state: 'current' | 'superseded' | 'soft_deleted';
}

/**
 * The read scope a retrieval runs under. It is derived from the trusted turn
 * scope; there is no optional or default authorization.
 */
export interface MemoryReadScope {
  readonly audience: Audience;
  readonly admitted: readonly Sensitivity[];
  readonly viewerContactId: ContactId | null;
}

export type WriteOutcome = 'created' | 'deduplicated' | 'updated' | 'superseded' | 'negated' | 'conflict';

/** Visible-only memory reads. Withheld items are not confirmed to exist. */
export interface MemoryReadPort {
  search(scope: MemoryReadScope, query: string, limit: number): Promise<Result<readonly MemoryRecord[]>>;
  get(scope: MemoryReadScope, id: string): Promise<Result<MemoryRecord>>;
}

export interface MemoryWritePort {
  write(input: {
    readonly kind: MemoryKind;
    readonly content: string;
    readonly sensitivity: Sensitivity;
    readonly provenance: MemoryProvenance;
    readonly idempotencyKey: IdempotencyKey;
  }): Promise<Result<{ readonly id: string; readonly outcome: WriteOutcome }>>;
}

/** The companion cannot delete; a deletion is a durable proposal an operator decides. */
export interface MemoryDeletionProposal {
  readonly memoryId: string;
  readonly justification: 'inaccurate' | 'harmful' | 'privacy' | 'obsolete' | 'other';
  readonly explanation: string;
  readonly proposedBy: Author;
}

/** Same-day working notes, visible only in the conversation that wrote them unless global. */
export interface ScratchpadNote {
  readonly id: string;
  readonly text: string;
  readonly scope: { readonly kind: 'conversation'; readonly channelId: ChannelId } | { readonly kind: 'companion_global' };
  readonly expiresAt: string;
}
