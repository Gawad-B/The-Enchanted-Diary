import { randomUUID } from 'node:crypto';
import { SessionDocumentResponseSchema } from '@enchanted/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, type Db } from '../src/db/client.js';
import { documentsRepo } from '../src/db/repositories/documents.js';
import { EmbeddingError } from '../src/embeddings/provider.js';
import { Gate, FakeEmbeddings } from './doubles/fake-embeddings.js';
import {
  Client,
  detailOf,
  errorOf,
  keepTicking,
  sessionOf,
  startServer,
  summaryOf,
  tickUntilDone,
  waitForDocument,
  waitUntil,
  type TestServer,
} from './http-helpers.js';
import { resetCounters, testConfig } from './helpers.js';

let db: Db;
const servers: TestServer[] = [];

beforeAll(async () => {
  db = await createDb(testConfig());
});
afterAll(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
  await db.close();
});

async function server(env: Record<string, string> = {}, embeddings?: FakeEmbeddings): Promise<TestServer> {
  // Documents that nobody reads must not fill the line (the test of the line sets MAX_QUEUED_JOBS itself).
  const started = await startServer(
    db,
    testConfig({ MAX_QUEUED_JOBS: '1000', ...env }),
    embeddings === undefined ? {} : { embeddings },
  );
  servers.push(started);
  return started;
}

const count = async (sql: string, params: unknown[]): Promise<number> =>
  (await db.query<{ n: number }>(sql, params)).rows[0]?.n ?? -1;
const rowsOf = (table: string, id: string): Promise<number> =>
  count(
    `SELECT count(*)::int AS n FROM ${table} WHERE ${table === 'documents' ? 'id' : 'document_id'} = $1`,
    [id],
  );
const fileExists = async (started: TestServer, id: string): Promise<boolean> =>
  (await started.app.ingestion.storage.stat(`${id}.pdf`)) !== null;

