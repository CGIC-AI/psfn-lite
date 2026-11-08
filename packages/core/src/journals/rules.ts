import { sourceKeys, sourceReadable, type SourceAccess } from '../memory/index.ts';
import { invalid, notFound, ok, sameConversation, type Audience, type Result } from '../shared/index.ts';
import type { JournalProvenance, Letter, LetterParty } from './types.ts';

/**
 * Journal and letter rules ported from the donor
 * (`src/boundary/integrations/journal/provenance.ts`,
 * `src/core/letters/service.ts`). A conversation note is readable wherever
 * that conversation's material is; a restricted note only where confidential
 * material is.
 */
export function journalReadable(access: SourceAccess, provenance: JournalProvenance): boolean {
  if (provenance.scope === 'restricted') return access.sensitivities.includes('confidential');
  const { conversation, sourceClass } = sourceKeys(provenance.source);
  return sourceReadable(access, conversation, sourceClass);
}

/** Provenance a turn stamps on what it writes. Self turns synthesize across conversations, so they write restricted notes. */
export function writerProvenance(audience: Audience): JournalProvenance {
  return audience.kind === 'self' ? { scope: 'restricted' } : { scope: 'conversation', source: audience };
}

/** The same conversation stays; anything else is restricted. */
export function mergeProvenance(existing: JournalProvenance, incoming: JournalProvenance): JournalProvenance {
  if (existing.scope === 'conversation' && incoming.scope === 'conversation' && sameConversation(existing.source, incoming.source)) return existing;
  return { scope: 'restricted' };
}

const PATH = /^[a-z0-9][a-z0-9_-]*(\/[a-z0-9][a-z0-9_-]*)*(\.md)?$/;

/** Journal paths are lowercase relative segments; no traversal, no absolute paths. */
export function parseJournalPath(raw: string): Result<string> {
  const path = raw.trim();
  if (path.length > 200 || !PATH.test(path)) return invalid('journal path must be lowercase relative segments of [a-z0-9_-], optionally ending in .md');
  return ok(path);
}

export function placeLetter(letter: Letter, actor: LetterParty, at: string): Result<Letter> {
  if (letter.author !== actor) return invalid(`only the ${letter.author} places this letter`);
  if (letter.state !== 'draft') return invalid(`letter ${letter.id} is ${letter.state}, not a draft`);
  return ok({ ...letter, state: 'placed', placedAt: at, updatedAt: at, revision: letter.revision + 1 });
}

/** Whether a party may see a letter at all: its own letters, and the other party's once placed. */
export function letterVisibleTo(letter: Letter, party: LetterParty): boolean {
  if (letter.author === party) return true;
  return letter.recipient === party && letter.state !== 'draft';
}

/** Reading a placed letter addressed to the reader marks it read; any other reading leaves it as it is. */
export function readLetter(letter: Letter, reader: LetterParty, at: string): Result<Letter> {
  if (!letterVisibleTo(letter, reader)) return notFound(`letter ${letter.id}`);
  if (letter.recipient === reader && letter.state === 'placed') {
    return ok({ ...letter, state: 'read', readAt: at, updatedAt: at, revision: letter.revision + 1 });
  }
  return ok(letter);
}

export function archiveLetter(letter: Letter, actor: LetterParty, at: string): Result<Letter> {
  if (letter.author !== actor && letter.recipient !== actor) return invalid('letter is not addressed to or from this party');
  if (letter.state === 'archived') return ok(letter);
  return ok({ ...letter, state: 'archived', archivedAt: at, updatedAt: at, revision: letter.revision + 1 });
}
