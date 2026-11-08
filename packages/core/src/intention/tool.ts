import { defineTool, type ActionDescriptor } from '../shared/index.ts';

const ORIENT_TOOL = 'src/faculties/core-memory/tools.ts';
const INTENTION_TOOLS = 'src/core/intention/tools.ts';
const CONCERN_VISIBILITY = 'src/core/intention/concern-visibility.ts';
const SCHEDULE_TOOL = 'src/core/scheduler/schedule-tool.ts';

function concernWrite(name: string, summary: string): ActionDescriptor {
  return {
    name,
    summary,
    access: 'write',
    privacy: 'audience_scoped',
    admission: 'public',
    restrictions: ['companion_authored', 'visibility_gated'],
    workers: 'denied',
    inference: 'none',
    donor: { kind: 'donor', paths: [ORIENT_TOOL, INTENTION_TOOLS] },
  };
}

function followUpWrite(name: string, summary: string, extra: ActionDescriptor['restrictions']): ActionDescriptor {
  return {
    name,
    summary,
    access: 'write',
    privacy: 'conversation_scoped',
    admission: 'public',
    restrictions: ['visibility_gated', ...extra],
    workers: 'denied',
    inference: 'none',
    donor: { kind: 'donor', paths: [SCHEDULE_TOOL, 'src/core/intention/pending-follow-ups.ts'] },
  };
}

export const concernTool = defineTool({
  name: 'concern',
  domain: 'intention',
  summary: 'Open concerns, follow-ups and care reminders the companion holds.',
  actions: [
    {
      name: 'list',
      summary: 'Concerns visible to this audience; inadmissible evidence hides a concern.',
      access: 'read',
      privacy: 'audience_scoped',
      admission: 'public',
      restrictions: ['visibility_gated'],
      workers: 'allowed',
      inference: 'none',
      donor: { kind: 'donor', paths: [ORIENT_TOOL, CONCERN_VISIBILITY] },
    },
    concernWrite('create', 'Create a companion-owned concern; the model cannot set source, owner or candidate status.'),
    concernWrite('resolve', 'Resolve visible concerns; affect snapshot only from trusted fresh telemetry.'),
    concernWrite('transition', 'Move a visible concern between statuses (gated, unlike the donor).'),
    {
      name: 'follow_up_list',
      summary: 'Pending follow-ups targeting readable channels.',
      access: 'read',
      privacy: 'conversation_scoped',
      admission: 'public',
      restrictions: ['visibility_gated'],
      workers: 'allowed',
      inference: 'none',
      donor: { kind: 'donor', paths: [SCHEDULE_TOOL, 'src/core/scheduler/schedule-visibility.ts'] },
    },
    followUpWrite('follow_up_create', 'Create a follow-up into a readable channel; idempotent by content and due time.', [
      'companion_authored',
      'idempotent',
    ]),
    followUpWrite('follow_up_activate', 'Activate a visible follow-up now.', ['foreground_only']),
    {
      name: 'reminder_create',
      summary: 'Create a once or daily care reminder for a visible conversation; the scheduler delivers it through the host.',
      access: 'write',
      privacy: 'conversation_scoped',
      admission: 'public',
      restrictions: ['companion_authored', 'visibility_gated', 'idempotent'],
      workers: 'denied',
      inference: 'none',
      donor: { kind: 'donor', paths: [SCHEDULE_TOOL, 'src/core/intention/care-reminders.ts'] },
    },
  ],
});
