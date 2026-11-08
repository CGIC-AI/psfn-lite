import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

/**
 * The extracted donor tests run with the donor's own test settings
 * (psfn-framework vitest.config.ts at e6a9546: globals, node environment,
 * 10 s test timeout). Lite-side differences, recorded in docs/extraction.md:
 * - the donor setupFile is omitted: it acts only on
 *   persistence/postgres/fleet-auth paths, none of which were extracted;
 * - vitest.global-setup.ts isolates the donor Postgres harness per run;
 * - vitest.setup.ts makes this package the working directory, because donor
 *   tests resolve config/ seeds and README.md from process.cwd();
 * - hookTimeout is raised to Lite's harness start budget (120 s), because each
 *   run starts fresh containers instead of reusing warm ones.
 */
export default defineConfig({
  test: {
    name: 'companion',
    root: fileURLToPath(new URL('.', import.meta.url)),
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts'],
    globalSetup: ['./vitest.global-setup.ts'],
    setupFiles: ['./vitest.setup.ts'],
    testTimeout: 10_000,
    hookTimeout: 120_000,
  },
});
