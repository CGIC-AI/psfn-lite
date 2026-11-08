/**
 * The single place adapters reach the core: its public entry. Every adapter
 * module imports core types and helpers from here, so the boundary test can
 * prove no adapter deep-imports a core module.
 */
export * from '../../core/src/index.ts';
