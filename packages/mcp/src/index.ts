/**
 * PSFN Lite tool transport over MCP. It exposes the extracted companion's
 * donor tool catalog as one MCP tool per donor tool, binds the caller from the
 * transport credential through operator bindings, and hands each call to the
 * host's tool port, which runs it inside the caller's open host-driven turn.
 * It holds no tool logic or authorization of its own.
 */
export { loadPrincipalBindings, type McpPrincipalBindings, type PrincipalBinding } from './bindings.ts';
export { MIN_CREDENTIAL_LENGTH, bearerCredential, readCredential, type CredentialEnvironment, type CredentialSource } from './credentials.ts';
export { startMcpHttpServer, type McpHttpOptions, type McpHttpServer } from './http.ts';
export {
  conflict,
  denied,
  invalid,
  isNonEmptyString,
  isRecord,
  notFound,
  ok,
  publicError,
  unavailable,
  type HostError,
  type Result,
} from './result.ts';
export { startMcpStdioServer, type McpStdioOptions, type McpStdioServer } from './stdio.ts';
export {
  createMcpSurface,
  type HostToolPort,
  type McpErrorReport,
  type McpSurface,
  type McpSurfaceDeps,
  type McpToolDefinition,
  type ToolCallOutput,
} from './surface.ts';
