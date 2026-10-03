import { defineConfig } from 'vitest/config';

// Tests that run the local OCR engine (Tesseract). One fork, one file at a time (global section M.3), so that its memory
// never adds up with another test process's. No language or embedding model runs on this machine: those are Gemini's.
export default defineConfig({
  resolve: { conditions: ['source'] },
  ssr: { resolve: { conditions: ['source'] } },
  test: {
    name: 'server-models',
    // Projects with different worker limits need distinct groups; this also runs the projects one after another,
    // which is what the memory budget (global section M) wants.
    sequence: { groupOrder: 2 },
    environment: 'node',
    setupFiles: ['test/setup.ts'],
    include: ['test/**/*.model.test.ts'],
    pool: 'forks',
    maxWorkers: 1,
    fileParallelism: false,
    passWithNoTests: true,
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