describe('DELETE /api/documents/:id', () => {
  it('removes the rows (pages, chunks, embeddings) and the file, and is invisible to other sessions', async () => {
    const started = await server();
    const client = started.client();
    const ready = await waitForDocument(client, summaryOf(await client.uploadFixture('text-en.pdf')).id);
    expect(await rowsOf('document_pages', ready.id)).toBe(5);
    expect(await fileExists(started, ready.id)).toBe(true);

    const stranger = started.client();
    expect((await stranger.delete(`/api/documents/${ready.id}`)).statusCode).toBe(404);
    expect(await rowsOf('documents', ready.id)).toBe(1); // untouched

    const response = await client.delete(`/api/documents/${ready.id}`);
    expect(response.statusCode).toBe(204);
    expect(response.body).toBe('');
    for (const table of ['documents', 'document_pages', 'document_chunks'])
      expect(await rowsOf(table, ready.id)).toBe(0);
    expect(
      await count(
        'SELECT count(*)::int AS n FROM chunk_embeddings e WHERE NOT EXISTS (SELECT 1 FROM document_chunks c WHERE c.id = e.chunk_id)',
        [],
      ),
    ).toBe(0);
    expect(await fileExists(started, ready.id)).toBe(false);
    expect((await client.get(`/api/documents/${ready.id}`)).statusCode).toBe(404);
    expect((await client.delete(`/api/documents/${ready.id}`)).statusCode).toBe(404);
  }, 90_000);

  it('cancels a tick that is embedding and removes everything it had stored', async () => {
    const gate = new Gate();
    const started = await server({}, new FakeEmbeddings({ onPassages: gate.hold }));
    const client = started.client();
    const accepted = summaryOf(await client.uploadFixture('text-en.pdf'));
    const ticking = keepTicking(client, accepted.id);
    await waitUntil(() => gate.entered > 0, 'the job to reach the embedding step');
    expect((await detailOf(client, accepted.id)).stage).toBe('embedding');

    const asked = Date.now();
    expect((await client.delete(`/api/documents/${accepted.id}`)).statusCode).toBe(204);
    expect(Date.now() - asked).toBeLessThan(3000);
    // The tick that was running answers that the document is gone: nothing comes back to life.
    expect((await ticking).stoppedBy).toEqual({ statusCode: 404, code: 'DOCUMENT_NOT_FOUND' });
    for (const table of [
      'documents',
      'document_pages',
      'document_chunks',
      'ingest_jobs',
      'ingest_stage_data',
    ])
      expect(await rowsOf(table, accepted.id)).toBe(0);
    expect(await fileExists(started, accepted.id)).toBe(false);
    gate.open();
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(await rowsOf('documents', accepted.id)).toBe(0);
  }, 90_000);

  it('cancels a tick whose worker thread is busy (a memory bomb of images) at once', async () => {
    // The page timeout and the memory watchdog are set out of the way: only the DELETE can stop this job.
    const started = await server({
      INGEST_PAGE_TIMEOUT_MS: '60000',
      INGEST_WORKER_MAX_RSS_GROWTH_MB: '16384',
    });
    const client = started.client();
    const accepted = summaryOf(await client.uploadFixture('hostile-images.pdf'));
    const ticking = keepTicking(client, accepted.id);
    await waitUntil(
      async () => (await detailOf(client, accepted.id)).stage === 'parsing',
      'the job to start parsing',
    );
    await new Promise((resolve) => setTimeout(resolve, 1500)); // the worker is decoding the images by now
    const asked = Date.now();
    expect((await client.delete(`/api/documents/${accepted.id}`)).statusCode).toBe(204);
    expect(Date.now() - asked).toBeLessThan(3000);
    expect((await ticking).stoppedBy?.code).toBe('DOCUMENT_NOT_FOUND');
    expect(await rowsOf('documents', accepted.id)).toBe(0);
    expect(await fileExists(started, accepted.id)).toBe(false);
  }, 90_000);

  it('answers the tick in flight with 404 when the document is replaced by a new upload or the session is reset', async () => {
    const gate = new Gate();
    const started = await server({}, new FakeEmbeddings({ onPassages: gate.hold }));
    const client = started.client();
    const first = summaryOf(await client.uploadFixture('text-en.pdf'));
    const firstTicks = keepTicking(client, first.id);
    await waitUntil(() => gate.entered > 0, 'the first job to reach embedding');
    const second = summaryOf(await client.uploadFixture('arabic.pdf'));
    expect((await firstTicks).stoppedBy).toEqual({ statusCode: 404, code: 'DOCUMENT_NOT_FOUND' });
    const entered = gate.entered;
    const secondTicks = keepTicking(client, second.id);
    await waitUntil(() => gate.entered > entered, 'the second job to reach embedding');
    expect((await client.request('POST', '/api/session/reset')).statusCode).toBe(204);
    expect((await secondTicks).stoppedBy?.code).toBe('DOCUMENT_NOT_FOUND');
    gate.open();
  }, 90_000);

  it('answers 404 for ids that are not documents of the session, whatever they look like', async () => {
    const { client: make } = await server();
    const client = make();
    for (const id of ['nope', '123', randomUUID(), '../../etc/passwd', 'x'.repeat(150), '%00']) {
      for (const suffix of ['', '/progress', '/file']) {
        const response = await client.get(`/api/documents/${id}${suffix}`);
        expect(response.statusCode, `${id}${suffix}`).toBe(404);
        expect(errorOf(response).code).toBe('DOCUMENT_NOT_FOUND');
      }
      expect((await client.delete(`/api/documents/${id}`)).statusCode).toBe(404);
      expect((await client.request('POST', `/api/documents/${id}/tick`)).statusCode).toBe(404);
    }
  });
});

