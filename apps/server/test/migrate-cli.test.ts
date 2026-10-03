import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { REPO_ROOT } from '../src/config.js';

/*
 * `npm run db:migrate:build`, the migration step of the Vercel build, as the build runs it: the compiled-server entry, here run
 * from source. Nothing is migrated here (the database it is given does not exist): what is checked is WHETHER it tries. A
 * preview must not change a database it may share with production, and a build without a database must still pass.
 */

const run = promisify(execFile);
const CLI = path.join(REPO_ROOT, 'apps/server/src/db/migrate-cli.ts');
/** Nobody listens here: a build that tries to migrate fails to connect at once, and one that does not try succeeds. */
const NOWHERE = 'postgres://nobody:nothing@127.0.0.1:1/none';

async function migrate(env: Record<string, string>): Promise<{ code: number; output: string }> {
  try {
    const { stdout, stderr } = await run(
      process.execPath,
      ['--conditions=source', '--import', 'tsx', CLI, '--if-configured'],
      {
        cwd: REPO_ROOT,
        env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', ENV_FILE: '', ...env },
        timeout: 60_000,
      },
    );
    return { code: 0, output: `${stdout}${stderr}` };
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string };
    return { code: failure.code ?? 1, output: `${failure.stdout ?? ''}${failure.stderr ?? ''}` };
  }
}

describe('the migration step of the build', () => {
  it('does nothing, and succeeds, without a DATABASE_URL (a preview without a database still builds)', async () => {
    const result = await migrate({});
    expect(result.code).toBe(0);
    expect(result.output).toContain('No DATABASE_URL: migrations skipped.');
  }, 90_000);

  it('builds a Vercel project that has the Blob store set but no token yet (the token is a runtime secret, not the build’s)', async () => {
    // As the Vercel build sees a preview with the storage variable inherited and no Blob store of its own: nothing to migrate,
    // and no failure for the missing token.
    const withoutDatabase = await migrate({
      VERCEL: '1',
      VERCEL_ENV: 'preview',
      STORAGE_PROVIDER: 'vercel-blob',
    });
    expect(withoutDatabase.code, withoutDatabase.output).toBe(0);
    expect(withoutDatabase.output).toContain('No DATABASE_URL: migrations skipped.');
    const preview = await migrate({
      VERCEL: '1',
      VERCEL_ENV: 'preview',
      STORAGE_PROVIDER: 'vercel-blob',
      DATABASE_URL: NOWHERE,
    });
    expect(preview.code, preview.output).toBe(0);
    expect(preview.output).toContain('migrations skipped');
    // Production with the same variables reaches the database (and fails to connect here), not a complaint about the token.
    const production = await migrate({
      VERCEL: '1',
      VERCEL_ENV: 'production',
      STORAGE_PROVIDER: 'vercel-blob',
      DATABASE_URL: NOWHERE,
    });
    expect(production.code).not.toBe(0);
    expect(production.output).not.toContain('BLOB_READ_WRITE_TOKEN');
  }, 120_000);

  it('fails closed on Vercel without VERCEL_ENV (the system variables are hidden from the build): no migration, unless the environment says it has a database of its own', async () => {
    const hidden = await migrate({ VERCEL: '1', DATABASE_URL: NOWHERE });
    expect(hidden.code, hidden.output).toBe(0); // it never connected
    expect(hidden.output).toContain('migrations skipped');
    expect(hidden.output).toContain('VERCEL_ENV');
    expect(hidden.output).toContain('ALLOW_PREVIEW_DATA');
    // With ALLOW_PREVIEW_DATA=true it goes on (and fails to connect here); a laptop, which has no VERCEL, always did.
    for (const env of [{ VERCEL: '1', ALLOW_PREVIEW_DATA: 'true' }, {}] as Record<string, string>[]) {
      const result = await migrate({ DATABASE_URL: NOWHERE, ...env });
      expect(result.code, JSON.stringify(env)).not.toBe(0);
      expect(result.output, JSON.stringify(env)).not.toContain('migrations skipped');
    }
  }, 120_000);

  it('does not touch the database of a preview that was not told it has its own, nor of a development environment', async () => {
    for (const vercelEnv of ['preview', 'development']) {
      const result = await migrate({ DATABASE_URL: NOWHERE, VERCEL_ENV: vercelEnv });
      expect(result.code, vercelEnv).toBe(0); // it never connected
      expect(result.output, vercelEnv).toContain('migrations skipped');
      expect(result.output, vercelEnv).toContain('ALLOW_PREVIEW_DATA');
    }
  }, 90_000);

  it('goes on in production, and in a preview that has a database of its own (it tries to connect, which fails here)', async () => {
    const cases: Record<string, string>[] = [
      { VERCEL_ENV: 'production' },
      { VERCEL_ENV: 'preview', ALLOW_PREVIEW_DATA: 'true' },
      {}, // not on Vercel: a laptop, CI
    ];
    for (const env of cases) {
      const result = await migrate({ DATABASE_URL: NOWHERE, ...env });
      expect(result.code, JSON.stringify(env)).not.toBe(0);
      expect(result.output, JSON.stringify(env)).not.toContain('migrations skipped');
    }
  }, 120_000);
});
