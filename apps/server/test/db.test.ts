import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { REPO_ROOT } from '../src/config.js';
import { createDb, type Db } from '../src/db/client.js';
import { runMigrations } from '../src/db/migrate.js';
import { describeEach, rawDbBackends } from './helpers.js';

const EXPECTED_TABLES = [
  'chunk_embeddings',
  'conversations',
  'document_chunks',
  'document_pages',
  'documents',
  'ingest_jobs',
  'ingest_stage_data',
  'messages',
  'rate_counters',
  'schema_migrations',
  'sessions',
  'upload_tickets',
];

/**
 * The same suite runs against embedded PGlite always, and against a real PostgreSQL + pgvector as well when
 * TEST_DATABASE_URL points at one (`npm run test:pg`): the two must behave identically. Without it the PostgreSQL suite is
 * registered as skipped, by name.
 */
describeEach(rawDbBackends(), ({ kind, create }) => {
  let db: Db;
  let dispose: () => Promise<void>;

  beforeAll(async () => {
    ({ db, dispose } = await create());
  });

  afterAll(async () => {
    await dispose();
  });

  async function insertDocument(sessionId: string): Promise<string> {
    const id = randomUUID();
    await db.query(`INSERT INTO sessions (id) VALUES ($1) ON CONFLICT DO NOTHING`, [sessionId]);
    await db.query(
      `INSERT INTO documents (id, session_id, filename, byte_size, sha256, status, storage_key, expires_at)
     VALUES ($1, $2, 'a.pdf', 10, 'abc', 'ready', $3, now() + interval '1 day')`,
      [id, sessionId, `${id}.pdf`],
    );
    return id;
  }

  async function insertChunk(documentId: string, index: number, searchText: string): Promise<string> {
    const id = randomUUID();
    await db.query(
      `INSERT INTO document_chunks (id, document_id, chunk_index, page_start, page_end, content, search_text, char_start, char_end, token_count)
     VALUES ($1, $2, $3, 1, 1, $4, $4, 0, 10, 3)`,
      [id, documentId, index, searchText],
    );
    return id;
  }

  describe('createDb', () => {
    it('opens the backend the configuration selects', () => {
      expect(db.kind).toBe(kind);
    });
  });

  describe('runMigrations', () => {
    it('applies the migrations in order and creates every table', async () => {
      const result = await runMigrations(db);
      expect(result.applied).toEqual(['001_init', '002_serverless', '003_upload_tickets']);
      const tables = await db.query<{ table_name: string }>(
        `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name`,
      );
      expect(tables.rows.map((row) => row.table_name)).toEqual(EXPECTED_TABLES);
      const recorded = await db.query<{ version: string }>('SELECT version FROM schema_migrations');
      expect(recorded.rows).toEqual([
        { version: '001_init' },
        { version: '002_serverless' },
        { version: '003_upload_tickets' },
      ]);
    });

    it('is idempotent: a second run applies nothing', async () => {
      await runMigrations(db);
      const second = await runMigrations(db);
      expect(second.applied).toEqual([]);
      const recorded = await db.query('SELECT version FROM schema_migrations');
      expect(recorded.rowCount).toBe(3);
    });

    it('takes no transaction when the database is up to date (what every cold start of a function pays)', async () => {
      await runMigrations(db);
      let transactions = 0;
      const counting: Db = {
        ...db,
        transaction: (fn) => {
          transactions += 1;
          return db.transaction(fn);
        },
      };
      expect((await runMigrations(counting)).applied).toEqual([]);
      expect(transactions).toBe(0);
    });

    it('lets several processes migrate a fresh database at the same time: all succeed, each migration is applied once', async () => {
      // A preview whose build skipped the migrations starts several instances at once, each with its own connections. (On PGlite
      // there is one connection: the calls queue up on it, which checks the logic and not the catalog cache.)
      for (let round = 0; round < 3; round += 1) {
        const fresh = await create();
        const opened: Db[] = [];
        try {
          const handles =
            kind === 'pg' && fresh.url !== undefined
              ? await Promise.all(
                  Array.from({ length: 5 }, async () => {
                    const handle = await createDb({
                      databaseUrl: fresh.url ?? '',
                      pgliteDataDir: 'memory://',
                      databasePoolMax: 2,
                    });
                    opened.push(handle);
                    return handle;
                  }),
                )
              : Array.from({ length: 5 }, () => fresh.db);
          const results = await Promise.all(handles.map((handle) => runMigrations(handle)));
          expect(results.flatMap((result) => result.applied).sort()).toEqual([
            '001_init',
            '002_serverless',
            '003_upload_tickets',
          ]);
          const recorded = await fresh.db.query('SELECT version FROM schema_migrations');
          expect(recorded.rowCount).toBe(3);
        } finally {
          await Promise.all(opened.map((handle) => handle.close()));
          await fresh.dispose();
        }
      }
    }, 120_000);

    it('finds its own table in the first schema of the search path, not in "public": a second start applies nothing', async () => {
      // A role-named schema, or `options=-csearch_path=app,public` in the connection string, puts schema_migrations somewhere else.
      const fresh = await create();
      const opened: Db[] = [];
      try {
        const name =
          (await fresh.db.query<{ name: string }>('SELECT current_database() AS name')).rows[0]?.name ?? '';
        await fresh.db.exec('CREATE SCHEMA app');
        let handle = fresh.db;
        if (kind === 'pg' && fresh.url !== undefined) {
          // (New connections only: the pool of `fresh` was opened before.)
          await fresh.db.exec(`ALTER DATABASE "${name}" SET search_path = app, public`);
          handle = await createDb({ databaseUrl: fresh.url, pgliteDataDir: 'memory://', databasePoolMax: 2 });
          opened.push(handle);
        } else {
          await fresh.db.exec('SET search_path = app, public');
        }
        const first = await runMigrations(handle);
        expect(first.applied).toEqual(['001_init', '002_serverless', '003_upload_tickets']);
        const place = await handle.query<{ table_schema: string }>(
          `SELECT table_schema FROM information_schema.tables WHERE table_name = 'schema_migrations'`,
        );
        expect(place.rows).toEqual([{ table_schema: 'app' }]);
        // The start that follows (every cold start of a function) must find that table, not run 001 again and fail on it.
        expect((await runMigrations(handle)).applied).toEqual([]);
      } finally {
        await Promise.all(opened.map((handle) => handle.close()));
        await fresh.dispose();
      }
    }, 60_000);

    it('creates the vector extension', async () => {
      const extension = await db.query<{ extname: string }>(
        `SELECT extname FROM pg_extension WHERE extname = 'vector'`,
      );
      expect(extension.rows).toEqual([{ extname: 'vector' }]);
    });

    it('applies pending files in order and rolls a failing migration back completely', async () => {
      const { db: scratch, dispose: disposeScratch } = await create();
      const directory = await mkdtemp(path.join(REPO_ROOT, '.data', 'tmp', 'migrations-'));
      try {
        await writeFile(
          path.join(directory, '001_first.sql'),
          `CREATE TABLE schema_migrations (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now()); CREATE TABLE first_table (id int);`,
        );
        await writeFile(
          path.join(directory, '002_broken.sql'),
          `CREATE TABLE half_applied (id int); SELECT * FROM does_not_exist;`,
        );
        await expect(runMigrations(scratch, directory)).rejects.toThrow(/does_not_exist/);
        const versions = await scratch.query<{ version: string }>('SELECT version FROM schema_migrations');
        expect(versions.rows).toEqual([{ version: '001_first' }]);
        const halfApplied = await scratch.query(`SELECT to_regclass('public.half_applied') AS name`);
        expect(halfApplied.rows[0]).toEqual({ name: null });
      } finally {
        await disposeScratch();
        await rm(directory, { recursive: true, force: true });
      }
    });
  });

  describe('transactions', () => {
    it('commits when the callback resolves', async () => {
      const id = randomUUID();
      await db.transaction(async (tx) => {
        await tx.query('INSERT INTO sessions (id) VALUES ($1)', [id]);
      });
      expect((await db.query('SELECT 1 FROM sessions WHERE id = $1', [id])).rowCount).toBe(1);
    });

    it('rolls back when the callback throws', async () => {
      const id = randomUUID();
      await expect(
        db.transaction(async (tx) => {
          await tx.query('INSERT INTO sessions (id) VALUES ($1)', [id]);
          throw new Error('abort');
        }),
      ).rejects.toThrow('abort');
      expect((await db.query('SELECT 1 FROM sessions WHERE id = $1', [id])).rowCount).toBe(0);
    });

    it('reports affected rows for writes', async () => {
      const id = randomUUID();
      await db.query('INSERT INTO sessions (id) VALUES ($1)', [id]);
      const removed = await db.query('DELETE FROM sessions WHERE id = $1', [id]);
      expect(removed.rowCount).toBe(1);
    });
  });

  describe('schema behaviour', () => {
    it('stores and queries vectors with the <=> operator, scoped to one document', async () => {
      const documentId = await insertDocument(randomUUID());
      const otherDocumentId = await insertDocument(randomUUID());
      const near = await insertChunk(documentId, 0, 'near');
      const far = await insertChunk(documentId, 1, 'far');
      const elsewhere = await insertChunk(otherDocumentId, 0, 'elsewhere');
      for (const [chunk, vector] of [
        [near, '[1,0,0]'],
        [far, '[0,1,0]'],
        [elsewhere, '[1,0,0]'],
      ] as const) {
        await db.query(
          `INSERT INTO chunk_embeddings (chunk_id, model, dims, embedding) VALUES ($1, 'test-model', 3, $2::vector)`,
          [chunk, vector],
        );
      }
      const ranked = await db.query<{ chunk_id: string; distance: number }>(
        `SELECT e.chunk_id, e.embedding <=> $1::vector AS distance
         FROM chunk_embeddings e JOIN document_chunks c ON c.id = e.chunk_id
        WHERE c.document_id = $2 AND e.model = 'test-model'
        ORDER BY e.embedding <=> $1::vector LIMIT 5`,
        ['[0.9,0.1,0]', documentId],
      );
      expect(ranked.rows.map((row) => row.chunk_id)).toEqual([near, far]);
      expect(ranked.rows[0]?.distance).toBeLessThan(ranked.rows[1]?.distance ?? 0);
    });

    it('keeps embeddings of different dimensions in the same column', async () => {
      const documentId = await insertDocument(randomUUID());
      const chunk = await insertChunk(documentId, 0, 'text');
      await db.query(
        `INSERT INTO chunk_embeddings (chunk_id, model, dims, embedding) VALUES ($1, 'small', 2, '[1,2]')`,
        [chunk],
      );
      await db.query(
        `INSERT INTO chunk_embeddings (chunk_id, model, dims, embedding) VALUES ($1, 'large', 4, '[1,2,3,4]')`,
        [chunk],
      );
      const rows = await db.query<{ model: string; dims: number }>(
        'SELECT model, dims FROM chunk_embeddings WHERE chunk_id = $1 ORDER BY dims',
        [chunk],
      );
      expect(rows.rows).toEqual([
        { model: 'small', dims: 2 },
        { model: 'large', dims: 4 },
      ]);
    });

    it('generates the full-text vector from search_text', async () => {
      const documentId = await insertDocument(randomUUID());
      await insertChunk(documentId, 0, 'the lost archive ms 4471');
      await insertChunk(documentId, 1, 'والكتاب كتاب');
      const english = await db.query(
        `SELECT 1 FROM document_chunks WHERE document_id = $1 AND tsv @@ websearch_to_tsquery('simple', 'archive 4471')`,
        [documentId],
      );
      expect(english.rowCount).toBe(1);
      const arabic = await db.query(
        `SELECT 1 FROM document_chunks WHERE document_id = $1 AND tsv @@ websearch_to_tsquery('simple', 'كتاب')`,
        [documentId],
      );
      expect(arabic.rowCount).toBe(1);
    });

    it('rejects an unknown document status or direction', async () => {
      const sessionId = randomUUID();
      await db.query('INSERT INTO sessions (id) VALUES ($1)', [sessionId]);
      const insert = (status: string, direction: string) =>
        db.query(
          `INSERT INTO documents (id, session_id, filename, byte_size, sha256, status, direction, storage_key, expires_at)
         VALUES ($1, $2, 'a.pdf', 1, 'x', $3, $4, 'k', now())`,
          [randomUUID(), sessionId, status, direction],
        );
      await expect(insert('deleted', 'ltr')).rejects.toThrow();
      await expect(insert('ready', 'up')).rejects.toThrow();
    });

    it("deletes a session's documents, chunks and embeddings with the session", async () => {
      const sessionId = randomUUID();
      const documentId = await insertDocument(sessionId);
      const chunk = await insertChunk(documentId, 0, 'bye');
      await db.query(
        `INSERT INTO chunk_embeddings (chunk_id, model, dims, embedding) VALUES ($1, 'm', 1, '[1]')`,
        [chunk],
      );
      const remaining = () =>
        db.query<{ documents: number; chunks: number; embeddings: number }>(
          `SELECT (SELECT count(*) FROM documents WHERE id = $1)::int AS documents,
                (SELECT count(*) FROM document_chunks WHERE id = $2)::int AS chunks,
                (SELECT count(*) FROM chunk_embeddings WHERE chunk_id = $2)::int AS embeddings`,
          [documentId, chunk],
        );
      expect((await remaining()).rows[0]).toEqual({ documents: 1, chunks: 1, embeddings: 1 });
      await db.query('DELETE FROM sessions WHERE id = $1', [sessionId]);
      expect((await remaining()).rows[0]).toEqual({ documents: 0, chunks: 0, embeddings: 0 });
    });
  });
});
