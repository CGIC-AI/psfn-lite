import { ProtocolError, ProtocolErrorCode, Server, type CallToolResult } from '@modelcontextprotocol/server';
import { ACTION_ARGUMENTS } from './arguments/index.ts';
import type { McpCredentialEvidence } from './bindings.ts';
import { buildToolCatalog, type McpToolDefinition } from './catalog.ts';
import {
  TOOL_INVENTORY,
  invalid,
  isRecord,
  ok,
  unavailable,
  type CoreError,
  type Result,
  type ToolDispatcher,
  type TrustedIngress,
} from './core.ts';
import { errorResult, successResult } from './results.ts';

/** Something the operator should see; never sent to the client. */
export interface McpErrorReport {
  readonly stage: 'admission' | 'dispatch' | 'transport';
  readonly tool: string | null;
  readonly action: string | null;
  /** The failure as core reported it (unredacted), or the thrown error's message. */
  readonly error: CoreError | { readonly kind: 'exception'; readonly message: string };
}

export interface McpSurfaceDeps {
  /** The shared dispatcher every harness uses; MCP adds no handlers of its own. */
  readonly dispatcher: ToolDispatcher;
  /** Core ingress built with the bindings' authenticator, so every call is admitted from its credential. */
  readonly ingress: TrustedIngress;
  /** Receives unavailable failures and exceptions for the operator's log. */
  readonly onError: (report: McpErrorReport) => void;
  readonly serverInfo?: { readonly name: string; readonly version: string };
}

export interface McpSurface {
  /** Exactly one MCP tool per inventory tool. */
  readonly tools: readonly McpToolDefinition[];
  /**
   * One tool call made with the credential presented for it. The credential
   * is admitted through core ingress on every call, so a blocked or
   * re-scoped contact takes effect at once, never at the next connection.
   */
  call(credential: string, name: string, args: unknown): Promise<CallToolResult>;
  /** A protocol server for one serving unit (an HTTP request or a stdio connection) under one credential. */
  createServer(credential: string): Server;
}

const DEFAULT_SERVER_INFO = { name: 'psfn-lite', version: '0.0.0' } as const;

/**
 * The governed tool surface over MCP. It maps each call to `ingress.admit`
 * and `dispatcher.dispatch`; authorization, argument validation and
 * disclosure stay in core. The only argument the transport reads is the
 * `action` discriminator.
 */
export function createMcpSurface(deps: McpSurfaceDeps): Result<McpSurface> {
  const catalog = buildToolCatalog(TOOL_INVENTORY, ACTION_ARGUMENTS);
  if (!catalog.ok) return catalog;
  const tools = catalog.value;
  const names = new Set(tools.map((t) => t.name));
  const info = deps.serverInfo ?? DEFAULT_SERVER_INFO;

  const call = async (credential: string, name: string, rawArgs: unknown): Promise<CallToolResult> => {
    if (!names.has(name)) throw new ProtocolError(ProtocolErrorCode.InvalidParams, `Tool ${name} not found`);
    const split = splitAction(rawArgs);
    if (!split.ok) return errorResult(split.error);
    const { action, args } = split.value;
    const stage = { tool: name, action };
    try {
      const evidence: McpCredentialEvidence = { kind: 'mcp_credential', credential };
      const scope = await deps.ingress.admit(evidence);
      if (!scope.ok) {
        if (scope.error.kind === 'unavailable') deps.onError({ stage: 'admission', ...stage, error: scope.error });
        return errorResult(scope.error);
      }
      const result = await deps.dispatcher.dispatch(scope.value, { tool: name, action, args });
      if (!result.ok) {
        if (result.error.kind === 'unavailable') deps.onError({ stage: 'dispatch', ...stage, error: result.error });
        return errorResult(result.error);
      }
      return successResult(result.value);
    } catch (error) {
      deps.onError({ stage: 'dispatch', ...stage, error: { kind: 'exception', message: error instanceof Error ? error.message : 'non-error thrown' } });
      return errorResult(unavailable(`${name}.${action}`, 'the call failed').error);
    }
  };

  const createServer = (credential: string): Server => {
    const server = new Server({ name: info.name, version: info.version }, { capabilities: { tools: { listChanged: false } } });
    server.setRequestHandler('tools/list', () => ({ tools: tools.map((t) => ({ ...t })) }));
    server.setRequestHandler('tools/call', (request) => call(credential, request.params.name, request.params.arguments));
    return server;
  };

  return ok({ tools, call, createServer });
}

/** Separates the discriminator from the arguments core will read. */
function splitAction(raw: unknown): Result<{ readonly action: string; readonly args: Readonly<Record<string, unknown>> }> {
  if (raw !== undefined && !isRecord(raw)) return invalid('tool arguments must be an object');
  const { action, ...args } = raw ?? {};
  if (typeof action !== 'string' || action.length === 0) return invalid('action is required and must name one of the tool’s actions');
  return ok({ action, args });
}
