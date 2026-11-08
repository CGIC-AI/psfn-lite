/**
 * Activity, worker, free-time and scheduling tables in the structured-state
 * backup, in foreign-key order: activities before the runs and blocks that
 * refer to them, runs before their effect receipts.
 */
export const AUTOMATA_BACKED_UP_TABLES = Object.freeze([
  { name: 'activities', orderBy: 'activity_id' },
  { name: 'worker_runs', orderBy: 'run_id' },
  { name: 'worker_effects', orderBy: 'run_id, effect_key' },
  { name: 'rest_states', orderBy: 'lane' },
  { name: 'free_time_blocks', orderBy: 'block_id' },
  { name: 'scheduled_prompts', orderBy: 'prompt_id' },
  { name: 'reflection_templates', orderBy: 'template_id' },
  { name: 'care_reminders', orderBy: 'reminder_id' },
] as const);
