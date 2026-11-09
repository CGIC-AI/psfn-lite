/**
 * A deterministic model over pi-ai's own faux provider, for the standalone
 * host's tests. Every request goes to one scripted responder that sees the
 * exact context the companion core sent; background lanes get `{}` unless
 * the script answers them. No network, no keys.
 */
import { createModels, fauxAssistantMessage, fauxProvider, type AssistantMessage, type Context } from '@earendil-works/pi-ai';
import { createPiModelRuntime, type PiModelRuntime } from '../../packages/pi/src/index.ts';

export interface ModelCall {
  readonly context: Context;
  readonly systemPrompt: string;
  /** Text of the last user-position message. */
  readonly lastUser: string;
}

/** Returns the reply text, or null to give the default background answer. */
export type Script = (call: ModelCall) => string | null;

function textOf(content: Context['messages'][number]['content']): string {
  if (typeof content === 'string') return content;
  return content.map((block) => (block.type === 'text' ? block.text : '')).join('');
}

export function fauxModel(script: Script): { readonly runtime: PiModelRuntime; readonly calls: readonly ModelCall[] } {
  const faux = fauxProvider({ models: [{ id: 'faux-1', contextWindow: 128_000, maxTokens: 1024 }] });
  const models = createModels();
  models.setProvider(faux.provider);
  const calls: ModelCall[] = [];
  const respond = (context: Context): AssistantMessage => {
    faux.appendResponses([respond]);
    const lastUserMessage = [...context.messages].reverse().find((m) => m.role === 'user');
    const call: ModelCall = { context, systemPrompt: context.systemPrompt ?? '', lastUser: lastUserMessage === undefined ? '' : textOf(lastUserMessage.content) };
    calls.push(call);
    return fauxAssistantMessage(script(call) ?? '{}');
  };
  faux.setResponses([respond]);
  const runtime = createPiModelRuntime({ models, model: faux.getModel(), apiKey: null, maxOutputTokens: 1024 });
  if (!runtime.ok) throw new Error(JSON.stringify(runtime.error));
  return { runtime: runtime.value, calls };
}
