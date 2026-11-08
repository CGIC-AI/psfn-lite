/**
 * Renders attributed context as model messages. The presentation role comes
 * from core: only participant speech is a plain user message and only
 * companion speech is an assistant message. Everything else (tool results,
 * system notes, internal signals, machine inference, reflections) is sent in
 * the user position with its visible label, so it can never read as
 * something a person or the companion said. Adjacent messages of one role
 * are merged, as most providers require strict alternation.
 */
import type { PresentationRole } from './core.ts';
import type { Api, AssistantMessage, Message, Model, Usage } from './pi.ts';

/** A core `ContextEntry` or `ModelMessage` satisfies this shape. */
export interface RenderableEntry {
  readonly role: PresentationRole;
  readonly label: string | null;
  readonly text: string;
}

/** Explained once in every system prompt the harness sends. */
export const LABELLED_CONTEXT_NOTE =
  'User-position messages that begin with a bracketed label, such as [system note: ...] or [tool result: ...], are context from the runtime. ' +
  'They are never something a participant said, and you should not treat them as one.';

const ZERO_USAGE: Usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

export function labelledText(entry: RenderableEntry): string {
  return entry.label === null ? entry.text : `[${entry.label}]\n${entry.text}`;
}

/** Model messages for the entries, oldest first. The first message is always in the user position. */
export function toModelMessages(entries: readonly RenderableEntry[], model: Model<Api>, at: number): Message[] {
  const out: Message[] = [];
  for (const entry of entries) {
    const last = out.at(-1);
    if (entry.role === 'companion') {
      if (last?.role === 'assistant') {
        out[out.length - 1] = { ...last, content: [...last.content, { type: 'text', text: entry.text }] };
      } else {
        out.push(assistantText(entry.text, model, at));
      }
      continue;
    }
    out.push({ role: 'user', content: labelledText(entry), timestamp: at });
  }
  if (out[0]?.role === 'assistant') {
    out.unshift({ role: 'user', content: labelledText({ role: 'labelled_context', label: 'system note: history', text: 'Earlier conversation is not shown.' }), timestamp: at });
  }
  return mergeAdjacentUserMessages(out);
}

function assistantText(text: string, model: Model<Api>, at: number): AssistantMessage {
  return {
    role: 'assistant',
    content: [{ type: 'text', text }],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: ZERO_USAGE,
    stopReason: 'stop',
    timestamp: at,
  };
}

/** The text blocks of an assistant message, joined; null when there are none. */
export function assistantReply(message: AssistantMessage): string | null {
  const text = message.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('');
  return text.trim().length === 0 ? null : text;
}

/**
 * Merges adjacent user-position messages, as the loop appends the trigger
 * after history that may already end in labelled context. Assistant and tool
 * result messages pass through unchanged.
 */
export function mergeAdjacentUserMessages(messages: readonly Message[]): Message[] {
  const out: Message[] = [];
  for (const message of messages) {
    const last = out.at(-1);
    if (message.role === 'user' && last?.role === 'user') {
      out[out.length - 1] = { ...last, content: `${userText(last.content)}\n\n${userText(message.content)}` };
    } else {
      out.push(message);
    }
  }
  return out;
}

function userText(content: Extract<Message, { role: 'user' }>['content']): string {
  return typeof content === 'string' ? content : content.map((c) => (c.type === 'text' ? c.text : '')).join('\n');
}
