import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Shared-workstation budget: at most 16 test forks. Vitest's default for
    // `run` is one fork per available CPU minus one (31 on the 32-core
    // workstation), and uncapped runs there lost forks (docs/extraction.md).
    maxWorkers: 16,
    projects: [
      {
        // Hermes Desktop provides @hermes/plugin-sdk at runtime; the Desktop half's tests use a stand-in.
        resolve: { alias: { '@hermes/plugin-sdk': fileURLToPath(new URL('./tests/support/hermes-plugin-sdk.ts', import.meta.url)) } },
        test: {
          name: 'lite',
          environment: 'node',
          include: [
            'packages/*/src/**/*.test.ts',
            'apps/*/src/**/*.test.ts',
            'tests/**/*.test.ts',
            'scripts/**/*.test.ts',
          ],
          // The extracted donor tree runs as its own project with the donor's test settings.
          exclude: ['packages/companion/**', '**/node_modules/**'],
          testTimeout: 10_000,
        },
      },
      './packages/companion/vitest.config.ts',
    ],
  },
});
