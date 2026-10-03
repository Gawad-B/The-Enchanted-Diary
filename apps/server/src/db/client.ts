import { mkdir } from 'node:fs/promises';
import type { Config } from '../config.js';

export interface QueryResult<T> {
  rows: T[];
  /** Rows returned by a SELECT, or rows affected by INSERT / UPDATE / DELETE. */
  rowCount: number;
}

/** Anything that can run SQL: the root database or a transaction handle. Repositories depend on this. */
export interface Queryable {
  /**
   * Runs one parameterised statement. Vectors are passed as text (`'[0.1,0.2]'`) with a `::vector` cast and
   * come back as strings.
   */
  query<T extends object = Record<string, unknown>>(
    sql: string,
    params?: readonly unknown[],
  ): Promise<QueryResult<T>>;
  /** Runs one or more statements without parameters (migrations). */
  exec(sql: string): Promise<void>;
}

export interface Db extends Queryable {
  readonly kind: 'pg' | 'pglite';
  /**
   * Runs `fn` in a transaction and commits when it resolves, rolls back when it throws.
   * Inside `fn` use ONLY the `tx` handle: PGlite has a single connection, so calling the root `Db` from
   * inside a transaction deadlocks there (it merely works on a pg Pool).
   */
  transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

export interface DbLogger {
  error(object: unknown, message: string): void;
}

type DbConfig = Pick<Config, 'databaseUrl' | 'pgliteDataDir'> &
  Partial<Pick<Config, 'databasePoolMax' | 'onVercel'>>;

/** Connections a pool opens by default: a serverless instance serves a few requests at a time (Neon's pooler does the rest). */
const DEFAULT_POOL_MAX = 3;
/** Neon may have to wake its compute before it answers the first query. */
const CONNECT_TIMEOUT_MS = 15_000;

/** node-postgres Pool when DATABASE_URL is set, otherwise embedded PGlite with pgvector. */
export async function createDb(config: DbConfig, logger?: DbLogger): Promise<Db> {
  return config.databaseUrl === null
    ? createPgliteDb(config.pgliteDataDir)
    : createPgDb(config.databaseUrl, {
        max: config.databasePoolMax ?? DEFAULT_POOL_MAX,
        onVercel: config.onVercel ?? false,
        logger,
      });
}

async function createPgliteDb(dataDir: string): Promise<Db> {
  // Loaded lazily: the wasm runtime is only paid for when it is used.
  const { PGlite } = await import('@electric-sql/pglite');
  const { vector } = await import('@electric-sql/pglite-pgvector');
  if (dataDir !== 'memory://') await mkdir(dataDir, { recursive: true });
  // The extension object must be passed here AND created in SQL (the first migration does the latter).
  const pglite = await PGlite.create({ dataDir, extensions: { vector } });

  const wrap = (target: Pick<typeof pglite, 'query' | 'exec'>): Queryable => ({
    async query<T extends object>(sql: string, params: readonly unknown[] = []) {
      const result = await target.query<T>(sql, [...params]);
      // PGlite reports affectedRows = 0 for a SELECT, so rows returned and rows written are combined.
      return { rows: result.rows, rowCount: Math.max(result.affectedRows ?? 0, result.rows.length) };
    },
    async exec(sql: string) {
      await target.exec(sql);
    },
  });

  return {
    kind: 'pglite',
    ...wrap(pglite),
    transaction: (fn) => pglite.transaction((tx) => fn(wrap(tx))),
    close: () => pglite.close(),
  };
}

async function createPgDb(
  connectionString: string,
  options: { max: number; onVercel: boolean; logger: DbLogger | undefined },
): Promise<Db> {
  const { logger } = options;
  const pg = (await import('pg')).default;
  const pool = new pg.Pool({
    connectionString,
    max: options.max,
    connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
  });
  if (options.onVercel) {
    // Lets the Vercel runtime close the idle connections of the pool before an instance is suspended (Fluid compute keeps
    // the instance, and so the pool, between requests).
    const { attachDatabasePool } = await import('@vercel/functions');
    attachDatabasePool(pool);
  }
  // An idle client that loses its connection emits 'error'; unhandled, it would crash the process.
  pool.on('error', (error) => {
    logger?.error({ err: error }, 'idle database client error');
  });

  const wrap = (target: Pick<typeof pool, 'query'>): Queryable => ({
    async query<T extends object>(sql: string, params: readonly unknown[] = []) {
      const result = await target.query<T & Record<string, unknown>>(sql, [...params]);
      return { rows: result.rows, rowCount: result.rowCount ?? result.rows.length };
    },
    async exec(sql: string) {
      // Without parameters node-postgres uses the simple protocol, which accepts several statements.
      await target.query(sql);
    },
  });

  return {
    kind: 'pg',
    ...wrap(pool),
    async transaction(fn) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const result = await fn(wrap(client));
        await client.query('COMMIT');
        return result;
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    },
    close: () => pool.end(),
  };
}
