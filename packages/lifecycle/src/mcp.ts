/**
 * The single place the lifecycle bridge reaches the MCP transport: its public
 * entry. The bridge shares its principal bindings, its result helpers and
 * its public error shape.
 */
export * from '../../mcp/src/index.ts';
