/**
 * The tool choice a host-driven turn hands its host is the donor's own
 * explicit tool contract for that model call (resolveExplicitToolContract,
 * as the donor's stream adapter and provider client resolve it for
 * agent.turn.prompt): the requested tool until it ran, then no tool. The
 * 2026-11-09 shakedown lost four turns to that contract because the host
 * never learnt it (tool_contract_incompatible). The contexts here are the
 * pi-ai message shapes the donor agent loop sends its stream transport.
 */
import { describe, expect, it } from 'vitest';
import { hostContextOf, hostToolChoiceOf } from '../../packages/lifecycle/src/index.ts';
import type { LLMContext } from '../../packages/lifecycle/src/companion.ts';

const TOOLS = ['orient', 'memory', 'tool_search', 'toolset'].map((name) => ({ name, description: name, inputSchema: { type: 'object' } }));

function context(text: string, ran: readonly string[] = []): LLMContext {
  const messages: unknown[] = [{ role: 'user', content: [{ type: 'text', text }], timestamp: 1 }];
  ran.forEach((toolName, index) => {
    const id = `call_${index}`;
    messages.push({ role: 'assistant', content: [{ type: 'toolCall', id, name: toolName, arguments: {} }], timestamp: 2 + index });
    messages.push({ role: 'toolResult', toolCallId: id, toolName, content: [{ type: 'text', text: 'ok' }], isError: false, details: {}, timestamp: 2 + index });
  });
  return { systemPrompt: 'You are the companion.', messages, tools: TOOLS } as unknown as LLMContext;
}

describe('host tool choice', () => {
  it('names each requested tool in order, then no tool once the sequence ran', () => {
    const request = 'Call tool_search for weather, then call orient.';
    expect(hostToolChoiceOf(context(request))).toEqual({ kind: 'tool', name: 'tool_search' });
    expect(hostToolChoiceOf(context(request, ['tool_search']))).toEqual({ kind: 'tool', name: 'orient' });
    expect(hostToolChoiceOf(context(request, ['tool_search', 'orient']))).toEqual({ kind: 'none' });
  });

  it('leaves the choice to the model when the participant asked for no tool, and prepare carries the first call\'s choice', () => {
    expect(hostToolChoiceOf(context('What are my values?'))).toBeNull();
    expect(hostToolChoiceOf(context('Do not call orient, just tell me.'))).toBeNull();
    expect(hostContextOf(context('Use orient to list my values.')).toolChoice).toEqual({ kind: 'tool', name: 'orient' });
    expect(hostContextOf(context('What are my values?')).toolChoice).toBeNull();
  });

  it('a runtime-authored system note is never a participant request', () => {
    const note = context('Call orient now.');
    (note.messages[0] as { messageClass?: string }).messageClass = 'systemNote';
    expect(hostToolChoiceOf(note)).toBeNull();
  });
});
