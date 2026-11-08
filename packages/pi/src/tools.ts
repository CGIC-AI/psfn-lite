/**
 * The governed inventory as Pi tools: one Pi tool per domain tool, with the
 * action as an enum and the action's arguments passed through untouched.
 * Core's handlers own argument validation, so no second schema can drift
 * from them. Every call goes through the injected invoker: the core
 * dispatcher for the companion, the worker session's fenced call for a
 * worker. Authority never comes from the arguments; the invoker binds the
 * scope.
 */
import type { AttributedToolResult, CoreError, Result, ToolCall, ToolDescriptor } from './core.ts';
import { Type, type AgentTool } from './pi.ts';

export type ToolInvoker = (toolCallId: string, call: ToolCall) => Promise<Result<AttributedToolResult>>;

/** Which actions of a tool this surface offers; a tool with none is left out. */
export type ActionFilter = (tool: string, action: string) => boolean;

export interface PiToolOptions {
  /** Longer tool results are cut and the cut is labelled, keeping one call from flooding the context. */
  readonly maxResultChars: number;
}

/** A tool call core refused. Thrown so the Pi loop reports it to the model as an error result. */
export class ToolRefusal extends Error {
  readonly call: ToolCall;
  readonly error: CoreError;
  constructor(call: ToolCall, error: CoreError) {
    super(`${call.tool}.${call.action} was refused: ${describeError(error)}`);
    this.name = 'ToolRefusal';
    this.call = call;
    this.error = error;
  }
}

export function piTools(inventory: readonly ToolDescriptor[], invoke: ToolInvoker, allow: ActionFilter, options: PiToolOptions): AgentTool[] {
  const tools: AgentTool[] = [];
  for (const descriptor of inventory) {
    const actions = descriptor.actions.filter((action) => allow(descriptor.name, action.name));
    const [first, ...rest] = actions;
    if (first === undefined) continue;
    const literals = [first, ...rest].map((action) => Type.Literal(action.name));
    tools.push({
      name: descriptor.name,
      label: descriptor.name,
      description: [
        descriptor.summary,
        'Call with {"action": <one of the actions>, "args": {...}}. Actions:',
        ...actions.map((action) => `- ${action.name}: ${action.summary}`),
      ].join('\n'),
      parameters: Type.Object({
        action: literals.length === 1 && literals[0] !== undefined ? literals[0] : Type.Union(literals),
        args: Type.Optional(Type.Object({}, { additionalProperties: true })),
      }),
      executionMode: 'sequential',
      async execute(toolCallId, params) {
        const input = params as { readonly action: string; readonly args?: Record<string, unknown> };
        const call: ToolCall = { tool: descriptor.name, action: input.action, args: input.args ?? {} };
        const result = await invoke(toolCallId, call);
        if (!result.ok) throw new ToolRefusal(call, result.error);
        return {
          content: [{ type: 'text', text: bounded(result.value.content === undefined ? 'null' : JSON.stringify(result.value.content), options.maxResultChars) }],
          details: { origin: result.value.origin },
        };
      },
    });
  }
  return tools;
}

function bounded(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}\n[tool result cut: ${text.length - max} more characters not shown]`;
}

export function describeError(error: CoreError): string {
  switch (error.kind) {
    case 'denied':
      return `denied (${error.reason}): ${error.detail}`;
    case 'not_found':
      return `not found: ${error.subject}`;
    case 'conflict':
      return `conflict (${error.reason}): ${error.detail}`;
    case 'invalid':
      return `invalid: ${error.issues.join('; ')}`;
    case 'unavailable':
      return `unavailable (${error.capability}): ${error.detail}`;
  }
}
