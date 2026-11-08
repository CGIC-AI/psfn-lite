import { CARE_REMINDER_KINDS, CARE_REMINDER_SCHEDULES } from '../intention/index.ts';
import { FREE_TIME_LANES, type TemplateSchedule } from '../scheduler/index.ts';
import { isRecord } from '../shared/index.ts';
import { LIMIT, withArgs, type ArgReader } from './arguments.ts';
import type { CareReminderService } from './care-reminder-service.ts';
import type { ActionHandler } from './dispatch.ts';
import type { FreeTimeService } from './free-time-service.ts';
import type { ScheduleService } from './schedule-service.ts';

const MINUTES = { min: 1, max: 10_080 } as const;
const REVISION = { min: 0, max: 1_000_000 } as const;

type Handlers = Readonly<Record<string, ActionHandler>>;

/** `free_time` tool actions: inspection and the companion's own choice, rest and self-scheduled time. */
export function freeTimeHandlers(freeTime: FreeTimeService, schedule: ScheduleService): Handlers {
  return {
    status: (scope, args) => withArgs(args, [], () => null, () => freeTime.status(scope)),
    choose: (scope, args) =>
      withArgs(args, ['blockId', 'optionId'], (a) => ({ blockId: a.string('blockId'), optionId: a.string('optionId') }), (input) => freeTime.choose(scope, input)),
    rest: (scope, args) =>
      withArgs(
        args,
        ['blockId', 'lane', 'minutes'],
        (a) => ({ blockId: a.optionalString('blockId'), lane: a.optionalOneOf('lane', FREE_TIME_LANES), minutes: a.optionalInteger('minutes', MINUTES) }),
        (input) => freeTime.rest(scope, input),
      ),
    defer: (scope, args) =>
      withArgs(
        args,
        ['blockId', 'lane', 'minutes'],
        (a) => ({ blockId: a.optionalString('blockId'), lane: a.optionalOneOf('lane', FREE_TIME_LANES), minutes: a.integer('minutes', MINUTES) }),
        (input) => freeTime.defer(scope, input),
      ),
    scheduled_list: (scope, args) => withArgs(args, ['limit'], (a) => ({ limit: a.integer('limit', LIMIT) }), (input) => schedule.list(scope, input)),
    schedule_prompt: (scope, args) =>
      withArgs(
        args,
        ['scheduleId', 'name', 'prompt', 'at', 'timeZone'],
        (a) => ({ key: a.id('schedule', 'scheduleId'), name: a.string('name'), prompt: a.string('prompt'), at: a.string('at'), timeZone: a.string('timeZone') }),
        (input) => schedule.schedulePrompt(scope, input),
      ),
    update_template: (scope, args) =>
      withArgs(
        args,
        ['templateId', 'expectedRevision', 'name', 'prompt', 'schedule', 'enabled'],
        (a) => ({
          templateId: a.string('templateId'),
          expectedRevision: a.integer('expectedRevision', REVISION),
          name: a.optionalString('name'),
          prompt: a.optionalString('prompt'),
          schedule: a.has('schedule') ? templateSchedule(a, args['schedule']) : null,
          enabled: a.optionalBoolean('enabled') ?? null,
        }),
        (input) => schedule.updateTemplate(scope, input),
      ),
    run_template: (scope, args) =>
      withArgs(args, ['templateId', 'runId'], (a) => ({ templateId: a.string('templateId'), key: a.id('run', 'runId') }), (input) => schedule.runTemplate(scope, input)),
  };
}

function templateSchedule(a: ArgReader, raw: unknown): TemplateSchedule {
  if (isRecord(raw) && raw['kind'] === 'manual' && Object.keys(raw).length === 1) return { kind: 'manual' };
  if (
    isRecord(raw) &&
    raw['kind'] === 'daily' &&
    Object.keys(raw).every((k) => ['kind', 'localTime', 'timeZone'].includes(k)) &&
    typeof raw['localTime'] === 'string' &&
    typeof raw['timeZone'] === 'string'
  ) {
    return { kind: 'daily', localTime: raw['localTime'], timeZone: raw['timeZone'] };
  }
  a.issues.push('schedule must be { kind: "manual" } or { kind: "daily", localTime: "HH:MM", timeZone }');
  return { kind: 'manual' };
}

/** `concern.reminder_create`, served by the care reminder store the scheduler delivers from. */
export function reminderHandlers(reminders: CareReminderService): Handlers {
  return {
    reminder_create: (scope, args) =>
      withArgs(
        args,
        ['kind', 'title', 'content', 'schedule', 'dueAt', 'channelId'],
        (a) => ({
          kind: a.oneOf('kind', CARE_REMINDER_KINDS),
          title: a.string('title'),
          content: a.string('content'),
          schedule: a.oneOf('schedule', CARE_REMINDER_SCHEDULES, 'once'),
          dueAt: a.string('dueAt'),
          channelId: a.optionalId('channel', 'channelId'),
        }),
        (input) => reminders.create(scope, input),
      ),
  };
}
