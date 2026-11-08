import type { SessionEntry } from '../sessions/index.ts';
import { invalid, ok, presentationRole, type InternalOrigin, type Origin, type PresentationRole, type Result } from '../shared/index.ts';

/**
 * One piece of turn context as a harness must render it. The role is derived
 * from the origin, so internal material can never be rendered as participant
 * speech, and every non-speech entry carries a visible label.
 */
export interface ContextEntry {
  readonly origin: Origin;
  readonly role: PresentationRole;
  readonly label: string | null;
  readonly text: string;
}

/** Context from canonical history, where origins were bound at ingress. */
export function contextFromHistory(entry: SessionEntry): ContextEntry {
  return { origin: entry.origin, role: presentationRole(entry.origin), label: labelFor(entry.origin), text: entry.text };
}

/**
 * Internal context (tool results, notes, signals, inference, reflections).
 * Participant speech is only ever produced from admitted triggers.
 */
export function internalContext(origin: InternalOrigin, text: string): Result<ContextEntry> {
  if ((origin.kind as string) === 'participant_speech') {
    return invalid('internal context cannot be attributed as participant speech');
  }
  return ok({ origin, role: presentationRole(origin), label: labelFor(origin), text });
}

function labelFor(origin: Origin): string | null {
  switch (origin.kind) {
    case 'participant_speech':
    case 'companion_speech':
      return null;
    case 'tool_result':
      return `tool result: ${origin.tool}.${origin.action}`;
    case 'system_note':
      return `system note: ${origin.source}`;
    case 'internal_signal':
      return `internal signal: ${origin.source}`;
    case 'machine_inference':
      return `machine inference: ${origin.producer}`;
    case 'authored_reflection':
      return 'companion reflection';
  }
}
