import { LETTER_STATES, type LetterState } from '../journals/index.ts';
import { DELETION_JUSTIFICATIONS, MEMORY_KINDS, type MemoryKind } from '../memory/index.ts';
import { SENSITIVITIES, isRecord, type Sensitivity } from '../shared/index.ts';
import { LIMIT, withArgs, type ArgReader } from './arguments.ts';
import type { ActionHandler, ActionHandlers } from './dispatch.ts';
import type { EpisodeService } from './episode-service.ts';
import type { JournalService } from './journal-service.ts';
import type { LetterService } from './letter-service.ts';
import { parseInstant } from './memory-scope.ts';
import type { MemoryService } from './memory-service.ts';
import type { ScratchpadService } from './scratchpad-service.ts';

const REVISION = { min: 0, max: 1_000_000 } as const;
const DAY_MS = 86_400_000;

type Handlers = Readonly<Record<string, ActionHandler>>;

/** `memory` tool actions over the memory and scratchpad services. */
export function memoryHandlers(memory: MemoryService, scratchpad: ScratchpadService): Handlers {
  return {
    search: (scope, args) =>
      withArgs(args, ['query', 'limit'], (a) => ({ query: a.string('query'), limit: a.integer('limit', LIMIT) }), (input) => memory.search(scope, input)),
    get: (scope, args) => withArgs(args, ['memoryId'], (a) => ({ memoryId: a.id('memory', 'memoryId') }), (input) => memory.get(scope, input)),
    shared_background: (scope, args) =>
      withArgs(
        args,
        ['contactId', 'limit'],
        (a) => ({ contactId: a.id('contact', 'contactId'), limit: a.integer('limit', LIMIT) }),
        (input) => memory.sharedBackground(scope, input),
      ),
    census: (scope, args) => withArgs(args, [], () => null, () => memory.census(scope)),
    write: (scope, args) =>
      withArgs(
        args,
        ['writeId', 'kind', 'content', 'sensitivity', 'attribution', 'occurredAt'],
        (a) => ({
          writeId: a.id('write', 'writeId'),
          kind: a.oneOf('kind', MEMORY_KINDS),
          content: a.string('content'),
          sensitivity: a.oneOf('sensitivity', SENSITIVITIES),
          // Documented fallback: the companion records in its own words unless it says a participant said it.
          attribution: a.oneOf('attribution', ['companion_authored', 'participant_attributed'] as const, 'companion_authored'),
          occurredAt: optionalInstant(a, 'occurredAt'),
        }),
        (input) => memory.write(scope, input),
      ),
    import: (scope, args) =>
      withArgs(
        args,
        ['batchId', 'records'],
        (a) => ({ batchId: a.id('batch', 'batchId'), records: importRecords(a, args['records']) }),
        (input) => memory.import(scope, input),
      ),
    patch: (scope, args) =>
      withArgs(
        args,
        ['memoryId', 'content', 'reason', 'expectedRevision'],
        (a) => ({
          memoryId: a.id('memory', 'memoryId'),
          content: a.string('content'),
          reason: a.string('reason'),
          expectedRevision: a.optionalInteger('expectedRevision', REVISION),
        }),
        (input) => memory.patch(scope, input),
      ),
    propose_delete: (scope, args) =>
      withArgs(
        args,
        ['memoryId', 'justification', 'explanation'],
        (a) => ({
          memoryId: a.id('memory', 'memoryId'),
          justification: a.oneOf('justification', DELETION_JUSTIFICATIONS),
          explanation: a.string('explanation'),
        }),
        (input) => memory.proposeDelete(scope, input),
      ),
    restore: (scope, args) => withArgs(args, ['memoryId'], (a) => ({ memoryId: a.id('memory', 'memoryId') }), (input) => memory.restore(scope, input)),
    scratchpad_list: (scope, args) => withArgs(args, ['limit'], (a) => ({ limit: a.integer('limit', LIMIT) }), (input) => scratchpad.list(scope, input)),
    scratchpad_add: (scope, args) =>
      withArgs(args, ['text', 'global'], (a) => ({ text: a.string('text'), global: a.boolean('global', false) }), (input) => scratchpad.add(scope, input)),
    scratchpad_replace: (scope, args) =>
      withArgs(args, ['noteId', 'text'], (a) => ({ noteId: a.id('note', 'noteId'), text: a.string('text') }), (input) => scratchpad.replace(scope, input)),
    scratchpad_append: (scope, args) =>
      withArgs(args, ['noteId', 'text'], (a) => ({ noteId: a.id('note', 'noteId'), text: a.string('text') }), (input) => scratchpad.append(scope, input)),
    scratchpad_remove: (scope, args) =>
      withArgs(args, ['noteId'], (a) => ({ noteId: a.id('note', 'noteId') }), (input) => scratchpad.remove(scope, input)),
  };
}

