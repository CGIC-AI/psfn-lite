import type { Author, ChannelId, Result, Sensitivity } from '../shared/index.ts';

/**
 * Runtime-stamped journal provenance. It is never parsed from note content;
 * a missing or merged-from-different-sources provenance is `restricted`.
 */
export type JournalProvenance =
  | { readonly scope: 'conversation'; readonly channelId: ChannelId }
  | { readonly scope: 'restricted' };

export interface JournalNote {
  readonly path: string;
  readonly provenance: JournalProvenance;
  readonly author: Author;
  readonly body: string;
  readonly revision: number;
}

/** Workspace journal access; an unreadable note is reported as missing and cannot be overwritten. */
export interface JournalPort {
  read(path: string, admitted: readonly Sensitivity[], readerChannelId: ChannelId | null): Promise<Result<JournalNote>>;
  write(note: JournalNote, expectedRevision: number | null): Promise<Result<JournalNote>>;
}

/** A reflection record. Authority is explicit: the companion's reflection or a machine process log. */
export interface ReflectionEntry {
  readonly id: string;
  readonly templateId: string;
  readonly author: Author;
  readonly reflection: string;
  readonly createdAt: string;
}

export interface ReflectionReadPort {
  listRecent(limit: number): Promise<Result<readonly ReflectionEntry[]>>;
}

export type LetterState = 'draft' | 'placed' | 'read' | 'archived';

/** Slow private correspondence between the companion and the Partner. */
export interface Letter {
  readonly id: string;
  readonly author: 'companion' | 'partner';
  readonly recipient: 'companion' | 'partner';
  readonly subject: string;
  readonly body: string;
  readonly state: LetterState;
}
