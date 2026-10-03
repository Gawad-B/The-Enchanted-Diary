import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from '../src/db/client.js';
import { FakeEmbeddings, Gate } from './doubles/fake-embeddings.js';
import {
  POSTGRES_SKIP_HINT,
  createMigratedPgTestDb,
  nextTestDirectory,
  postgresUrl,
  resetCounters,
  testConfig,
  type TestDb,
} from './helpers.js';
import {
  keepTicking,
  startServer,
  summaryOf,
  tickOnce,
  tickUntilDone,
  waitUntil,
  type TestServer,
} from './http-helpers.js';

/*
 * The ticks on a real PostgreSQL (TEST_DATABASE_URL, the docker-compose service of `npm run db:up`), where connections really run
 * side by side: ticks that arrive together, a document deleted or replaced while a tick commits. PGlite has one connection and
 * cannot show a race; these tests are skipped without a server.
 */

const adminUrl = postgresUrl();

describe.skipIf(adminUrl === undefined)(
  adminUrl === undefined
    ? `the ticks on a real PostgreSQL (${POSTGRES_SKIP_HINT})`
    : 'the ticks on a real PostgreSQL',
  () => {
    let test: TestDb;
    let db: Db;
    const servers: TestServer[] = [];

    beforeAll(async () => {
      test = await createMigratedPgTestDb(adminUrl ?? '', { poolMax: 12 });
      db = test.db;
    });
    afterEach(async () => {
      await Promise.all(servers.splice(0).map((started) => started.close()));
      await resetCounters(db);
      await db.query('DELETE FROM documents');
    });
    afterAll(async () => {
      await test.dispose();
    });

    async function server(
      env: Record<string, string> = {},
      embeddings = new FakeEmbeddings(),
    ): Promise<TestServer> {
      const started = await startServer(
        db,
        testConfig({ INGEST_TICK_BUDGET_MS: '1000', MAX_QUEUED_JOBS: '1000', ...env }),
        { embeddings },
      );
      servers.push(started);
      return started;
    }

    it('leaves exactly one of several simultaneous ticks working, on separate connections, and the document is read to the end', async () => {
      const gate = new Gate();
      const started = await server(
        { INGEST_TICK_BUDGET_MS: '45000' },
        new FakeEmbeddings({ onPassages: gate.hold }),
      );
      const client = started.client();
      const accepted = summaryOf(await client.uploadFixture('text-en.pdf'));
      const working = tickOnce(client, accepted.id);
      await waitUntil(() => gate.entered > 0, 'the first tick to reach the embedding step');
      const others = await Promise.all(Array.from({ length: 6 }, () => tickOnce(client, accepted.id)));
      for (const other of others) {
        expect(other.status).toBe('running');
        expect(other.retryAfterMs).toBeGreaterThan(0);
      }
      expect(gate.entered).toBe(1);
      gate.open();
      expect((await working).status).toBe('ready');
      expect(
        (
          await db.query<{ n: number }>(
            'SELECT count(*)::int AS n FROM chunk_embeddings e JOIN document_chunks c ON c.id = e.chunk_id WHERE c.document_id = $1',
            [accepted.id],
          )
        ).rows[0]?.n,
      ).toBe(5);
    }, 120_000);

    /**
     * Two instances of one deployment: the same database, the same secret and the same storage (a Blob store; here one directory),
     * each its own runner (a tick is cancelled only by its own).
     */
    const SHARED = {
      SESSION_SECRET: 'postgres-test-secret-postgres-test-secret-0123456789',
      STORAGE_DIR: nextTestDirectory('storage-shared'),
    };
    const asSameSession = (other: TestServer, client: ReturnType<TestServer['client']>) => {
      const second = other.client();
      second.cookie = client.cookie;
      return second;
    };

    it('answers 204 to a DELETE that arrives on ANOTHER instance while ticks are committing, never a 500 (no deadlock), and leaves nothing of the document', async () => {
      // The instance that ticks and the one that deletes are different, so the delete cannot cancel the tick first and wait for it:
      // the two really meet in the database.
      const started = await server(SHARED);
      const other = await server(SHARED);
      for (let trial = 0; trial < 6; trial += 1) {
        const client = started.client();
        const accepted = summaryOf(await client.uploadFixture('text-en.pdf'));
        const ticking = keepTicking(client, accepted.id);
        await new Promise((resolve) => setTimeout(resolve, 50 + trial * 130));
        const removal = await started.client().delete(`/api/documents/${accepted.id}`); // another session: 404, not this one
        expect(removal.statusCode).toBe(404);
        const removed = await asSameSession(other, client).delete(`/api/documents/${accepted.id}`);
        expect(removed.statusCode, removed.body).toBe(204);
        const ended = await ticking;
        // The tab that was ticking stops at a 404 (or got the document ready before the delete came): never a server error.
        expect(ended.stoppedBy === null || ended.stoppedBy.statusCode === 404).toBe(true);
        for (const table of ['documents', 'ingest_jobs', 'ingest_stage_data', 'document_chunks']) {
          const column =
            table === 'documents' ? 'id' : table === 'document_chunks' ? 'document_id' : 'document_id';
          expect(
            (
              await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table} WHERE ${column} = $1`, [
                accepted.id,
              ])
            ).rows[0]?.n,
            `${table} after trial ${String(trial)}`,
          ).toBe(0);
        }
      }
    }, 180_000);

    it('replaces the document a session is still reading, with an upload on ANOTHER instance, while ticks are committing: 202, never a 500', async () => {
      const started = await server(SHARED);
      const other = await server(SHARED);
      for (let trial = 0; trial < 4; trial += 1) {
        const client = started.client();
        const first = summaryOf(await client.uploadFixture('text-en.pdf'));
        const ticking = keepTicking(client, first.id);
        await new Promise((resolve) => setTimeout(resolve, 80 + trial * 200));
        const second = await asSameSession(other, client).uploadFixture('arabic.pdf');
        expect(second.statusCode, second.body).toBe(202);
        const ended = await ticking;
        expect(ended.stoppedBy === null || ended.stoppedBy.statusCode === 404).toBe(true);
        const document = summaryOf(second);
        const answers = await tickUntilDone(client, document.id, { timeoutMs: 150_000 });
        expect(answers.at(-1)?.status, JSON.stringify(answers.at(-1))).toBe('ready');
        expect((await client.get(`/api/documents/${first.id}`)).statusCode).toBe(404);
      }
    }, 240_000);
  },
);