/** `episode` tool actions over the episode service. */
export function episodeHandlers(episodes: EpisodeService): Handlers {
  return {
    search: (scope, args) =>
      withArgs(args, ['query', 'limit'], (a) => ({ query: a.string('query'), limit: a.integer('limit', LIMIT) }), (input) => episodes.search(scope, input)),
    get: (scope, args) => withArgs(args, ['episodeId'], (a) => ({ episodeId: a.id('episode', 'episodeId') }), (input) => episodes.get(scope, input)),
    timeline: (scope, args) =>
      withArgs(args, ['date', 'from', 'to', 'limit'], (a) => ({ ...timelineRange(a), limit: a.integer('limit', LIMIT) }), (input) => episodes.timeline(scope, input)),
    author_meaning: (scope, args) =>
      withArgs(
        args,
        ['episodeId', 'text', 'expectedRevision', 'source'],
        (a) => ({
          episodeId: a.id('episode', 'episodeId'),
          text: a.string('text'),
          expectedRevision: a.integer('expectedRevision', REVISION),
          source: a.oneOf('source', ['companion_direct', 'companion_reflection'] as const, 'companion_direct'),
        }),
        (input) => episodes.authorMeaning(scope, input),
      ),
  };
}

/** `journal` tool actions over the journal and letter services. */
export function journalHandlers(journal: JournalService, letters: LetterService): Handlers {
  return {
    list: (scope, args) => withArgs(args, ['limit'], (a) => ({ limit: a.integer('limit', LIMIT) }), (input) => journal.list(scope, input)),
    read: (scope, args) => withArgs(args, ['path'], (a) => ({ path: a.string('path') }), (input) => journal.read(scope, input)),
    search: (scope, args) =>
      withArgs(args, ['query', 'limit'], (a) => ({ query: a.string('query'), limit: a.integer('limit', LIMIT) }), (input) => journal.search(scope, input)),
    write: (scope, args) =>
      withArgs(
        args,
        ['path', 'body', 'expectedRevision'],
        (a) => ({ path: a.string('path'), body: a.string('body'), expectedRevision: a.optionalInteger('expectedRevision', REVISION) }),
        (input) => journal.write(scope, input),
      ),
    append: (scope, args) =>
      withArgs(args, ['path', 'text'], (a) => ({ path: a.string('path'), text: a.string('text') }), (input) => journal.append(scope, input)),
    reflections_list: (scope, args) =>
      withArgs(args, ['limit'], (a) => ({ limit: a.integer('limit', LIMIT) }), (input) => journal.reflectionsList(scope, input)),
    reflections_read: (scope, args) =>
      withArgs(args, ['reflectionId'], (a) => ({ reflectionId: a.id('reflection', 'reflectionId') }), (input) => journal.reflectionsRead(scope, input)),
    letter_compose: (scope, args) =>
      withArgs(
        args,
        ['letterId', 'subject', 'body', 'draft'],
        (a) => ({ letterId: a.id('letter', 'letterId'), subject: a.string('subject'), body: a.string('body'), draft: a.boolean('draft', false) }),
        (input) => letters.compose(scope, input),
      ),
    letter_list: (scope, args) =>
      withArgs(
        args,
        ['direction', 'states', 'limit'],
        (a) => ({
          direction: a.optionalOneOf('direction', ['inbox', 'outbox'] as const),
          states: a.has('states') ? letterStates(a, args['states']) : null,
          limit: a.integer('limit', LIMIT),
        }),
        (input) => letters.list(scope, input),
      ),
    letter_read: (scope, args) => withArgs(args, ['letterId'], (a) => ({ letterId: a.id('letter', 'letterId') }), (input) => letters.read(scope, input)),
    letter_place: (scope, args) => withArgs(args, ['letterId'], (a) => ({ letterId: a.id('letter', 'letterId') }), (input) => letters.place(scope, input)),
    letter_archive: (scope, args) =>
      withArgs(args, ['letterId'], (a) => ({ letterId: a.id('letter', 'letterId') }), (input) => letters.archive(scope, input)),
  };
}

