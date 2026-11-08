/**
 * The single place the Pi harness reaches the core: its public entry. Every
 * harness module imports core types and helpers from here, so the boundary
 * test can prove no harness module deep-imports a core module.
 */
export * from '../../core/src/index.ts';
