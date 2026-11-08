import {
  LETTER_STATES,
  archiveLetter,
  letterVisibleTo,
  placeLetter,
  readLetter,
  type Letter,
  type LetterEvent,
  type LetterPort,
  type LetterState,
} from '../journals/index.ts';
import { conflict, invalid, isNonEmptyString, notFound, ok, type Clock, type Result } from '../shared/index.ts';
import { boundedText, requireTrusted } from './memory-scope.ts';
import type { TrustedTurnScope } from './trusted-scope.ts';

const SUBJECT_MAX = 200;
const BODY_MAX = 20_000;

export interface LetterService {
  compose(
    scope: TrustedTurnScope,
    input: { readonly letterId: string; readonly subject: string; readonly body: string; readonly draft: boolean },
  ): Promise<Result<{ readonly letter: Letter; readonly created: boolean }>>;
  list(
    scope: TrustedTurnScope,
    input: { readonly direction: 'inbox' | 'outbox' | null; readonly states: readonly LetterState[] | null; readonly limit: number },
  ): Promise<Result<readonly Letter[]>>;
  read(scope: TrustedTurnScope, input: { readonly letterId: string }): Promise<Result<Letter>>;
  place(scope: TrustedTurnScope, input: { readonly letterId: string }): Promise<Result<Letter>>;
  archive(scope: TrustedTurnScope, input: { readonly letterId: string }): Promise<Result<Letter>>;
}

/** Host-side delivery of the Partner's letters into the bin. */
export interface LetterAdministration {
  deliverFromPartner(input: { readonly letterId: string; readonly subject: string; readonly body: string }): Promise<Result<Letter>>;
}

/**
 * The letter bin (donor `src/core/letters/service.ts`): slow private
 * correspondence between the companion and the Partner, without push or
 * external delivery. Every composition, placement, reading and archival is
 * recorded as the bin's own lived history. The companion never sees the
 * Partner's drafts.
 */
export function createLetterService(deps: { readonly letters: LetterPort; readonly clock: Clock }): LetterService {
  const visible = async (letterId: string): Promise<Result<Letter>> => {
    const found = await deps.letters.get(letterId);
    if (!found.ok) return found.error.kind === 'not_found' ? notFound(`letter ${letterId}`) : found;
    return letterVisibleTo(found.value, 'companion') ? found : notFound(`letter ${letterId}`);
  };

  const transition = async (
    scope: TrustedTurnScope,
    letterId: string,
    kind: LetterEvent['kind'],
    change: (letter: Letter, at: string) => Result<Letter>,
  ): Promise<Result<Letter>> => {
    const trusted = requireTrusted(scope);
    if (!trusted.ok) return trusted;
    const letter = await visible(letterId);
    if (!letter.ok) return letter;
    const at = deps.clock.now().toISOString();
    const next = change(letter.value, at);
    if (!next.ok) return next;
    return deps.letters.record(next.value, letter.value.revision, { letterId, kind, by: 'companion', at });
  };

  return {
    async compose(scope, input) {
      const trusted = requireTrusted(scope);
      if (!trusted.ok) return trusted;
      const subject = boundedText(input.subject, 'subject', SUBJECT_MAX);
      if (!subject.ok) return subject;
      const body = boundedText(input.body, 'body', BODY_MAX);
      if (!body.ok) return body;
      const at = deps.clock.now().toISOString();
      const state = input.draft ? 'draft' : 'placed';
      const created = await deps.letters.create(
        {
          id: input.letterId,
          author: 'companion',
          recipient: 'partner',
          subject: subject.value,
          body: body.value,
          state,
          createdAt: at,
          updatedAt: at,
          placedAt: input.draft ? null : at,
          readAt: null,
          archivedAt: null,
          revision: 1,
        },
        { letterId: input.letterId, kind: 'composed', by: 'companion', at },
      );
      if (!created.ok || created.value.created) return created;
      const existing = created.value.letter;
      if (existing.author !== 'companion' || existing.subject !== subject.value || existing.body !== body.value) {
        return conflict('idempotency_mismatch', `letter id ${input.letterId} was already used for another letter`);
      }
      return created;
    },

    async list(scope, input) {
      const trusted = requireTrusted(scope);
      if (!trusted.ok) return trusted;
      const states = input.states ?? LETTER_STATES;
      const letters = await deps.letters.list({
        author: input.direction === 'outbox' ? 'companion' : input.direction === 'inbox' ? 'partner' : null,
        recipient: null,
        states,
        limit: input.limit,
      });
      return letters.ok ? ok(letters.value.filter((l) => letterVisibleTo(l, 'companion'))) : letters;
    },

    read: (scope, input) => transition(scope, input.letterId, 'read', (letter, at) => readLetter(letter, 'companion', at)),
    place: (scope, input) => transition(scope, input.letterId, 'placed', (letter, at) => placeLetter(letter, 'companion', at)),
    archive: (scope, input) => transition(scope, input.letterId, 'archived', (letter, at) => archiveLetter(letter, 'companion', at)),
  };
}

export function createLetterAdministration(deps: { readonly letters: LetterPort; readonly clock: Clock }): LetterAdministration {
  return {
    async deliverFromPartner(input) {
      if (!isNonEmptyString(input.subject) || !isNonEmptyString(input.body)) return invalid('a letter needs a subject and a body');
      const at = deps.clock.now().toISOString();
      const created = await deps.letters.create(
        {
          id: input.letterId,
          author: 'partner',
          recipient: 'companion',
          subject: input.subject.trim(),
          body: input.body.trim(),
          state: 'placed',
          createdAt: at,
          updatedAt: at,
          placedAt: at,
          readAt: null,
          archivedAt: null,
          revision: 1,
        },
        { letterId: input.letterId, kind: 'composed', by: 'partner', at },
      );
      if (!created.ok) return created;
      if (!created.value.created && (created.value.letter.author !== 'partner' || created.value.letter.body !== input.body.trim())) {
        return conflict('idempotency_mismatch', `letter id ${input.letterId} was already used for another letter`);
      }
      return ok(created.value.letter);
    },
  };
}
