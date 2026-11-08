import { defineTool, type ActionDescriptor } from '../shared/index.ts';

const CHOOSER = 'src/core/scheduler/free-time-chooser.ts';
const REST_POLICY = 'src/core/scheduler/rest-window-policy.ts';
const SCHEDULE_TOOL = 'src/core/scheduler/schedule-tool.ts';

const CHOICE_RATIONALE =
  'Donor free-time choice was a tool-less JSON model call; Lite makes inspection and choice governed actions.';

function selfChoice(name: string, summary: string): ActionDescriptor {
  return {
    name,
    summary,
    access: 'write',
    privacy: 'companion_private',
    admission: 'confidential',
    restrictions: ['companion_authored', 'self_audience_only', 'idempotent'],
    workers: 'denied',
    inference: 'none',
    donor: { kind: 'lite_new', rationale: CHOICE_RATIONALE, related: [CHOOSER, REST_POLICY, 'src/core/scheduler/free-time.ts'] },
  };
}

function scheduled(name: string, summary: string, access: 'read' | 'write'): ActionDescriptor {
  return {
    name,
    summary,
    access,
    privacy: 'companion_private',
    admission: 'confidential',
    restrictions: access === 'read' ? [] : ['companion_authored', 'idempotent'],
    workers: access === 'read' ? 'allowed' : 'denied',
    inference: 'none',
    donor: { kind: 'donor', paths: [SCHEDULE_TOOL] },
  };
}

export const freeTimeTool = defineTool({
  name: 'free_time',
  domain: 'scheduler',
  summary: 'Free time, rest and self-directed scheduled time.',
  actions: [
    {
      name: 'status',
      summary: 'Rest state per lane, last blocks and gate reasons, with failures labelled as failures.',
      access: 'read',
      privacy: 'companion_private',
      admission: 'confidential',
      restrictions: [],
      workers: 'allowed',
      inference: 'none',
      donor: { kind: 'lite_new', rationale: CHOICE_RATIONALE, related: [CHOOSER, REST_POLICY] },
    },
    selfChoice('choose', 'Select one pre-built free-time option.'),
    selfChoice('rest', 'Rest for this period; recorded durably so no further prompting happens.'),
    selfChoice('defer', 'Defer free time to later without resting.'),
    scheduled('scheduled_list', 'Scheduled self-prompts and reflection templates.', 'read'),
    scheduled('schedule_prompt', 'Schedule a one-shot self-prompt with an explicit time zone.', 'write'),
    scheduled('update_template', 'Update a reflection template; rolls back if rescheduling fails.', 'write'),
    {
      name: 'run_template',
      summary: 'Run a reflection template now, deferred if the companion is busy.',
      access: 'write',
      privacy: 'companion_private',
      admission: 'confidential',
      restrictions: ['companion_authored', 'idempotent'],
      workers: 'denied',
      inference: 'may_call_model',
      donor: { kind: 'donor', paths: [SCHEDULE_TOOL, 'src/core/scheduler/reflection-policy.ts'] },
    },
  ],
});
