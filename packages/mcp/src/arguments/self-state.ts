import {
  CARE_REMINDER_KINDS,
  CARE_REMINDER_SCHEDULES,
  CONCERN_EVIDENCE_KINDS,
  CONCERN_PRIORITIES,
  CONCERN_TRANSITION_TARGETS,
  SENSITIVITIES,
} from '../core.ts';
import { NO_ARGUMENTS, limit, optional, required, schema, type ToolArguments } from '../schema.ts';

const REVISION = { min: 1, max: 1_000_000 } as const;

export const EMOTION_ARGUMENTS: ToolArguments = {
  read: NO_ARGUMENTS,
  appraisals: { limit: limit() },
  self_report: {
    text: required(schema.nonEmpty('How the companion describes its own state.')),
    supersedes: optional(schema.nonEmpty('Id of an earlier self-report this one corrects.')),
  },
};

const evidenceRefs = optional(
  schema.array(
    'References to the evidence.',
    schema.object(
      'One evidence reference.',
      {
        kind: schema.oneOf('What the reference points at.', CONCERN_EVIDENCE_KINDS),
        ref: schema.nonEmpty('The reference.'),
        sensitivity: schema.oneOf('Sensitivity of what it points at (default: the concern’s).', SENSITIVITIES),
      },
      ['kind', 'ref'],
    ),
  ),
);
const concernId = required(schema.nonEmpty('Concern id.'));
const expectedRevision = required(schema.integer('Revision the change is based on.', REVISION));
const outcome = optional(schema.nonEmpty('What happened.'));
const nextReviewAt = optional(schema.instant('When to look at it again.'));
const channelId = optional(schema.id('Conversation channel to target (default: the current one).'));

export const CONCERN_ARGUMENTS: ToolArguments = {
  list: { includeClosed: optional(schema.boolean('Include resolved and dropped concerns (default false).')), limit: limit() },
  create: {
    text: required(schema.nonEmpty('The concern.')),
    priority: optional(schema.oneOf('Priority (default medium).', CONCERN_PRIORITIES)),
    sensitivity: optional(schema.oneOf('Sensitivity of the concern.', SENSITIVITIES)),
    evidenceRefs,
    nextReviewAt,
  },
  resolve: { concernId, expectedRevision, outcome, evidenceRefs },
  transition: { concernId, to: required(schema.oneOf('Target state.', CONCERN_TRANSITION_TARGETS)), expectedRevision, outcome, evidenceRefs, nextReviewAt },
  follow_up_list: { includeDone: optional(schema.boolean('Include delivered and cancelled follow-ups (default false).')), limit: limit() },
  follow_up_create: {
    content: required(schema.nonEmpty('What to follow up on.')),
    dueAt: required(schema.nonEmpty('When it is due (ISO 8601 instant).')),
    channelId,
    concernId: optional(schema.nonEmpty('Concern it belongs to.')),
  },
  follow_up_activate: { followUpId: required(schema.nonEmpty('Follow-up id.')), expectedRevision },
  reminder_create: {
    kind: required(schema.oneOf('Reminder kind.', CARE_REMINDER_KINDS)),
    title: required(schema.nonEmpty('Title.')),
    content: required(schema.nonEmpty('Message delivered.')),
    schedule: optional(schema.oneOf('Once or daily (default once).', CARE_REMINDER_SCHEDULES)),
    dueAt: required(schema.nonEmpty('First delivery time (ISO 8601 instant).')),
    channelId,
  },
};
