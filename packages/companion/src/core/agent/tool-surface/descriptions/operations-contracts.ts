import { action, type CanonicalToolSurfaceContract } from './contracts.js';

export const OPERATIONS_TOOL_CONTRACTS = {
  schedule: {
    purpose: 'Manage durable follow-ups, reminders, heartbeat templates, and one-shot scheduled prompts.',
    actions: [
      action('list', [], ['limit', 'contact_id', 'include_activated', 'include_completed', 'include_dismissed']),
      action('create_follow_up', ['content', 'channel_id', 'channel_type'], ['priority', 'timing', 'due_at', 'contact_id', 'source_message_id', 'context_summary', 'wake_conditions']),
      action('activate_follow_up', ['follow_up_id'], ['activation_reason']),
      action('create_reminder', ['title', 'content', 'due_at', 'channel_id', 'channel_type'], ['kind', 'classification', 'reminder_schedule', 'reason', 'contact_id', 'source_message_id']),
      action('trigger_reminder', ['reminder_id']), action('list_templates'),
      action('update_template', [], ['name', 'prompt', 'interval_ms', 'enabled', 'internal_state_input', 'mode', 'deliberation'], {
        id: 'update_template', requiredAnyOf: [['template_id'], ['id', 'name', 'prompt', 'interval_ms']],
        rule: 'template_id updates an existing template; the id branch creates a new template',
      }),
      action('run_template', ['template_id'], ['defer_if_busy']),
      action('schedule_prompt', ['name', 'prompt'], [], { id: 'schedule_prompt', requiredAnyOf: [['delay_minutes'], ['run_at']], rule: 'supply exactly one timing field' }),
    ],
    output: 'It returns durable identifiers or run state and does not replace untimed open threads managed through orient.',
    guidance: 'Do not invent registry-category verbs; only the concrete actions above are callable.',
    example: { action: 'schedule_prompt', name: 'check seedlings', prompt: 'Review the greenhouse notes.', delay_minutes: 60 },
  },
  north_star: {
    purpose: 'Maintain a small ordered set of long-horizon guiding intentions.',
    actions: [
      action('list'), action('create', ['title', 'content'], ['scope', 'enabled']),
      action('update', ['item_id'], ['title', 'content', 'scope', 'enabled'], { id: 'update', rule: 'include at least one changed field' }),
      action('delete', ['item_id']), action('reorder', ['item_ids']),
    ],
    output: 'It returns exact item IDs and ordered state.',
    guidance: 'Do not use it for current open threads or persona changes; use orient or identity.',
    example: { action: 'create', title: 'Protect time for art', content: 'Keep a weekly block for self-directed drawing.' },
  },
} as const satisfies Record<string, CanonicalToolSurfaceContract>;