/**
 * Handlers for the memory, episode and journal tools, keyed as the inventory
 * names them. Hosts merge them with `createContinuityHandlers` (the tool
 * names are disjoint) and pass the result to `createToolDispatcher`.
 */
export function createMemoryHandlers(services: {
  readonly memory: MemoryService;
  readonly scratchpad: ScratchpadService;
  readonly episodes: EpisodeService;
  readonly journal: JournalService;
  readonly letters: LetterService;
}): ActionHandlers {
  return {
    memory: memoryHandlers(services.memory, services.scratchpad),
    episode: episodeHandlers(services.episodes),
    journal: journalHandlers(services.journal, services.letters),
  };
}

function optionalInstant(reader: ArgReader, key: string): string | null {
  const raw = reader.optionalString(key);
  if (raw === null) return null;
  const parsed = parseInstant(raw, key);
  if (parsed.ok) return parsed.value;
  reader.issues.push(...(parsed.error.kind === 'invalid' ? parsed.error.issues : [`${key} is invalid`]));
  return null;
}

function timelineRange(reader: ArgReader): { readonly from: string; readonly to: string } {
  const date = reader.optionalString('date');
  const from = optionalInstant(reader, 'from');
  const to = optionalInstant(reader, 'to');
  if (date !== null) {
    if (from !== null || to !== null) reader.issues.push('give either date or from/to, not both');
    const start = parseInstant(date, 'date');
    if (!start.ok || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      reader.issues.push('date must be YYYY-MM-DD');
      return { from: '', to: '' };
    }
    return { from: start.value, to: new Date(Date.parse(start.value) + DAY_MS - 1).toISOString() };
  }
  if (from === null || to === null) reader.issues.push('timeline needs date, or both from and to');
  return { from: from ?? '', to: to ?? '' };
}

function importRecords(
  reader: ArgReader,
  raw: unknown,
): { readonly kind: MemoryKind; readonly content: string; readonly sensitivity: Sensitivity; readonly occurredAt: string }[] {
  if (!Array.isArray(raw)) {
    reader.issues.push('records must be an array');
    return [];
  }
  const out: { kind: MemoryKind; content: string; sensitivity: Sensitivity; occurredAt: string }[] = [];
  raw.forEach((item: unknown, index) => {
    const at = `records[${index}]`;
    if (!isRecord(item)) {
      reader.issues.push(`${at} must be an object`);
      return;
    }
    const unknown = Object.keys(item).filter((k) => !['kind', 'content', 'sensitivity', 'occurredAt'].includes(k));
    if (unknown.length > 0) reader.issues.push(`${at} has unknown fields: ${unknown.join(', ')}`);
    const { kind, content, sensitivity, occurredAt } = item;
    if (!(MEMORY_KINDS as readonly unknown[]).includes(kind)) reader.issues.push(`${at}.kind is unknown`);
    if (typeof content !== 'string' || content.trim().length === 0) reader.issues.push(`${at}.content must be a non-empty string`);
    if (!(SENSITIVITIES as readonly unknown[]).includes(sensitivity)) reader.issues.push(`${at}.sensitivity is unknown`);
    const when = typeof occurredAt === 'string' ? parseInstant(occurredAt, `${at}.occurredAt`) : null;
    if (when === null || !when.ok) reader.issues.push(`${at}.occurredAt must be a date or zoned ISO instant`);
    if (when?.ok === true && typeof content === 'string') {
      out.push({ kind: kind as MemoryKind, content, sensitivity: sensitivity as Sensitivity, occurredAt: when.value });
    }
  });
  return out;
}

function letterStates(reader: ArgReader, raw: unknown): LetterState[] {
  if (!Array.isArray(raw) || raw.length === 0 || !raw.every((s) => (LETTER_STATES as readonly unknown[]).includes(s))) {
    reader.issues.push(`states must be a non-empty array of ${LETTER_STATES.join(', ')}`);
    return [];
  }
  return raw as LetterState[];
}
