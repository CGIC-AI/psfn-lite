/**
 * stdio transport. The launching operator supplies one credential through
 * the environment or a private file; it must be bound, or the server does
 * not start. Every tool call on the connection is identified from that
 * credential and runs in its principal's open host-driven turn.
 */
import type { Transport } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { denied, ok, type Result } from './result.ts';
import { readCredential, type CredentialEnvironment, type CredentialSource } from './credentials.ts';
import type { McpErrorReport, McpSurface } from './surface.ts';

export interface McpStdioOptions {
  readonly surface: McpSurface;
  /** The operator bindings; the process's credential must be bound, or the server does not start. */
  readonly bindings: { identify(credential: string): string | null };
  /** Where this process's credential lives, for example `{ env: 'LITE_MCP_CREDENTIAL' }`. */
  readonly credential: CredentialSource;
  readonly env: CredentialEnvironment;
  /** Defaults to the process's own stdin and stdout. */
  readonly transport?: Transport;
  readonly onError: (report: McpErrorReport) => void;
}

export interface McpStdioServer {
  /** The principal the connection is bound to. */
  readonly principal: string;
  close(): Promise<void>;
}

export function startMcpStdioServer(options: McpStdioOptions): Result<McpStdioServer> {
  const credential = readCredential(options.credential, options.env);
  if (!credential.ok) return credential;
  const principal = options.bindings.identify(credential.value);
  if (principal === null) return denied('unknown_authority', 'the stdio credential is not bound to a principal');
  const handle = serveStdio(() => options.surface.createServer(credential.value), {
    ...(options.transport === undefined ? {} : { transport: options.transport }),
    onerror: (error) => options.onError({ stage: 'transport', tool: null, principal: null, error: { kind: 'exception', message: error.message } }),
  });
  return ok({ principal, close: () => handle.close() });
}