describe('one active ingestion per session, the queue and the limits', () => {
  it('replaces the session’s other processing document when a new one is uploaded', async () => {
    const gate = new Gate();
    const started = await server({}, new FakeEmbeddings({ onPassages: gate.hold }));
    const client = started.client();
    const first = summaryOf(await client.uploadFixture('text-en.pdf'));
    const firstTicks = keepTicking(client, first.id);
    await waitUntil(() => gate.entered > 0, 'the first job to reach embedding');
    const second = summaryOf(await client.uploadFixture('arabic.pdf'));
    await firstTicks;
    expect((await client.get(`/api/documents/${first.id}`)).statusCode).toBe(404); // cancelled and removed
    expect(await rowsOf('documents', first.id)).toBe(0);
    expect(await fileExists(started, first.id)).toBe(false);
    expect(
      (await documentsRepo.listProcessingForSession(db, await sessionOf(client))).map((row) => row.id),
    ).toEqual([second.id]);
    gate.open();
    expect((await waitForDocument(client, second.id)).status).toBe('ready');
  }, 90_000);

  it('makes the second document wait for its turn with a real position, and answers 429 when the archive is busy (MAX_QUEUED_JOBS)', async () => {
    // The line is the database's: what the tests before this one left reading must not be in it.
    await db.query('DELETE FROM documents');
    const gate = new Gate();
    const started = await server(
      { MAX_QUEUED_JOBS: '1', INGEST_CONCURRENCY: '1' },
      new FakeEmbeddings({ onPassages: gate.hold }),
    );
    const a = started.client();
    const b = started.client();
    const c = started.client();
    const running = summaryOf(await a.uploadFixture('text-en.pdf'));
    const runningTicks = keepTicking(a, running.id);
    await waitUntil(() => gate.entered > 0, 'the first job to run');
    const waiting = summaryOf(await b.uploadFixture('text-en.pdf'));
    // A tick of the second document finds the only lease taken: it waits, and says its place.
    const asked = await b.request('POST', `/api/documents/${waiting.id}/tick`);
    expect(asked.json()).toMatchObject({
      status: 'running',
      progress: { stage: 'queued', unit: 'queue', queuePosition: 1 },
      retryAfterMs: expect.any(Number) as number,
    });

    const refused = await c.uploadFixture('text-en.pdf');
    expect(refused.statusCode).toBe(429);
    expect(errorOf(refused)).toMatchObject({
      code: 'RATE_LIMITED',
      message: expect.stringContaining('busy') as string,
    });
    // Nothing of the refused upload is left: no row, no file.
    const sessionC = await sessionOf(c);
    expect(await documentsRepo.listForSession(db, sessionC)).toEqual([]);

    gate.open();
    expect((await runningTicks).answers.at(-1)?.status).toBe('ready');
    expect((await waitForDocument(b, waiting.id)).status).toBe('ready');
    // A slot is free again.
    expect((await c.uploadFixture('text-en.pdf')).statusCode).toBe(202);
  }, 120_000);

  it('limits uploads per session (UPLOADS_PER_HOUR) and per IP (UPLOADS_PER_HOUR_PER_IP), also for refused files', async () => {
    const bySession = await server({ UPLOADS_PER_HOUR: '2', UPLOADS_PER_HOUR_PER_IP: '100' });
    await resetCounters(db); // the counters are in the database this file shares (and it is migrated once a server is up)
    const client = bySession.client();
    expect([
      (await client.uploadFixture('not-a-pdf.pdf')).statusCode,
      (await client.uploadFixture('not-a-pdf.pdf')).statusCode,
      (await client.uploadFixture('not-a-pdf.pdf')).statusCode,
    ]).toEqual([415, 415, 429]);
    const limited = await client.uploadFixture('not-a-pdf.pdf');
    expect(errorOf(limited).code).toBe('RATE_LIMITED');
    expect(limited.headers['retry-after']).toBeDefined();
    expect((await bySession.client().uploadFixture('not-a-pdf.pdf')).statusCode).toBe(415); // another session has its own budget

    await resetCounters(db);
    const byIp = await server({ UPLOADS_PER_HOUR: '100', UPLOADS_PER_HOUR_PER_IP: '2' });
    expect([
      (await byIp.client().uploadFixture('not-a-pdf.pdf')).statusCode,
      (await byIp.client().uploadFixture('not-a-pdf.pdf')).statusCode,
      (await byIp.client().uploadFixture('not-a-pdf.pdf')).statusCode, // a new session each time: the IP is limited
    ]).toEqual([415, 415, 429]);
    await resetCounters(db);
  });
});

