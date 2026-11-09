/**
 * The companion's tool surface over MCP: one MCP tool per donor tool, named,
 * described and schema'd as the donor registers it. The transport holds no
 * tool logic, authorization or argument validation: a call is handed, with
 * the principal its credential is bound to, to the host's tool port, which
 * runs it as a model tool call of that principal's open host-driven turn
 * (packages/lifecycle). The donor's own loop runs the tool, so its gates and
 * argument checks apply exactly as in a SubstrateAgent turn.
 */
import { ProtocolError, ProtocolErrorCode, Server, type CallToolResult } from '@modelcontextprotocol/server';
import { isRecord, publicError, type HostError, type Result } from './result.ts';

export interface McpToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: { readonly type: 'object' } & Readonly<Record<string, unknown>>;
}

/** What the donor's loop returned for one tool call. */
export interface ToolCallOutput {
  readonly text: string;
  readonly isError: boolean;
}

export interface HostToolPort {
  /** The donor tool catalog, read when a client lists tools. */
  tools(): readonly McpToolDefinition[];
  call(principal: string, name: string, args: Readonly<Record<string, unknown>>): Promise<Result<ToolCallOutput>>;
}

/** Something the operator should see; never sent to the client. */
export interface McpErrorReport {
  readonly stage: 'call' | 'transport';
  readonly tool: string | null;
  readonly principal: string | null;
  readonly error: HostError | { readonly kind: 'exception'; readonly message: string };
}

export interface McpSurfaceDeps {
  readonly port: HostToolPort;
  /** The principal a credential is bound to, or null. */
  readonly identify: (credential: string) => string | null;
  readonly onError: (report: McpErrorReport) => void;
  readonly serverInfo?: { readonly name: string; readonly version: string };
}

export interface McpSurface {
  call(credential: string, name: string, args: unknown): Promise<CallToolResult>;
  /** A protocol server for one serving unit (an HTTP request or a stdio connection) under one credential. */
  createServer(credential: string): Server;
}

const DEFAULT_SERVER_INFO = { name: 'psfn-lite', version: '0.0.0' } as const;

function render(payload: Readonly<Record<string, unknown>>, text: string, isError: boolean): CallToolResult {
  return { content: [{ type: 'text', text }], structuredContent: { ...payload }, ...(isError ? { isError: true } : {}) };
}

/** A tool result, labelled as tool output so a harness never renders it as speech. */
function toolResult(output: ToolCallOutput): CallToolResult {
  return render({ origin: 'tool_result', text: output.text }, output.text, output.isError);
}

function errorResult(error: HostError): CallToolResult {
  const payload = { error: publicError(error) };
  return render(payload, JSON.stringify(payload), true);
}

export function createMcpSurface(deps: McpSurfaceDeps): McpSurface {
  const info = deps.serverInfo ?? DEFAULT_SERVER_INFO;

  const call = async (credential: string, name: string, rawArgs: unknown): Promise<CallToolResult> => {
    if (!deps.port.tools().some((t) => t.name === name)) throw new ProtocolError(ProtocolErrorCode.InvalidParams, `Tool ${name} not found`);
    const principal = deps.identify(credential);
    if (principal === null) return errorResult({ kind: 'denied', reason: 'unknown_authority', detail: 'the credential is not bound' });
    if (rawArgs !== undefined && !isRecord(rawArgs)) return errorResult({ kind: 'invalid', issues: ['tool arguments must be an object'] });
    try {
      const result = await deps.port.call(principal, name, rawArgs ?? {});
      if (!result.ok) {
        if (result.error.kind === 'unavailable') deps.onError({ stage: 'call', tool: name, principal, error: result.error });
        return errorResult(result.error);
      }
      return toolResult(result.value);
    } catch (error) {
      deps.onError({ stage: 'call', tool: name, principal, error: { kind: 'exception', message: error instanceof Error ? error.message : 'non-error thrown' } });
      return errorResult({ kind: 'unavailable', capability: name, detail: 'the call failed' });
    }
  };

  const createServer = (credential: string): Server => {
    const server = new Server({ name: info.name, version: info.version }, { capabilities: { tools: { listChanged: false } } });
    server.setRequestHandler('tools/list', () => ({ tools: deps.port.tools().map((t) => ({ ...t })) }));
    server.setRequestHandler('tools/call', (request) => call(credential, request.params.name, request.params.arguments));
    return server;
  };

  return { call, createServer };
}
