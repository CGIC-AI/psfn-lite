/**
 * The single place the MCP transport reaches the core: its public entry.
 * Every module imports core types and helpers from here, so the boundary
 * test can prove no transport module deep-imports a core module.
 */
export * from '../../core/src/index.ts';
