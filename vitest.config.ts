import { defineConfig } from 'vitest/config';

// One Vitest run, several projects. Each workspace owns its project config:
//   npx vitest run --project shared | server | server-models | server-evals | web
export default defineConfig({
  test: {
    // The model and evaluation projects have no files until later tasks add them.
    passWithNoTests: true,
    projects: [
      'packages/shared',
      'apps/server/vitest.config.ts',
      'apps/server/vitest.models.config.ts',
      'apps/server/vitest.evals.config.ts',
      'apps/web',
    ],
  },
});
