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
import type { SourceAccess } from './access.ts';

export const MEMORY_KINDS = ['fact', 'preference', 'event', 'relational', 'procedural', 'boundary'] as const;
export type MemoryKind = (typeof MEMORY_KINDS)[number];

/**
 * Who a memory is about. It is stamped by the runtime from the trusted turn
 * scope (or, for extraction, from the attributed speaker of a source turn),
 * never from model arguments, and every record has one: there is no
 * unattributed memory. A participant reads only memories about themselves or
 * about the room they are in; companion-internal memories stay with self turns.
 */
export type MemorySubject =
  | { readonly kind: 'contacts'; readonly contactIds: readonly ContactId[] }
  | { readonly kind: 'room'; readonly channelId: ChannelId }
  | { readonly kind: 'companion_internal' };

/**
 * Whose words or judgement a memory carries. These stay distinct in storage
 * and in every read: the companion's first-person record, something a
 * participant said, and a machine inference are never promoted into one
 * another.
 */
export type MemoryAttribution =
  | { readonly kind: 'companion_authored' }
  | { readonly kind: 'participant_attributed'; readonly contactId: ContactId }
  | { readonly kind: 'inferred'; readonly producer: string };

export const MEMORY_VIAS = ['tool_write', 'import', 'extraction'] as const;
export type MemoryVia = (typeof MEMORY_VIAS)[number];

/** Where and how a memory was formed. Authorization inputs are stamped by the runtime, never by the model. */
export interface MemoryProvenance {
  readonly author: Author;
  readonly attribution: MemoryAttribution;
  /** The audience the source material was produced in; it decides who may read the memory. */
  readonly source: Audience;
  readonly sourceSessionId: SessionId | null;
  readonly sourceTurnIds: readonly TurnId[];
  /** Conversation time for live writes; null for imports (fail closed for epoch disclosure). */
  readonly sourceConversationAt: string | null;
  readonly via: MemoryVia;
  readonly idempotencyKey: IdempotencyKey;
  readonly recordedAt: string;
}

/**
 * `staged` worker writes and `rejected` ones are never returned to readers;
 * `soft_deleted` ones only through an operator decision or `restore`.
 */
export const MEMORY_STATES = ['current', 'superseded', 'soft_deleted', 'staged', 'rejected'] as const;
export type MemoryState = (typeof MEMORY_STATES)[number];

