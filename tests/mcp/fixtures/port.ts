/** A recording host tool port: the catalog a test serves and every call it receives. No test-runner imports (the stdio fixture process loads it). */
import { ok, unavailable, type HostToolPort, type McpToolDefinition } from '../../../packages/mcp/src/index.ts';

export const TOOLS: readonly McpToolDefinition[] = [
  { name: 'memory', description: 'Memory.', inputSchema: { type: 'object', properties: { action: { type: 'string' } }, required: ['action'] } },
  { name: 'orient', description: 'Orientation.', inputSchema: { type: 'object', properties: { action: { type: 'string' } } } },
  { name: 'broken', description: 'A tool whose storage fails.', inputSchema: { type: 'object' } },
];

export const STORAGE_DETAIL = 'connection to postgres://admin:hunter2@db.internal:5432 refused';

export interface PortCall {
  readonly principal: string;
  readonly name: string;
  readonly args: Readonly<Record<string, unknown>>;
}

export function recordingPort(): HostToolPort & { readonly calls: PortCall[] } {
  const calls: PortCall[] = [];
  return {
    calls,
    tools: () => TOOLS,
    call: (principal, name, args) => {
      calls.push({ principal, name, args });
      if (name === 'broken') return Promise.resolve(unavailable('broken', STORAGE_DETAIL));
      return Promise.resolve(ok({ text: `ran ${name} for ${principal}`, isError: false }));
    },
  };
}
