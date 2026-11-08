/**
 * The single place the lifecycle bridge reaches the MCP transport: its public
 * entry. The bridge shares its caller credentials (operator bindings and
 * per-turn internal credentials) and its public error shape.
 */
export * from '../../mcp/src/index.ts';
