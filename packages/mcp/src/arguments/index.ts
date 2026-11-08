import type { ToolArguments } from '../schema.ts';
import { ACTIVITY_ARGUMENTS, AUTOMATA_ARGUMENTS, FREE_TIME_ARGUMENTS } from './activity.ts';
import { CONTACT_ARGUMENTS, SESSION_ARGUMENTS } from './continuity.ts';
import { ORIENT_ARGUMENTS, VALUES_ARGUMENTS } from './identity.ts';
import { EPISODE_ARGUMENTS, JOURNAL_ARGUMENTS, MEMORY_ARGUMENTS } from './memory.ts';
import { CONCERN_ARGUMENTS, EMOTION_ARGUMENTS } from './self-state.ts';

/**
 * Argument descriptions for every inventory action, keyed by tool then
 * action. The inventory does not carry argument shapes; these mirror the
 * key lists core's handlers accept, and a drift test compares them with the
 * handler sources. They describe the calls to clients and never validate.
 */
export const ACTION_ARGUMENTS: Readonly<Record<string, ToolArguments>> = {
  orient: ORIENT_ARGUMENTS,
  values: VALUES_ARGUMENTS,
  memory: MEMORY_ARGUMENTS,
  session: SESSION_ARGUMENTS,
  episode: EPISODE_ARGUMENTS,
  journal: JOURNAL_ARGUMENTS,
  contact: CONTACT_ARGUMENTS,
  emotion: EMOTION_ARGUMENTS,
  concern: CONCERN_ARGUMENTS,
  activity: ACTIVITY_ARGUMENTS,
  automata: AUTOMATA_ARGUMENTS,
  free_time: FREE_TIME_ARGUMENTS,
};
