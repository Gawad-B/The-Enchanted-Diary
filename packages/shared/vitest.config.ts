import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'shared',
    // Projects with different worker limits need distinct groups; this also runs the projects one after another,
    // which is what the memory budget (global section M) wants.
    sequence: { groupOrder: 0 },
    environment: 'node',
    include: ['test/**/*.test.ts'],
  },
});
