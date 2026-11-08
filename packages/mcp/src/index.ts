/**
 * PSFN Lite governed tool transport over MCP. It exposes the core tool
 * inventory as one MCP tool per domain tool, binds the caller from the
 * transport credential through operator bindings and core ingress, and
 * calls the shared dispatcher. It holds no business logic or authorization
 * of its own; core imports nothing from here.
 */
export { ACTION_ARGUMENTS } from './arguments/index.ts';
export { loadPrincipalBindings, type McpCredentialEvidence, type McpPrincipalBindings } from './bindings.ts';
export { combineCallers, type McpCallers } from './callers.ts';
export { ACTIONS_META_KEY, buildToolCatalog, type ActionCatalogEntry, type McpToolDefinition } from './catalog.ts';
export { MIN_CREDENTIAL_LENGTH, bearerCredential, type CredentialEnvironment, type CredentialSource } from './credentials.ts';
export { startMcpHttpServer, type McpHttpOptions, type McpHttpServer } from './http.ts';
export { createMcpInternalTurns, type InternalTurnLauncher, type McpInternalTurnOptions, type McpInternalTurns } from './internal-turns.ts';
export { publicError } from './results.ts';
export type { ActionArguments, ArgumentSpec, JsonSchema, ToolArguments } from './schema.ts';
export { startMcpStdioServer, type McpStdioOptions, type McpStdioServer } from './stdio.ts';
export { createMcpSurface, type McpErrorReport, type McpSurface, type McpSurfaceDeps } from './surface.ts';
