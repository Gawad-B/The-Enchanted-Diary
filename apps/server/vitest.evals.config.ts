import { defineConfig } from 'vitest/config';

// Live evaluations with the real Gemini models (`npm run test:evals`, gated by RUN_LLM_EVALS=1; `npm run calibrate` adds
// RUN_CALIBRATION=1). The only tests that call Gemini: every request is counted and capped by the run itself.
export default defineConfig({
  resolve: { conditions: ['source'] },
  ssr: { resolve: { conditions: ['source'] } },
  test: {
    name: 'server-evals',
    // Projects with different worker limits need distinct groups; this also runs the projects one after another,
    // which is what the memory budget (global section M) wants.
    sequence: { groupOrder: 3 },
    environment: 'node',
    include: ['test/evals/**/*.test.ts'],
    pool: 'forks',
    maxWorkers: 1,
    fileParallelism: false,
    passWithNoTests: true,
    testTimeout: 300_000,
    hookTimeout: 300_000,
  },
});
