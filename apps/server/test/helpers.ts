import { randomBytes } from 'node:crypto';
import path from 'node:path';
import pg from 'pg';
import { describe } from 'vitest';
import { REPO_ROOT, loadConfig, type Config } from '../src/config.js';
import { createDb, type Db } from '../src/db/client.js';
import { runMigrations } from '../src/db/migrate.js';

/**
 * Scratch directories of this test process (git-ignored, under .data/tmp, never the system tmpdir: it is RAM).
 * Every `testConfig()` gets its own storage and tmp directories: the retention sweep deletes files without a
 * database row, so a test must never point at the directories a developer's server uses. `test/setup.ts`
 * removes the whole tree when the file's tests are done.
 */
export const TEST_ROOT = path.join(REPO_ROOT, '.data', 'tmp', `vitest-${String(process.pid)}`);
let directoryCounter = 0;
export const nextTestDirectory = (name: string): string => {
  directoryCounter += 1;
  return path.join(TEST_ROOT, `${name}-${String(directoryCounter)}`);
};

/**
 * A configuration for tests: in-memory PGlite, no logging, a high rate limit. `env` goes through the real
 * parser; `overrides` are applied afterwards for values that have no environment variable.
 */
export function testConfig(env: Record<string, string> = {}, overrides: Partial<Config> = {}): Config {
  return {
    ...loadConfig({
      NODE_ENV: 'test',
      LOG_LEVEL: 'silent',
      PGLITE_DATA_DIR: 'memory://',
      STORAGE_DIR: nextTestDirectory('storage'),
      TMP_DIR: nextTestDirectory('tmp'),
      RATE_LIMIT_PER_MINUTE: '100000',
      // OCR is opt-in in tests: it starts the WebAssembly engine (about 0.3 GB) in a worker thread. Tests that read
      // scans ask for `tesseract` (or use a fake engine) and are named *.model.test.ts where the real one is used.
      OCR_PROVIDER: 'none',
      // Every request of a test comes from 127.0.0.1; the tests of the upload limits set their own.
      UPLOADS_PER_HOUR: '100000',
      UPLOADS_PER_HOUR_PER_IP: '100000',
      ...env,
    }),
    ...overrides,
  };
}

export const PRODUCTION_ENV = {
  NODE_ENV: 'production',
  SESSION_SECRET: 'test-secret-test-secret-test-secret-0123456789',
} as const;

export interface TestDb {
  db: Db;
  /** Only a database on a real PostgreSQL has an address (see `createPgTestDb`). */
  url?: string;
  /** Closes the database and removes whatever was created for it. */
  dispose(): Promise<void>;
}

/** A fresh, empty, in-memory PGlite database. */
export async function createPgliteTestDb(): Promise<TestDb> {
  const db = await createDb(testConfig());
  return { db, dispose: () => db.close() };
}

/** A fresh in-memory PGlite database with the real migrations applied. */
export async function createMigratedPgliteTestDb(): Promise<TestDb> {
  const test = await createPgliteTestDb();
  await runMigrations(test.db);
  return test;
}

/**
 * A fresh, empty database on a real PostgreSQL server, created for one test file and dropped afterwards. `poolMax` is the size
 * of the connection pool: the concurrency tests need more than the one connection PGlite has (a lease race, a delete against a
 * commit, several migrations at once cannot be seen on a single connection).
 */
export async function createPgTestDb(adminUrl: string, options: { poolMax?: number } = {}): Promise<TestDb> {
  const name = `diary_test_${randomBytes(6).toString('hex')}`;
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(adminUrl);
  url.pathname = `/${name}`;
  const db = await createDb({
    databaseUrl: url.toString(),
    pgliteDataDir: 'memory://',
    databasePoolMax: options.poolMax ?? 3,
  });
  return {
    db,
    /** The address of this database: another pool over it is another process of the same deployment. */
    url: url.toString(),
    async dispose() {
      await db.close();
      await admin.query(`DROP DATABASE ${name} WITH (FORCE)`);
      await admin.end();
    },
  };
}

