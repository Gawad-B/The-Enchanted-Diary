import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type { Db, Queryable } from './client.js';

/** Where the numbered `NNN_name.sql` files live (src/db/migrations, copied next to the compiled output). */
const DEFAULT_MIGRATIONS_DIR = fileURLToPath(new URL('./migrations/', import.meta.url));

/** Any constant works; it only has to be the same in every process that migrates this database. */
const MIGRATION_LOCK_KEY = 727_274;

export interface MigrationResult {
  /** Versions applied by this call, in order. Empty when the database was already up to date. */
  applied: string[];
}

/**
 * Whether `schema_migrations` exists (in the first schema of the search path, where the migrations create it), asked of the
 * catalog with a plain query. NOT `to_regclass(...)`: a lookup of a name that is
 * not there leaves a negative entry in the session's catalog cache, and a session that then waits for the advisory lock below
 * never hears that another process created the table meanwhile (waiting for an advisory lock processes no cache
 * invalidations): it would try to create it again ("relation schema_migrations already exists"), several instances that start
 * on a fresh database at once all but one failing. A query of the catalog tables always sees what has been committed.
 */
async function migrationsTableExists(q: Queryable): Promise<boolean> {
  const result = await q.query<{ present: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = current_schema() AND c.relname = 'schema_migrations' AND c.relkind = 'r'
     ) AS present`,
  );
  return result.rows[0]?.present === true;
}

async function appliedVersions(db: Db): Promise<Set<string>> {
  if (!(await migrationsTableExists(db))) return new Set();
  const versions = await db.query<{ version: string }>('SELECT version FROM schema_migrations');
  return new Set(versions.rows.map((row) => row.version));
}

/**
 * Applies pending migrations in filename order. Each runs in its own transaction together with its
 * `schema_migrations` row, so a failure leaves nothing half-applied. Safe to call on every start and from
 * several processes at once, on a database that is up to date and on a fresh one (a transaction-scoped advisory lock
 * serialises them, and what they ask of the catalog is read from the catalog tables, never through a cached name lookup).
 */
export async function runMigrations(
  db: Db,
  directory: string = DEFAULT_MIGRATIONS_DIR,
): Promise<MigrationResult> {
  const files = (await readdir(directory)).filter((file) => /^\d+_.+\.sql$/.test(file)).sort();
  const applied: string[] = [];
  // Every cold start of a serverless instance gets here: when the database is up to date, one read says so, and no
  // transaction (or advisory lock) is taken.
  const done = await appliedVersions(db);
  for (const file of files) {
    const version = file.replace(/\.sql$/, '');
    if (done.has(version)) continue;
    const sql = await readFile(`${directory}/${file}`, 'utf8');
    const ran = await db.transaction(async (tx) => {
      await tx.query('SELECT pg_advisory_xact_lock($1)', [MIGRATION_LOCK_KEY]);
      // The first migration creates schema_migrations itself, so its existence has to be checked first.
      if (await migrationsTableExists(tx)) {
        const already = await tx.query('SELECT 1 FROM schema_migrations WHERE version = $1', [version]);
        if (already.rowCount > 0) return false;
      }
      await tx.exec(sql);
      await tx.query('INSERT INTO schema_migrations (version) VALUES ($1)', [version]);
      return true;
    });
    if (ran) applied.push(version);
  }
  return { applied };
}
