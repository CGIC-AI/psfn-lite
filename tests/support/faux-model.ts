/**
 * A deterministic model over pi-ai's own faux provider, for the standalone
 * host's tests. Every request goes to one scripted responder that sees the
 * exact context the companion core sent; background lanes get `{}` unless
 * the script answers them. No network, no keys.
 */
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall, type AssistantMessage, type Context } from '@earendil-works/pi-ai';
import { createPiModelRuntime, type PiModelRuntime } from '../../packages/pi/src/index.ts';

export interface ModelCall {
  readonly context: Context;
  readonly systemPrompt: string;
  /** Text of the last user-position message. */
  readonly lastUser: string;
}

/** A tool call the scripted model makes; its arguments go to the donor tool as given. */
export interface ScriptedToolCall {
  readonly name: string;
  readonly arguments: Readonly<Record<string, unknown>>;
}

/** Returns the reply text, tool calls to make (the donor loop runs them and calls again), or null for the default background answer. */
export type Script = (call: ModelCall) => string | { readonly toolCalls: readonly ScriptedToolCall[] } | null;

function textOf(content: Context['messages'][number]['content']): string {
  if (typeof content === 'string') return content;
  return content.map((block) => (block.type === 'text' ? block.text : '')).join('');
}

export interface FauxModelOptions {
  /**
   * The pi-ai API the faux model reports. The donor enforces an explicit
   * tool request only for `openai-completions` and `pi-messages` models
   * (explicit-tool-request.ts providerToolChoice) and refuses such a turn on
   * any other API, so a test of that contract names one of those; the
   * default is pi-ai's own random faux API.
   */
  readonly api?: string;
}

export function fauxModel(script: Script, options: FauxModelOptions = {}): { readonly runtime: PiModelRuntime; readonly calls: readonly ModelCall[] } {
  const faux = fauxProvider({ ...(options.api === undefined ? {} : { api: options.api }), models: [{ id: 'faux-1', contextWindow: 128_000, maxTokens: 1024 }] });
  const models = createModels();
  models.setProvider(faux.provider);
  const calls: ModelCall[] = [];
  const respond = (context: Context): AssistantMessage => {
    faux.appendResponses([respond]);
    const lastUserMessage = [...context.messages].reverse().find((m) => m.role === 'user');
    const call: ModelCall = { context, systemPrompt: context.systemPrompt ?? '', lastUser: lastUserMessage === undefined ? '' : textOf(lastUserMessage.content) };
    calls.push(call);
    const answer = script(call) ?? '{}';
    if (typeof answer === 'string') return fauxAssistantMessage(answer);
    return fauxAssistantMessage(answer.toolCalls.map((tool) => fauxToolCall(tool.name, { ...tool.arguments })), { stopReason: 'toolUse' });
  };
  faux.setResponses([respond]);
  const runtime = createPiModelRuntime({ models, model: faux.getModel(), apiKey: null, maxOutputTokens: 1024 });
  if (!runtime.ok) throw new Error(JSON.stringify(runtime.error));
  return { runtime: runtime.value, calls };
}
