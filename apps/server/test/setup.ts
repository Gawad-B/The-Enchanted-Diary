import { rm } from 'node:fs/promises';
import { afterAll } from 'vitest';
import { TEST_ROOT } from './helpers.js';

// Each test file runs in its own process (pool: forks), so the tree of this process can go once its tests are done.
afterAll(async () => {
  await rm(TEST_ROOT, { recursive: true, force: true });
});
