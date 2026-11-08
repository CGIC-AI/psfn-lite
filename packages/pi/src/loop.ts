/**
 * One bounded model loop over Pi's public `runAgentLoop`: model call, tool
 * calls, model call again, until the model stops, the caller's signal
 * aborts, the call budget runs out or the caller's gate refuses another
 * call. The loop gets a fresh context every time; core's canonical history,
 * not a Pi session, is the record. The outcome says exactly how the loop
 * ended, so the caller can settle the turn truthfully.
 */
import { producerOf, streamFnOf, type PiModelRuntime } from './model-runtime.ts';
import { runAgentLoop, type AgentEvent, type AgentMessage, type AgentTool, type AssistantMessage, type Message } from './pi.ts';
import { assistantReply, mergeAdjacentUserMessages } from './render.ts';

/** Decides whether another model call may start, and what to tell the model first. */
export type NextCallGate = () => Promise<
  { readonly proceed: true; readonly steering: readonly Message[] } | { readonly proceed: false; readonly reason: string }
>;

export interface LoopRequest {
  readonly runtime: PiModelRuntime;
  readonly systemPrompt: string;
  /** Prior context, oldest first. */
  readonly history: readonly Message[];
  /** The trigger of this loop. */
  readonly prompt: Message;
  readonly tools: readonly AgentTool[];
  readonly signal: AbortSignal;
  readonly maxModelCalls: number;
  /** Consulted before every model call after the first. */
  readonly gate?: NextCallGate;
}

export interface LoopUsage {
  readonly modelCalls: number;
  readonly toolCalls: number;
  readonly failedToolCalls: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
}

export type LoopOutcome = (
  | { readonly kind: 'completed'; readonly reply: string | null }
  | { readonly kind: 'aborted'; readonly reason: unknown; readonly partialReply: string | null }
  | { readonly kind: 'failed'; readonly code: string; readonly message: string; readonly partialReply: string | null }
  /** The budget or the gate refused another call while the model still wanted one. */
  | { readonly kind: 'stopped'; readonly reason: string; readonly partialReply: string | null }
) & { readonly usage: LoopUsage; readonly producer: string };

export async function runModelLoop(request: LoopRequest): Promise<LoopOutcome> {
  const counts = { modelCalls: 0, toolCalls: 0, failedToolCalls: 0, inputTokens: 0, outputTokens: 0 };
  const replies: string[] = [];
  let streaming = '';
  // Written from the loop's hooks, so held in an object the compiler does not narrow.
  const ended: { stopped: string | null } = { stopped: null };
  let pendingSteering: AgentMessage[] = [];
  let last: AssistantMessage | null = null;
  const producer = producerOf(request.runtime);

  const partial = () => {
    const parts = streaming.trim().length > 0 ? [...replies, streaming] : replies;
    return parts.length === 0 ? null : parts.join('\n\n');
  };
  const finish = (outcome: DistributiveOmit<LoopOutcome, 'usage' | 'producer'>): LoopOutcome => ({ ...outcome, usage: { ...counts }, producer }) as LoopOutcome;

  const emit = (event: AgentEvent): void => {
    if (event.type === 'message_update' && event.message.role === 'assistant') {
      streaming = assistantReply(event.message) ?? '';
    } else if (event.type === 'message_end' && event.message.role === 'assistant') {
      const message = event.message;
      last = message;
      streaming = '';
      counts.modelCalls += 1;
      counts.inputTokens += message.usage.input;
      counts.outputTokens += message.usage.output;
      const text = assistantReply(message);
      if (text !== null) replies.push(text);
    } else if (event.type === 'tool_execution_end') {
      counts.toolCalls += 1;
      if (event.isError) counts.failedToolCalls += 1;
    }
  };

  try {
    await runAgentLoop(
      [request.prompt],
      { systemPrompt: request.systemPrompt, messages: [...request.history], tools: [...request.tools] },
      {
        model: request.runtime.model,
        convertToLlm: (messages) => mergeAdjacentUserMessages(messages as Message[]),
        toolExecution: 'sequential',
        // Pi calls this after every model turn. Another call follows only when the model asked for tools.
        shouldStopAfterTurn: async ({ message }) => {
          if (!message.content.some((block) => block.type === 'toolCall')) return false;
          if (request.signal.aborted) return true;
          if (counts.modelCalls >= request.maxModelCalls) {
            ended.stopped = `model call budget of ${request.maxModelCalls} reached`;
            return true;
          }
          if (request.gate === undefined) return false;
          try {
            const next = await request.gate();
            if (!next.proceed) {
              ended.stopped = next.reason;
              return true;
            }
            pendingSteering = [...next.steering];
            return false;
          } catch (error) {
            ended.stopped = `gate failed: ${error instanceof Error ? error.message : String(error)}`;
            return true;
          }
        },
        getSteeringMessages: () => {
          const steering = pendingSteering;
          pendingSteering = [];
          return Promise.resolve(steering);
        },
      },
      emit,
      request.signal,
      streamFnOf(request.runtime),
    );
  } catch (error) {
    return finish({ kind: 'failed', code: 'harness_error', message: error instanceof Error ? error.message : String(error), partialReply: partial() });
  }

  const final = last as AssistantMessage | null;
  if (request.signal.aborted || final?.stopReason === 'aborted') {
    return finish({ kind: 'aborted', reason: request.signal.reason, partialReply: partial() });
  }
  if (final === null) return finish({ kind: 'failed', code: 'no_model_response', message: 'the model returned no message', partialReply: null });
  if (final.stopReason === 'error') {
    return finish({ kind: 'failed', code: 'model_error', message: final.errorMessage ?? 'the model request failed', partialReply: partial() });
  }
  if (ended.stopped !== null) return finish({ kind: 'stopped', reason: ended.stopped, partialReply: partial() });
  return finish({ kind: 'completed', reply: partial() });
}

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