export interface MemoryRecord {
  readonly id: string;
  readonly kind: MemoryKind;
  readonly content: string;
  readonly sensitivity: Sensitivity;
  readonly subject: MemorySubject;
  /** 0..1, how sure the writer was. */
  readonly confidence: number;
  /** When the remembered thing happened, if known. */
  readonly occurredAt: string | null;
  readonly provenance: MemoryProvenance;
  readonly state: MemoryState;
  readonly supersededBy: string | null;
  readonly revision: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export const MEMORY_RELATIONS = ['supersedes', 'updates', 'negates', 'conflicts_with'] as const;
export type MemoryRelation = (typeof MEMORY_RELATIONS)[number];

/** An evolution edge from a newer memory to an older one. */
export interface MemoryLink {
  readonly fromId: string;
  readonly toId: string;
  readonly relation: MemoryRelation;
  readonly reason: string;
  readonly at: string;
}

export const MEMORY_EVENT_KINDS = [
  'created',
  'reinforced',
  'patched',
  'superseded',
  'staged',
  'approved',
  'rejected',
  'soft_deleted',
  'restored',
] as const;
export type MemoryEventKind = (typeof MEMORY_EVENT_KINDS)[number];

/** Append-only history of one memory. A patch keeps the replaced text here. */
export interface MemoryEvent {
  readonly memoryId: string;
  readonly kind: MemoryEventKind;
  readonly author: Author;
  readonly at: string;
  readonly detail: Readonly<Record<string, unknown>>;
}

/** A model/space pair. Vectors of another length are rejected, never truncated or padded. */
export interface EmbeddingSpace {
  readonly name: string;
  readonly dimensions: number;
}

export interface MemoryHit {
  readonly record: MemoryRecord;
  /** Lexical rank or cosine similarity, depending on the query. Never a vector. */
  readonly score: number;
}

export interface MemoryCandidate {
  readonly record: MemoryRecord;
  readonly vector: readonly number[] | null;
}

export const MEMORY_WRITE_OUTCOMES = ['created', 'deduplicated', 'updated', 'superseded', 'negated', 'conflict', 'staged'] as const;
export type MemoryWriteOutcome = (typeof MEMORY_WRITE_OUTCOMES)[number];

/**
 * What one idempotent write did. A retry with the same key and request digest
 * replays it; the same key with another request is a conflict. The receipt
 * is recorded in the same transaction as the write, so a retry after a crash
 * neither duplicates the memory nor rewrites its provenance.
 */
export interface MemoryWriteReceipt {
  readonly idempotencyKey: IdempotencyKey;
  readonly requestDigest: string;
  readonly memoryId: string;
  readonly outcome: MemoryWriteOutcome;
  readonly at: string;
}

/** Everything a write changes, applied in one transaction or not at all. */
export interface MemoryInsert {
  readonly receipt: MemoryWriteReceipt;
  readonly record: MemoryRecord;
  readonly vector: { readonly space: EmbeddingSpace; readonly values: readonly number[] } | null;
  readonly links: readonly MemoryLink[];
  readonly events: readonly MemoryEvent[];
  /** Older records this write supersedes, compare-and-set on their revisions. */
  readonly supersede: readonly { readonly id: string; readonly expectedRevision: number }[];
}

/**
 * Durable typed memory. Every read that can surface a memory, its count or its
 * similarity takes a `SourceAccess` and applies it before ranking and limits,
 * so withheld memories influence neither results, ids nor counts. `get`,
 * `receipt`, `candidates`, `pendingEmbeddings` and `staged` are unfiltered
 * and only core services call them, re-checking visibility themselves.
 */
export interface MemoryStorePort {
  get(id: string): Promise<Result<MemoryRecord>>;
  receipt(key: IdempotencyKey): Promise<Result<MemoryWriteReceipt | null>>;
  /** Current memories of one subject and kind with their vectors in `space`, newest first. */
  candidates(subject: MemorySubject, kind: MemoryKind, space: EmbeddingSpace, limit: number): Promise<Result<readonly MemoryCandidate[]>>;
  searchLexical(access: SourceAccess, query: string, limit: number): Promise<Result<readonly MemoryHit[]>>;
  searchSemantic(access: SourceAccess, space: EmbeddingSpace, vector: readonly number[], limit: number): Promise<Result<readonly MemoryHit[]>>;
  /** Current memories visible under `access` whose subject includes the contact, newest first. */
  aboutContact(access: SourceAccess, contactId: ContactId, limit: number): Promise<Result<readonly MemoryRecord[]>>;
  census(access: SourceAccess): Promise<Result<Readonly<Partial<Record<MemoryKind, number>>>>>;
  /** A new key whose receipt already exists is an `idempotency_mismatch` conflict. */
  insert(input: MemoryInsert): Promise<Result<MemoryRecord>>;
  /** Records a deduplicated write against an existing memory: its receipt and a `reinforced` event. */
  reinforce(receipt: MemoryWriteReceipt, event: MemoryEvent): Promise<Result<void>>;
  /** Compare-and-set replacement of one record with an event. */
  update(record: MemoryRecord, expectedRevision: number, event: MemoryEvent): Promise<Result<MemoryRecord>>;
  putEmbedding(memoryId: string, space: EmbeddingSpace, vector: readonly number[]): Promise<Result<void>>;
  /** Current memories without a vector in `space`, oldest first. */
  pendingEmbeddings(space: EmbeddingSpace, limit: number): Promise<Result<readonly MemoryRecord[]>>;
  links(memoryId: string): Promise<Result<readonly MemoryLink[]>>;
  events(memoryId: string, limit: number): Promise<Result<readonly MemoryEvent[]>>;
  staged(limit: number): Promise<Result<readonly MemoryRecord[]>>;
}

export const DELETION_JUSTIFICATIONS = ['inaccurate', 'harmful', 'privacy', 'obsolete', 'other'] as const;
export type DeletionJustification = (typeof DELETION_JUSTIFICATIONS)[number];

export type DeletionProposalStatus = 'pending' | 'approved' | 'denied' | 'restored';

/** The companion cannot delete; a deletion is a durable proposal an operator decides. */
export interface MemoryDeletionProposal {
  readonly proposalId: string;
  readonly memoryId: string;
  /** The memory revision the proposal was made against; a moved memory makes it stale. */
  readonly memoryRevision: number;
  readonly justification: DeletionJustification;
  readonly explanation: string;
  readonly proposedBy: Author;
  readonly proposedAt: string;
  readonly approvalId: string;
  readonly status: DeletionProposalStatus;
  readonly decidedBy: Author | null;
  readonly decidedAt: string | null;
  readonly revision: number;
}

export interface MemoryDeletionPort {
  create(proposal: MemoryDeletionProposal): Promise<Result<MemoryDeletionProposal>>;
  get(proposalId: string): Promise<Result<MemoryDeletionProposal>>;
  /** The newest proposal for a memory with the given status, if any. */
  latestFor(memoryId: string, status: DeletionProposalStatus): Promise<Result<MemoryDeletionProposal | null>>;
  save(proposal: MemoryDeletionProposal, expectedRevision: number): Promise<Result<MemoryDeletionProposal>>;
}

/**
 * A same-day working note. A conversation note is visible only in the
 * conversation that wrote it; a companion-global one everywhere, so it may
 * only be written from a self turn.
 */
export interface ScratchpadNote {
  readonly id: string;
  readonly text: string;
  readonly scope: { readonly kind: 'conversation'; readonly conversation: string } | { readonly kind: 'companion_global' };
  readonly author: Author;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly revision: number;
}

export interface ScratchpadPort {
  /** Unexpired notes of the conversation plus unexpired global notes, oldest first. */
  list(conversation: string, now: string, limit: number): Promise<Result<readonly ScratchpadNote[]>>;
  get(id: string): Promise<Result<ScratchpadNote>>;
  /** `expectedRevision` null creates; otherwise compare-and-set. */
  put(note: ScratchpadNote, expectedRevision: number | null): Promise<Result<ScratchpadNote>>;
  remove(id: string, expectedRevision: number): Promise<Result<void>>;
}

/** A per-session processing watermark (extraction, episode formation): the archive position already processed. */
export interface SessionCursorPort {
  get(sessionId: SessionId): Promise<Result<{ readonly seq: number; readonly revision: number }>>;
  /** `expectedRevision` 0 means no cursor yet. */
  advance(sessionId: SessionId, seq: number, expectedRevision: number): Promise<Result<void>>;
}
