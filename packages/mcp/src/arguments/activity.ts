import { ACTIVITY_STATUSES, FREE_TIME_LANES, SENSITIVITIES } from '../core.ts';
import { NO_ARGUMENTS, limit, optional, required, schema, type ToolArguments } from '../schema.ts';

const ACTIVITY_REVISION = { min: 1, max: 1_000_000 } as const;
const TEMPLATE_REVISION = { min: 0, max: 1_000_000 } as const;
const MINUTES = { min: 1, max: 10_080 } as const;
const MAX_TURNS = { min: 1, max: 16 } as const;

const activityId = required(schema.id('Activity id.'));

export const ACTIVITY_ARGUMENTS: ToolArguments = {
  recent: { limit: limit() },
  get: { activityId },
  start: { purpose: required(schema.nonEmpty('What the activity is for.')) },
  update: {
    activityId,
    expectedRevision: required(schema.integer('Revision the update is based on.', ACTIVITY_REVISION)),
    status: optional(schema.oneOf('New status.', ACTIVITY_STATUSES.filter((s) => s !== 'in_progress'))),
    outcome: optional(schema.nonEmpty('Outcome.')),
    artifacts: optional(
      schema.array(
        'Artifact references.',
        schema.object('One artifact.', { kind: schema.nonEmpty('Artifact kind (1-64).'), ref: schema.nonEmpty('Reference (1-500).') }, ['kind', 'ref']),
      ),
    ),
    note: optional(schema.nonEmpty('Attributed note.')),
  },
};

const runId = required(schema.id('Worker run id.'));

export const AUTOMATA_ARGUMENTS: ToolArguments = {
  spawn: {
    spawnId: required(schema.id('Idempotency key; a retried spawn replays the run.')),
    label: required(schema.nonEmpty('Short label.')),
    task: required(schema.nonEmpty('What the worker should do.')),
    actions: required(schema.strings('Granted actions as tool.action; never wider than this turn.')),
    maxTurns: required(schema.integer('Turn budget.', MAX_TURNS)),
    maxSensitivity: required(schema.oneOf('Sensitivity ceiling; at most this turn’s admission.', SENSITIVITIES)),
  },
  message: { runId, text: required(schema.nonEmpty('Guidance for the worker.')) },
  wait: { runId },
  cancel: { runId },
  status: { runId: optional(schema.id('One run (default: this conversation’s runs).')), limit: limit() },
  discover: { query: required(schema.nonEmpty('Search text over run labels and tasks.')), limit: limit() },
  inspect: { runId },
};

const blockIdOptional = optional(schema.nonEmpty('Free-time block answered (default: none).'));
const lane = optional(schema.oneOf('Lane (default: every lane).', FREE_TIME_LANES));
const templateId = required(schema.nonEmpty('Reflection template id.'));

export const FREE_TIME_ARGUMENTS: ToolArguments = {
  status: NO_ARGUMENTS,
  choose: { blockId: required(schema.nonEmpty('Free-time block id.')), optionId: required(schema.nonEmpty('One of the block’s offered options.')) },
  rest: { blockId: blockIdOptional, lane, minutes: optional(schema.integer('How long to rest.', MINUTES)) },
  defer: { blockId: blockIdOptional, lane, minutes: required(schema.integer('How long to defer.', MINUTES)) },
  scheduled_list: { limit: limit() },
  schedule_prompt: {
    scheduleId: required(schema.id('Idempotency key.')),
    name: required(schema.nonEmpty('Name.')),
    prompt: required(schema.nonEmpty('Prompt shown at that time.')),
    at: required(schema.nonEmpty('Local time, YYYY-MM-DDTHH:MM.')),
    timeZone: required(schema.nonEmpty('IANA time zone.')),
  },
  update_template: {
    templateId,
    expectedRevision: required(schema.integer('Revision the update is based on.', TEMPLATE_REVISION)),
    name: optional(schema.nonEmpty('Name.')),
    prompt: optional(schema.nonEmpty('Template prompt.')),
    schedule: optional(
      schema.anyOf('When the template runs.', [
        schema.object('Manual only.', { kind: { const: 'manual' } }, ['kind']),
        schema.object('Daily.', { kind: { const: 'daily' }, localTime: schema.nonEmpty('HH:MM.'), timeZone: schema.nonEmpty('IANA time zone.') }, [
          'kind',
          'localTime',
          'timeZone',
        ]),
      ]),
    ),
    enabled: optional(schema.boolean('Whether the template runs on its schedule.')),
  },
  run_template: { templateId, runId: required(schema.id('Idempotency key; the same id replays the result.')) },
};

