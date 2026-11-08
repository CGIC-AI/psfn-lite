import { DELETION_JUSTIFICATIONS, LETTER_STATES, MEMORY_KINDS, SENSITIVITIES } from '../core.ts';
import { NO_ARGUMENTS, limit, optional, required, schema, type ToolArguments } from '../schema.ts';

const REVISION = { min: 0, max: 1_000_000 } as const;

const query = required(schema.nonEmpty('Search text.'));
const memoryId = required(schema.id('Memory id.'));
const noteId = required(schema.id('Scratchpad note id.'));
const kind = schema.oneOf('Memory kind.', MEMORY_KINDS);
const sensitivity = schema.oneOf('Sensitivity of the content.', SENSITIVITIES);

export const MEMORY_ARGUMENTS: ToolArguments = {
  search: { query, limit: limit() },
  get: { memoryId },
  shared_background: { contactId: required(schema.id('Contact whose shared background to read.')), limit: limit() },
  census: NO_ARGUMENTS,
  write: {
    writeId: required(schema.id('Idempotency key; a retry with the same content replays the receipt.')),
    kind: required(kind),
    content: required(schema.nonEmpty('What to remember.')),
    sensitivity: required(sensitivity),
    attribution: optional(schema.oneOf('Whose words these are (default companion_authored).', ['companion_authored', 'participant_attributed'])),
    occurredAt: optional(schema.instant('When it happened.')),
  },
  import: {
    batchId: required(schema.id('Idempotency key for the batch.')),
    records: required(
      schema.array(
        'Records to import.',
        schema.object(
          'One record.',
          { kind, content: schema.nonEmpty('Content.'), sensitivity, occurredAt: schema.instant('When it happened.') },
          ['kind', 'content', 'sensitivity', 'occurredAt'],
        ),
      ),
    ),
  },
  patch: {
    memoryId,
    content: required(schema.nonEmpty('Replacement content.')),
    reason: required(schema.nonEmpty('Why it changes; kept with the patch event.')),
    expectedRevision: optional(schema.integer('Revision the patch is based on.', REVISION)),
  },
  propose_delete: {
    memoryId,
    justification: required(schema.oneOf('Why the memory should go.', DELETION_JUSTIFICATIONS)),
    explanation: required(schema.nonEmpty('Explanation for the reviewer.')),
  },
  restore: { memoryId },
  scratchpad_list: { limit: limit() },
  scratchpad_add: { text: required(schema.nonEmpty('Note text.')), global: optional(schema.boolean('Visible across conversations of this audience (default false).')) },
  scratchpad_replace: { noteId, text: required(schema.nonEmpty('New text.')) },
  scratchpad_append: { noteId, text: required(schema.nonEmpty('Text to append.')) },
  scratchpad_remove: { noteId },
};

const episodeId = required(schema.id('Episode id.'));

export const EPISODE_ARGUMENTS: ToolArguments = {
  search: { query, limit: limit() },
  get: { episodeId },
  timeline: {
    date: optional(schema.text('A day, YYYY-MM-DD; or give from and to.')),
    from: optional(schema.instant('Range start, with to.')),
    to: optional(schema.instant('Range end, with from.')),
    limit: limit(),
  },
  author_meaning: {
    episodeId,
    text: required(schema.nonEmpty('The meaning, in the companion’s words.')),
    expectedRevision: required(schema.integer('Episode revision the meaning is written against.', REVISION)),
    source: optional(schema.oneOf('How the meaning was reached (default companion_direct).', ['companion_direct', 'companion_reflection'])),
  },
};

const path = required(schema.nonEmpty('Journal note path.'));
const letterId = required(schema.id('Letter id.'));

export const JOURNAL_ARGUMENTS: ToolArguments = {
  list: { limit: limit() },
  read: { path },
  search: { query, limit: limit() },
  write: {
    path,
    body: required(schema.nonEmpty('Full note body.')),
    expectedRevision: optional(schema.integer('Revision being replaced; omit to create.', REVISION)),
  },
  append: { path, text: required(schema.nonEmpty('Text to append.')) },
  reflections_list: { limit: limit() },
  reflections_read: { reflectionId: required(schema.id('Reflection id.')) },
  letter_compose: {
    letterId: required(schema.id('Letter id; composing again with the same id and content replays.')),
    subject: required(schema.nonEmpty('Subject.')),
    body: required(schema.nonEmpty('Body.')),
    draft: optional(schema.boolean('Keep as a draft (default false).')),
  },
  letter_list: {
    direction: optional(schema.oneOf('Inbox or outbox (default both).', ['inbox', 'outbox'])),
    states: optional(schema.array('Letter states to include.', schema.oneOf('Letter state.', LETTER_STATES))),
    limit: limit(),
  },
  letter_read: { letterId },
  letter_place: { letterId },
  letter_archive: { letterId },
};