describe('failures and limits of a job', () => {
  it('fails with EMBEDDING_FAILED when the embedding model keeps failing, with a curated message, and keeps the file', async () => {
    const started = await server(
      {},
      new FakeEmbeddings({
        failWith: new EmbeddingError('model exploded at /home/someone/.data/models/x.onnx', {
          retryable: true,
        }),
      }),
    );
    const client = started.client();
    const failed = await waitForDocument(client, summaryOf(await client.uploadFixture('text-en.pdf')).id);
    expect(failed.status).toBe('failed');
    expect(failed.error?.code).toBe('EMBEDDING_FAILED');
    expect(failed.error?.message).not.toContain('/home/someone');
    expect(await rowsOf('document_chunks', failed.id)).toBe(0); // nothing half stored
    // It failed three ticks in a row for a reason that may pass (the service said a retry could help): nothing is known against
    // the file, which is kept until retention removes it.
    expect(await fileExists(started, failed.id)).toBe(true);
  }, 90_000);

  it('fails at once, and also keeps the file, when the embedding model refuses for good (a verdict about the model, not the file)', async () => {
    const started = await server(
      {},
      new FakeEmbeddings({ failWith: new EmbeddingError('bad request', { retryable: false, status: 400 }) }),
    );
    const client = started.client();
    const accepted = summaryOf(await client.uploadFixture('text-en.pdf'));
    const answers = await tickUntilDone(client, accepted.id);
    expect(answers.filter((answer) => answer.retryAfterMs !== undefined)).toEqual([]); // no "come back"
    expect(answers.at(-1)).toMatchObject({ status: 'failed', error: { code: 'EMBEDDING_FAILED' } });
    expect(await fileExists(started, accepted.id)).toBe(true);
  }, 90_000);

  it('fails a job that exceeds INGEST_JOB_TIMEOUT_MS as unreadable', async () => {
    const started = await server({ INGEST_JOB_TIMEOUT_MS: '5000' }, new FakeEmbeddings({ delayMs: 60_000 }));
    const client = started.client();
    const failed = await waitForDocument(client, summaryOf(await client.uploadFixture('text-en.pdf')).id);
    expect(failed.status).toBe('failed');
    expect(failed.error?.code).toBe('PDF_UNREADABLE');
    expect(failed.error?.message).toContain('took too long');
  }, 90_000);

  it('survives a memory bomb of images with the DEFAULT limits: PDF_UNREADABLE, a bounded process, /api/health answering', async () => {
    // 40 images of 14.4 megapixels on one page: about 2 GB of decoded pixels, outside every heap limit. The defaults
    // (a 512 MB growth limit, a 20 s page timeout) must stop it; nothing is shrunk for the test.
    const started = await server();
    const client = started.client();
    const base = process.memoryUsage.rss();
    let peak = 0;
    const accepted = summaryOf(await client.uploadFixture('hostile-images.pdf'));
    const latencies: number[] = [];
    const state = { finished: false };
    const ticking = keepTicking(client, accepted.id).finally(() => {
      state.finished = true;
    });
    while (!state.finished) {
      const began = Date.now();
      const health = await started.app.inject('/api/health');
      latencies.push(Date.now() - began);
      expect(health.statusCode).toBe(200);
      peak = Math.max(peak, process.memoryUsage.rss() - base);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    await ticking;
    const failed = await detailOf(client, accepted.id);
    expect(failed.status).toBe('failed');
    expect(failed.error?.code).toBe('PDF_UNREADABLE');
    expect(failed.error?.message).toBe(
      'The pages appear damaged or unreadable. (1 of 1 pages could not be read)',
    );
    expect(latencies.length).toBeGreaterThan(3);
    expect(Math.max(...latencies)).toBeLessThan(500); // the main thread was never blocked by the PDF
    expect(peak / 1048576).toBeLessThan(1300); // unbounded it is more than 2,000 MB; measured about 850 MB
    expect(await fileExists(started, accepted.id)).toBe(false);
  }, 90_000);

  it('fails an image above the extraction limit as PDF_UNREADABLE, not as an empty document (oversized-image.pdf)', async () => {
    const started = await server();
    const client = started.client();
    const failed = await waitForDocument(
      client,
      summaryOf(await client.uploadFixture('oversized-image.pdf')).id,
    );
    expect(failed.status).toBe('failed');
    expect(failed.error?.code).toBe('PDF_UNREADABLE');
    expect(failed.error?.message).toContain('hold images too large to decode');
  }, 90_000);
});

describe('sessions, expiry and recovery', () => {
  it('POST /api/session/reset removes the session’s documents and files and gives a fresh session', async () => {
    const started = await server();
    const client = started.client();
    const one = await waitForDocument(client, summaryOf(await client.uploadFixture('text-en.pdf')).id);
    const oldSession = await sessionOf(client);
    const oldCookie = client.cookie;
    const response = await client.request('POST', '/api/session/reset');
    expect(response.statusCode).toBe(204);
    expect(client.cookie).not.toBe(oldCookie); // a new signed cookie was issued
    expect(await rowsOf('documents', one.id)).toBe(0);
    expect(await fileExists(started, one.id)).toBe(false);
    expect(await count('SELECT count(*)::int AS n FROM sessions WHERE id = $1', [oldSession])).toBe(0);
    expect(
      SessionDocumentResponseSchema.parse((await client.get('/api/session/document')).json()).document,
    ).toBeNull();
    expect((await client.get(`/api/documents/${one.id}`)).statusCode).toBe(404);
    // The old cookie still works as a (new, empty) session: it cannot see the removed document either.
    const stale = new Client(started.app);
    stale.cookie = oldCookie;
    expect(
      SessionDocumentResponseSchema.parse((await stale.get('/api/session/document')).json()).document,
    ).toBeNull();
  }, 90_000);

  it('GET /api/session/document gives the newest ready or processing document, never a failed one', async () => {
    const gate = new Gate();
    const started = await server({}, new FakeEmbeddings({ onPassages: gate.hold }));
    const client = started.client();
    expect(SessionDocumentResponseSchema.parse((await client.get('/api/session/document')).json())).toEqual({
      document: null,
    });
    const empty = summaryOf(await client.uploadFixture('empty.pdf')); // fails (no text) once the job runs
    await waitForDocument(client, empty.id);
    expect(
      SessionDocumentResponseSchema.parse((await client.get('/api/session/document')).json()).document,
    ).toBeNull();
    const processing = summaryOf(await client.uploadFixture('text-en.pdf'));
    const ticking = keepTicking(client, processing.id);
    await waitUntil(() => gate.entered > 0, 'the job to reach embedding');
    const during = SessionDocumentResponseSchema.parse(
      (await client.get('/api/session/document')).json(),
    ).document;
    expect(during).toMatchObject({ id: processing.id, status: 'processing', stage: 'embedding' });
    expect((await client.get('/api/session/document')).headers['cache-control']).toBe('no-store');
    gate.open();
    expect((await ticking).answers.at(-1)?.status).toBe('ready');
    expect(
      SessionDocumentResponseSchema.parse((await client.get('/api/session/document')).json()).document
        ?.status,
    ).toBe('ready');
  }, 90_000);

  it('slides the expiry on access, capped at DOCUMENT_MAX_RETENTION_HOURS from creation', async () => {
    const started = await server({ DOCUMENT_RETENTION_HOURS: '24', DOCUMENT_MAX_RETENTION_HOURS: '72' });
    const client = started.client();
    const ready = await waitForDocument(client, summaryOf(await client.uploadFixture('text-en.pdf')).id);
    const hours = (iso: string): number => (new Date(iso).getTime() - Date.now()) / 3_600_000;
    await db.query(`UPDATE documents SET expires_at = now() + interval '1 hour' WHERE id = $1`, [ready.id]);
    expect(hours((await detailOf(client, ready.id)).expiresAt)).toBeGreaterThan(23.9);
    expect(hours((await detailOf(client, ready.id)).expiresAt)).toBeLessThan(24.1);
    // 71.5 hours after creation the next day would pass the 72-hour cap: the cap wins.
    await db.query(
      `UPDATE documents SET created_at = now() - interval '71 hours 30 minutes', expires_at = now() + interval '10 minutes' WHERE id = $1`,
      [ready.id],
    );
    const capped = hours((await detailOf(client, ready.id)).expiresAt);
    expect(capped).toBeGreaterThan(0.4);
    expect(capped).toBeLessThan(0.6);
    // An expired document no longer exists for the session.
    await db.query(`UPDATE documents SET expires_at = now() - interval '1 minute' WHERE id = $1`, [ready.id]);
    expect((await client.get(`/api/documents/${ready.id}`)).statusCode).toBe(404);
    expect(
      SessionDocumentResponseSchema.parse((await client.get('/api/session/document')).json()).document,
    ).toBeNull();
  }, 90_000);

  it('sweeps expired documents and their files through the ingestion service', async () => {
    const started = await server();
    const client = started.client();
    const ready = await waitForDocument(client, summaryOf(await client.uploadFixture('text-en.pdf')).id);
    await db.query(`UPDATE documents SET expires_at = now() - interval '1 minute' WHERE id = $1`, [ready.id]);
    const result = await started.app.ingestion.sweep();
    expect(result.expiredDocuments).toBeGreaterThanOrEqual(1); // this file's other tests leave expired documents too
    expect(await rowsOf('documents', ready.id)).toBe(0);
    expect(await fileExists(started, ready.id)).toBe(false);
  }, 90_000);
});
