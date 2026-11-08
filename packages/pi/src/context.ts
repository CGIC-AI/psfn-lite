/**
 * Turn preparation on the harness side: the system prompt and the prior
 * context, assembled only from core reads under the turn's scope. Prompt
 * layers and the conversation's orientation blocks give identity; the
 * self-state context gives emotion, concerns, values and reflections, each
 * already labelled by core; canonical history gives the conversation. No
 * Pi session or transcript is kept between turns.
 */
import {
  createTurnContextAssembler,
  ok,
  type ContextEntry,
  type Result,
  type SessionId,
  type TrustedTurnScope,
  type TurnContextDeps,
  type TurnContextLimits,
} from './core.ts';
import { LABELLED_CONTEXT_NOTE, labelledText } from './render.ts';

/** Core reads the context comes from; core assembles and gates them, the harness only renders. */
export type TurnContextSources = TurnContextDeps;

export type ContextLimits = TurnContextLimits;

export interface TurnContext {
  readonly systemPrompt: string;
  readonly history: readonly ContextEntry[];
}

const HARNESS_NOTE = [
  'You are the companion, speaking in your own voice in this conversation.',
  'Your tools reach your own continuity: orientation, memory, sessions, episodes, journals, contacts, emotion, concerns, values, activity, workers and free time.',
  'Each tool takes {"action": ..., "args": {...}}. A refused call says why; do not claim an action happened unless its tool result says so.',
  LABELLED_CONTEXT_NOTE,
].join('\n');

export async function assembleTurnContext(
  sources: TurnContextSources,
  scope: TrustedTurnScope,
  sessionId: SessionId,
  limits: ContextLimits,
): Promise<Result<TurnContext>> {
  const parts = await createTurnContextAssembler(sources).assemble(scope, { sessionId, limits, excludeTurn: null });
  if (!parts.ok) return parts;
  const { layers, orientation, internal, activity, history } = parts.value;
  const sections: string[] = [...layers];
  if (orientation.length > 0) sections.push(['Orientation for this conversation:', ...orientation.map((b) => `## ${b.name}\n${b.text.trim()}`)].join('\n'));
  sections.push(HARNESS_NOTE);
  const labelled = [...internal, ...activity];
  if (labelled.length > 0) {
    sections.push(['Internal context for this turn (labelled; none of it is participant speech):', ...labelled.map(labelledText)].join('\n\n'));
  }
  return ok({ systemPrompt: sections.join('\n\n'), history });
}
