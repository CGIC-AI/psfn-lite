import type { Audience, Author, Result } from '../shared/index.ts';
import type { SourceAccess } from '../memory/index.ts';

/**
 * Runtime-stamped journal provenance. It is never parsed from note content.
 * A note written from self turns (which synthesize across conversations) or
 * merged from different conversations is `restricted`.
 */
export type JournalProvenance = { readonly scope: 'conversation'; readonly source: Audience } | { readonly scope: 'restricted' };

export interface JournalNote {
  readonly path: string;
  readonly provenance: JournalProvenance;
  readonly author: Author;
  readonly body: string;
  readonly revision: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/**
 * Companion journal notes. `list` and `search` apply the access before
 * limits; `get` is unfiltered and the service re-checks readability, so an
 * unreadable note reads as missing and cannot be overwritten.
 */
export interface JournalNotePort {
  get(path: string): Promise<Result<JournalNote>>;
  list(access: SourceAccess, limit: number): Promise<Result<readonly JournalNote[]>>;
  search(access: SourceAccess, query: string, limit: number): Promise<Result<readonly JournalNote[]>>;
  /** `expectedRevision` null creates; otherwise compare-and-set. */
  put(note: JournalNote, expectedRevision: number | null): Promise<Result<JournalNote>>;
}

/**
 * A reflection record. Authority is explicit: the companion's own reflection
 * (written in a self turn) or a machine process log. One never stands in for
 * the other.
 */
export interface ReflectionEntry {
  readonly id: string;
  readonly templateId: string;
  readonly kind: 'companion_reflection' | 'process_log';
  readonly author: Author;
  readonly text: string;
  readonly createdAt: string;
}

/** Append-only reflections; appending an existing id with the same content is a no-op, otherwise a conflict. */
export interface ReflectionPort {
  append(entry: ReflectionEntry): Promise<Result<ReflectionEntry>>;
  list(limit: number): Promise<Result<readonly ReflectionEntry[]>>;
  get(id: string): Promise<Result<ReflectionEntry>>;
}

export type LetterParty = 'companion' | 'partner';
export const LETTER_STATES = ['draft', 'placed', 'read', 'archived'] as const;
export type LetterState = (typeof LETTER_STATES)[number];

/** Slow private correspondence between the companion and the Partner. */
export interface Letter {
  readonly id: string;
  readonly author: LetterParty;
  readonly recipient: LetterParty;
  readonly subject: string;
  readonly body: string;
  readonly state: LetterState;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly placedAt: string | null;
  readonly readAt: string | null;
  readonly archivedAt: string | null;
  readonly revision: number;
}

/** The letter bin's own lived history: every composition, placement, reading and archival. */
export interface LetterEvent {
  readonly letterId: string;
  readonly kind: 'composed' | 'placed' | 'read' | 'archived';
  readonly by: LetterParty;
  readonly at: string;
}

export interface LetterPort {
  /** Creates the letter with its event, or returns the existing one with `created: false`. */
  create(letter: Letter, event: LetterEvent): Promise<Result<{ readonly letter: Letter; readonly created: boolean }>>;
  get(id: string): Promise<Result<Letter>>;
  list(filter: { readonly author: LetterParty | null; readonly recipient: LetterParty | null; readonly states: readonly LetterState[]; readonly limit: number }): Promise<
    Result<readonly Letter[]>
  >;
  /** Records the event and, when `next` differs, saves it compare-and-set on `expectedRevision`. */
  record(next: Letter, expectedRevision: number, event: LetterEvent): Promise<Result<Letter>>;
  events(letterId: string, limit: number): Promise<Result<readonly LetterEvent[]>>;
}