/** The same, with the real migrations applied. */
export async function createMigratedPgTestDb(
  adminUrl: string,
  options: { poolMax?: number } = {},
): Promise<TestDb> {
  const test = await createPgTestDb(adminUrl, options);
  await runMigrations(test.db);
  return test;
}

/** What a skipped PostgreSQL suite says it needs, so that the skip is seen and understood. */
export const POSTGRES_SKIP_HINT =
  'skipped: needs TEST_DATABASE_URL, which `npm run test:pg` sets (and starts the database)';

/**
 * The address of the real PostgreSQL the §S.9 gate runs against (TEST_DATABASE_URL: the docker-compose service of `npm run
 * db:up`, `postgres://diary:diary@127.0.0.1:5433/diary`), or undefined. Where the gate is required (REQUIRE_PG_TESTS=1, which
 * `npm run test:pg` sets, or a CI run) a missing address is an error, not a silent skip: reverting the lease lock or the lock
 * order must not be able to leave the build green.
 */
export function postgresUrl(): string | undefined {
  const url = process.env.TEST_DATABASE_URL;
  if (url !== undefined && url !== '') return url;
  if (process.env.REQUIRE_PG_TESTS === '1' || (process.env.CI !== undefined && process.env.CI !== '')) {
    throw new Error(
      'The real-PostgreSQL tests are required here (REQUIRE_PG_TESTS or CI is set) but TEST_DATABASE_URL is not: run `npm run test:pg`',
    );
  }
  return undefined;
}

export interface DbBackend {
  name: string;
  kind: Db['kind'];
  create(): Promise<TestDb>;
  /** Set when the backend cannot run here: its suite is registered as skipped, with this as its reason. */
  skipReason?: string;
}

function backends(pglite: () => Promise<TestDb>, postgres: (url: string) => Promise<TestDb>): DbBackend[] {
  const url = postgresUrl();
  return [
    { name: 'PGlite', kind: 'pglite', create: pglite },
    url === undefined
      ? {
          name: `PostgreSQL (${POSTGRES_SKIP_HINT})`,
          kind: 'pg',
          create: () => Promise.reject(new Error('PostgreSQL is not available')),
          skipReason: POSTGRES_SKIP_HINT,
        }
      : { name: 'PostgreSQL', kind: 'pg', create: () => postgres(url) },
  ];
}

/**
 * The databases a concurrency-sensitive test runs against, migrated: embedded PGlite always (one connection, so it checks the
 * logic and not the races), and a real PostgreSQL with pgvector (a pool of twelve connections) when TEST_DATABASE_URL points at
 * one. Without it the PostgreSQL suites are registered as SKIPPED, by name, so that the gap shows in every run.
 */
export const dbBackends = (): DbBackend[] =>
  backends(createMigratedPgliteTestDb, (url) => createMigratedPgTestDb(url, { poolMax: 12 }));

/** The same, with empty databases (the tests of the migrations themselves). */
export const rawDbBackends = (): DbBackend[] => backends(createPgliteTestDb, (url) => createPgTestDb(url));

/** Registers `body` once for every backend (skipped for one that cannot run here). */
export function describeEach(list: DbBackend[], body: (backend: DbBackend) => void): void {
  for (const backend of list) {
    (backend.skipReason === undefined ? describe : describe.skip)(backend.name, () => {
      body(backend);
    });
  }
}

/** Inserts a session row (optionally last seen at `lastSeenAt`) and returns its id. */
export async function insertSession(
  db: Db,
  options: { id?: string; lastSeenAt?: Date } = {},
): Promise<string> {
  const id = options.id ?? crypto.randomUUID();
  await db.query('INSERT INTO sessions (id, last_seen_at) VALUES ($1, $2)', [
    id,
    options.lastSeenAt ?? new Date(),
  ]);
  return id;
}

/** Empties the rate-limit counters: tests that share a database must not count each other's requests. */
export async function resetCounters(db: Db): Promise<void> {
  await db.query('DELETE FROM rate_counters');
}
