import { loadConfig, mayDeleteData } from '../config.js';
import { applyEnvFile, resolveEnvFile } from '../env-file.js';
import { existsSync } from 'node:fs';
import { createDb } from './client.js';
import { runMigrations } from './migrate.js';

// `npm run db:migrate`: applies pending migrations to the configured database and exits.
// `--if-configured` (the Vercel build): does nothing, successfully, when no DATABASE_URL is set (a preview without a
// database must still build); otherwise it prefers the direct connection of the Neon integration, since DDL and the
// advisory lock of the migration runner belong on a session, not behind the pooler. Outside production on Vercel (a preview
// build) it also does nothing unless ALLOW_PREVIEW_DATA=true: a preview that was given the production DATABASE_URL must not
// change the production schema while the old deployment is still serving it.
const ifConfigured = process.argv.includes('--if-configured');

const file = resolveEnvFile();
if (file !== null && existsSync(file)) applyEnvFile(file);
// Migrating needs the database and nothing else: a production build must not demand the secrets of a running server.
// (And with the local disk as the storage, whatever the project says: the Blob token is a runtime secret, and a build that does
// not migrate - a preview without a database - must not fail for lacking it.)
const config = loadConfig({ ...process.env, NODE_ENV: 'development', VERCEL: '', STORAGE_PROVIDER: 'local' });
const databaseUrl = config.databaseUrlUnpooled ?? config.databaseUrl;
// On Vercel (VERCEL is set) without VERCEL_ENV (the project does not expose the system environment variables to the build) a
// preview cannot be told from production: the guard below would take it for a laptop. Fail closed: no migration unless the
// project says it has a database of its own (ALLOW_PREVIEW_DATA=true).
const unknownEnvironment =
  (process.env.VERCEL ?? '') !== '' && (process.env.VERCEL_ENV ?? '') === '' && !config.allowPreviewData;
if (ifConfigured && databaseUrl === null) {
  console.log('No DATABASE_URL: migrations skipped.');
} else if (unknownEnvironment) {
  console.log(
    'VERCEL is set but VERCEL_ENV is not (the project hides the system environment variables from the build), so a preview cannot be told from production: migrations skipped. Turn "Automatically expose System Environment Variables" on, or set ALLOW_PREVIEW_DATA=true if this environment has a database of its own.',
  );
} else if (!mayDeleteData(config)) {
  console.log(
    `VERCEL_ENV=${config.vercelEnv ?? ''} is not production and ALLOW_PREVIEW_DATA is not true: migrations skipped (a preview must not change a database it may share with production; give it a database of its own and set ALLOW_PREVIEW_DATA=true).`,
  );
} else {
  const db = await createDb({ ...config, databaseUrl, onVercel: false });
  try {
    const { applied } = await runMigrations(db);
    console.log(
      applied.length === 0
        ? `Database (${db.kind}) is up to date.`
        : `Database (${db.kind}): applied ${applied.join(', ')}.`,
    );
  } finally {
    await db.close();
  }
}
