/**
 * A deterministic model for harness tests over pi-ai's own faux provider.
 * Every request goes to one scripted "brain" that answers by what is asked:
 * the affect estimator, a machine inference task, a worker, or the
 * companion. The brain sees exactly the context the harness sent, so tests
 * can assert what the model was shown. No network, no keys.
 */
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall, type AssistantMessage, type Context } from '@earendil-works/pi-ai';
import { createPiModelRuntime, type PiModelRuntime } from '../../packages/pi/src/index.ts';

export interface BrainCall {
  readonly kind: 'estimator' | 'inference' | 'worker' | 'companion';
  readonly context: Context;
  readonly systemPrompt: string;
  /** Text of the last user-position message. */
  readonly lastUser: string;
  /** True when the last message is a tool result: the model is continuing after a tool call. */
  readonly afterTool: boolean;
  /** Tool results of this request's context, oldest first. */
  readonly toolResults: readonly string[];
}

/** A brain may answer later (a slow or hanging provider); pi-ai's faux provider awaits the promise. */
export type Brain = (call: BrainCall) => AssistantMessage | Promise<AssistantMessage>;

export const AFFECT_JSON = '{"vad":{"valence":0.5,"arousal":0.2,"dominance":0.1},"discrete":{"warmth":0.7},"confidence":0.9}';

export function classify(systemPrompt: string): BrainCall['kind'] {
  if (systemPrompt.startsWith('Estimate the affect')) return 'estimator';
  if (systemPrompt.startsWith('Task: ')) return 'inference';
  if (systemPrompt.startsWith('You are a bounded worker')) return 'worker';
  return 'companion';
}

function textOf(content: Context['messages'][number]['content']): string {
  if (typeof content === 'string') return content;
  return content.map((block) => (block.type === 'text' ? block.text : '')).join('');
}

/** A runtime over the faux provider whose every response comes from `brain`. */
export function fauxRuntime(brain: Brain, options: { readonly tokensPerSecond?: number } = {}) {
  const faux = fauxProvider(options.tokensPerSecond === undefined ? {} : { tokensPerSecond: options.tokensPerSecond });
  const models = createModels();
  models.setProvider(faux.provider);
  const calls: BrainCall[] = [];
  const respond = (context: Context): AssistantMessage | Promise<AssistantMessage> => {
    faux.appendResponses([respond]);
    const messages = context.messages;
    const lastUserMessage = [...messages].reverse().find((m) => m.role === 'user');
    const call: BrainCall = {
      kind: classify(context.systemPrompt ?? ''),
      context,
      systemPrompt: context.systemPrompt ?? '',
      lastUser: lastUserMessage === undefined ? '' : textOf(lastUserMessage.content),
      afterTool: messages.at(-1)?.role === 'toolResult',
      toolResults: messages.filter((m) => m.role === 'toolResult').map((m) => textOf(m.content)),
    };
    calls.push(call);
    return brain(call);
  };
  faux.setResponses([respond]);
  const runtime = createPiModelRuntime({ models, model: faux.getModel(), apiKey: null, maxOutputTokens: 1024 });
  if (!runtime.ok) throw new Error(JSON.stringify(runtime.error));
  return { runtime: runtime.value as PiModelRuntime, calls, faux };
}

export const say = (text: string) => fauxAssistantMessage(text);
export const callTool = (tool: string, action: string, args: Record<string, unknown>) =>
  fauxAssistantMessage([fauxToolCall(tool, { action, args })], { stopReason: 'toolUse' });
export const providerError = (message: string) => fauxAssistantMessage([], { stopReason: 'error', errorMessage: message });

/** Answers the estimator and inference tasks; the rest is the test's script. */
export function withDefaults(script: (call: BrainCall) => AssistantMessage | Promise<AssistantMessage>): Brain {
  return (call) => {
    if (call.kind === 'estimator') return say(AFFECT_JSON);
    if (call.kind === 'inference') return say('A short machine appraisal of the turn.');
    return script(call);
  };
}
