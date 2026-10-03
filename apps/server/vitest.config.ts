import { defineConfig } from 'vitest/config';

// Real PGlite + pgvector with the real migrations. Files that load an ML model or run OCR are named
// `*.model.test.ts` and run in the `server-models` project (one fork) instead.
export default defineConfig({
  resolve: { conditions: ['source'] },
  ssr: { resolve: { conditions: ['source'] } },
  test: {
    name: 'server',
    // Projects with different worker limits need distinct groups; this also runs the projects one after another,
    // which is what the memory budget (global section M) wants.
    sequence: { groupOrder: 1 },
    environment: 'node',
    setupFiles: ['test/setup.ts'],
    include: ['test/**/*.test.ts'],
    exclude: ['test/**/*.model.test.ts', 'test/evals/**'],
    pool: 'forks',
    maxWorkers: 2,
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
