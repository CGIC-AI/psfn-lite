/**
 * Core's inference ports over the Pi model runtime: `ModelPort` (memory
 * extraction, episode formation, appraisal, summaries, reflection templates)
 * and `AffectEstimatorPort` (the per-turn emotion estimate). Every call is
 * one real model request. A provider error or abort is `unavailable`, never
 * an empty success; core records nothing from a failed call.
 */
import {
  isRecord,
  ok,
  unavailable,
  type AffectEstimatorPort,
  type AffectObservation,
  type ModelPort,
  type Result,
} from './core.ts';
import { producerOf, requestOptions, type PiModelRuntime } from './model-runtime.ts';
import type { AssistantMessage } from './pi.ts';
import { LABELLED_CONTEXT_NOTE, assistantReply, toModelMessages, type RenderableEntry } from './render.ts';

const ESTIMATOR_INSTRUCTIONS = [
  'Estimate the affect the companion would plausibly carry out of this conversation turn.',
  'Answer with one JSON object and nothing else:',
  '{"vad":{"valence":v,"arousal":a,"dominance":d},"discrete":{"label":score},"confidence":c}',
  'v, a and d are numbers in [-1, 1]; each discrete label is a lowercase word with a score in [0, 1]; c in [0, 1] is how sure you are.',
  'This is a fallible machine estimate stored as inference, never as what the companion said or felt.',
].join(' ');

async function complete(
  runtime: PiModelRuntime,
  input: { readonly systemPrompt: string; readonly messages: readonly RenderableEntry[]; readonly maxOutputTokens: number; readonly capability: string },
): Promise<Result<{ readonly message: AssistantMessage; readonly text: string }>> {
  const at = Date.now();
  let message: AssistantMessage;
  try {
    message = await runtime.models.completeSimple(
      runtime.model,
      { systemPrompt: input.systemPrompt, messages: toModelMessages(input.messages, runtime.model, at) },
      { ...requestOptions(runtime, undefined), maxTokens: Math.min(input.maxOutputTokens, runtime.maxOutputTokens) },
    );
  } catch (error) {
    return unavailable(input.capability, error instanceof Error ? error.message : String(error));
  }
  if (message.stopReason === 'error' || message.stopReason === 'aborted') {
    return unavailable(input.capability, `model request ${message.stopReason}: ${message.errorMessage ?? 'no detail'}`);
  }
  return ok({ message, text: assistantReply(message) ?? '' });
}

export function createPiModelPort(runtime: PiModelRuntime): ModelPort {
  return {
    async complete(request) {
      const done = await complete(runtime, {
        systemPrompt: `Task: ${request.attribution.purpose}. Your output is recorded as machine inference. ${LABELLED_CONTEXT_NOTE}`,
        messages: request.messages,
        maxOutputTokens: request.maxOutputTokens,
        capability: 'model',
      });
      if (!done.ok) return done;
      return ok({ text: done.value.text, inputTokens: done.value.message.usage.input, outputTokens: done.value.message.usage.output });
    },
  };
}

/**
 * The estimate is the model's JSON answer plus the producer. Core parses the
 * reading strictly, so a wrong shape is reported by core as a malformed
 * reading; only text that is not a JSON object at all is refused here.
 */
export function createPiAffectEstimator(runtime: PiModelRuntime): AffectEstimatorPort {
  return {
    async estimate(request) {
      const done = await complete(runtime, {
        systemPrompt: `${ESTIMATOR_INSTRUCTIONS} ${LABELLED_CONTEXT_NOTE}`,
        messages: request.messages,
        maxOutputTokens: 300,
        capability: 'affect_estimator',
      });
      if (!done.ok) return done;
      const parsed = parseJsonObject(done.value.text);
      if (parsed === null) return unavailable('affect_estimator', 'the estimate was not a JSON object');
      return ok({ ...parsed, producer: producerOf(runtime) } as unknown as AffectObservation);
    },
  };
}

/** The first JSON object in the text, allowing a fenced code block around it. */
export function parseJsonObject(text: string): Record<string, unknown> | null {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end < start) return null;
  try {
    const value: unknown = JSON.parse(text.slice(start, end + 1));
    return isRecord(value) ? value : null;
  } catch {
    return null;
  }
}
