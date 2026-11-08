import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      {
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
