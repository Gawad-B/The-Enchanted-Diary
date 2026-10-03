import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { REPO_ROOT } from '../src/config.js';

const serverDir = path.join(REPO_ROOT, 'apps', 'server');
const built = existsSync(path.join(serverDir, 'dist', 'main.js'));

function start(env: Record<string, string>) {
  return spawnSync(process.execPath, ['scripts/start.mjs'], {
    cwd: serverDir,
    env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', ENV_FILE: '', ...env },
    encoding: 'utf8',
    timeout: 20_000,
  });
}

// `npm start` runs the compiled server, so these need `npm run build` first; without a build they are skipped.
describe.skipIf(!built)('npm start (scripts/start.mjs)', () => {
  it('runs in production by default: without SESSION_SECRET it refuses to start, and says why', () => {
    const result = start({});
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('SESSION_SECRET');
    expect(result.stderr).toContain('required in production');
  });

  it('lets an explicit NODE_ENV win (a missing secret is fine outside production, so only PORT is reported)', () => {
    const result = start({ NODE_ENV: 'development', PORT: 'abc' });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('PORT');
    expect(result.stderr).not.toContain('SESSION_SECRET');
  });
});
