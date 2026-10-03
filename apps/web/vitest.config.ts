import react from '@vitejs/plugin-react';
import { defaultClientConditions } from 'vite';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [react()],
  resolve: { conditions: ['source', ...defaultClientConditions] },
  test: {
    name: 'web',
    // Projects with different worker limits need distinct groups; this also runs the projects one after another,
    // which is what the memory budget (global section M) wants.
    sequence: { groupOrder: 4 },
    environment: 'jsdom',
    include: ['test/**/*.test.{ts,tsx}'],
    setupFiles: ['./test/setup.ts'],
    pool: 'forks',
    maxWorkers: 3,
    css: false,
  },
});
