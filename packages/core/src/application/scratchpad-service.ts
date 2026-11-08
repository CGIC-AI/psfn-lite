import type { ScratchpadNote, ScratchpadPort } from '../memory/index.ts';
import { conversationKey, denied, notFound, ok, type Clock, type IdSource, type Result } from '../shared/index.ts';
import { boundedText, endOfUtcDay, requireTrusted } from './memory-scope.ts';
import { authorOf, type TrustedTurnScope } from './trusted-scope.ts';

const NOTE_MAX = 2_000;

export interface ScratchpadService {
  list(scope: TrustedTurnScope, input: { readonly limit: number }): Promise<Result<readonly ScratchpadNote[]>>;
  add(scope: TrustedTurnScope, input: { readonly text: string; readonly global: boolean }): Promise<Result<ScratchpadNote>>;
  replace(scope: TrustedTurnScope, input: { readonly noteId: string; readonly text: string }): Promise<Result<ScratchpadNote>>;
  append(scope: TrustedTurnScope, input: { readonly noteId: string; readonly text: string }): Promise<Result<ScratchpadNote>>;
  remove(scope: TrustedTurnScope, input: { readonly noteId: string }): Promise<Result<{ readonly removed: string }>>;
}

/**
 * Same-day scratchpad notes (donor `src/faculties/memory/scratchpad-visibility.ts`).
 * A note is visible, and changeable, only in the conversation that wrote it.
 * A companion-global note is visible everywhere, so Lite lets only self turns
 * write or change one: a participant conversation cannot broadcast into every
 * other room. Expiry is the end of the UTC day, judged by the host clock.
 */
export function createScratchpadService(deps: { readonly store: ScratchpadPort; readonly clock: Clock; readonly ids: IdSource }): ScratchpadService {
  const now = () => deps.clock.now();

  const writable = async (scope: TrustedTurnScope, noteId: string): Promise<Result<ScratchpadNote>> => {
    const found = await deps.store.get(noteId);
    if (!found.ok) return found.error.kind === 'not_found' ? notFound(`note ${noteId}`) : found;
    const note = found.value;
    const missing = notFound(`note ${noteId}`);
    if (note.expiresAt < now().toISOString()) return missing;
    if (note.scope.kind === 'conversation') return note.scope.conversation === conversationKey(scope.audience) ? found : missing;
    return scope.audience.kind === 'self' ? found : denied('requires_self_audience', 'companion-global notes change only in self turns');
  };

  const rewrite = async (scope: TrustedTurnScope, noteId: string, text: (note: ScratchpadNote) => string): Promise<Result<ScratchpadNote>> => {
    const trusted = requireTrusted(scope);
    if (!trusted.ok) return trusted;
    const note = await writable(scope, noteId);
    if (!note.ok) return note;
    const next = boundedText(text(note.value), 'text', NOTE_MAX);
    if (!next.ok) return next;
    return deps.store.put({ ...note.value, text: next.value, author: authorOf(scope), revision: note.value.revision + 1 }, note.value.revision);
  };

  return {
    async list(scope, input) {
      const trusted = requireTrusted(scope);
      if (!trusted.ok) return trusted;
      return deps.store.list(conversationKey(scope.audience), now().toISOString(), input.limit);
    },

    async add(scope, input) {
      const trusted = requireTrusted(scope);
      if (!trusted.ok) return trusted;
      if (input.global && scope.audience.kind !== 'self') return denied('requires_self_audience', 'companion-global notes are written only in self turns');
      const text = boundedText(input.text, 'text', NOTE_MAX);
      if (!text.ok) return text;
      const at = now();
      return deps.store.put(
        {
          id: deps.ids.next('note'),
          text: text.value,
          scope: input.global ? { kind: 'companion_global' } : { kind: 'conversation', conversation: conversationKey(scope.audience) },
          author: authorOf(scope),
          createdAt: at.toISOString(),
          expiresAt: endOfUtcDay(at),
          revision: 1,
        },
        null,
      );
    },

    replace: (scope, input) => rewrite(scope, input.noteId, () => input.text),

    append: (scope, input) => rewrite(scope, input.noteId, (note) => `${note.text}\n${input.text}`),

    async remove(scope, input) {
      const trusted = requireTrusted(scope);
      if (!trusted.ok) return trusted;
      const note = await writable(scope, input.noteId);
      if (!note.ok) return note;
      const removed = await deps.store.remove(note.value.id, note.value.revision);
      return removed.ok ? ok({ removed: note.value.id }) : removed;
    },
  };
}
