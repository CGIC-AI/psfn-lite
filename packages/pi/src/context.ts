/**
 * Turn preparation on the harness side: the system prompt and the prior
 * context, assembled only from core reads under the turn's scope. Prompt
 * layers and the conversation's orientation blocks give identity; the
 * self-state context gives emotion, concerns, values and reflections, each
 * already labelled by core; canonical history gives the conversation. No
 * Pi session or transcript is kept between turns.
 */
import {
  contextFromHistory,
  ok,
  type ContextEntry,
  type OrientationService,
  type Result,
  type SelfStateContext,
  type SessionArchivePort,
  type SessionId,
  type TrustedTurnScope,
} from './core.ts';
import { LABELLED_CONTEXT_NOTE, labelledText } from './render.ts';

export interface TurnContextSources {
  readonly orientation: Pick<OrientationService, 'view' | 'listLayers'>;
  readonly selfState: SelfStateContext;
  readonly archive: Pick<SessionArchivePort, 'readTail'>;
}

export interface ContextLimits {
  /** Canonical history entries shown before the trigger. */
  readonly historyEntries: number;
  /** Self-state items shown in the system prompt. */
  readonly selfStateItems: number;
}

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
  const layers = await sources.orientation.listLayers(scope);
  if (!layers.ok) return layers;
  // Orientation blocks belong to a conversation; a self turn has none, by core's design.
  const blocks = scope.audience.kind === 'self' ? ok([]) : await sources.orientation.view(scope);
  if (!blocks.ok) return blocks;
  const selfState = await sources.selfState.build(scope, { limit: limits.selfStateItems });
  if (!selfState.ok) return selfState;
  const tail = await sources.archive.readTail(sessionId, limits.historyEntries);
  if (!tail.ok) return tail;

  const sections: string[] = [];
  for (const layer of layers.value) if (layer.enabled && layer.content.trim().length > 0) sections.push(layer.content.trim());
  const written = blocks.value.filter((block) => block.text.trim().length > 0);
  if (written.length > 0) sections.push(['Orientation for this conversation:', ...written.map((b) => `## ${b.name}\n${b.text.trim()}`)].join('\n'));
  sections.push(HARNESS_NOTE);
  if (selfState.value.length > 0) {
    sections.push(['Internal context for this turn (labelled; none of it is participant speech):', ...selfState.value.map(labelledText)].join('\n\n'));
  }
  return ok({ systemPrompt: sections.join('\n\n'), history: tail.value.map(contextFromHistory) });
}
