import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createDb, type Db } from '../src/db/client.js';
import { chunksRepo } from '../src/db/repositories/chunks.js';
import { IngestWorkerHost } from '../src/ingest/worker/host.js';
import {
  detailOf,
  startServer,
  summaryOf,
  tickUntilDone,
  waitForDocument,
  type TestServer,
} from './http-helpers.js';
import { nextTestDirectory, resetCounters, testConfig } from './helpers.js';
import type { FakeGeminiScript } from './ocr-doubles/fake-gemini-worker-main.js';

/*
 * The OCR stage of the pipeline end to end (upload, worker threads, database) with Gemini as the OCR provider, the default:
 * the OCR thread runs the real task and the real provider over a stand-in for the Gemini client (nothing reaches Google).
 * What is checked is what is new with Gemini: several pages per request, no confidence, page-level highlights, a page
 * left out of an answer asked for again, and a daily quota that runs out in the middle of a document.
 */

const FAKE_ENTRY = {
  url: new URL('./ocr-doubles/fake-gemini-worker.mjs', import.meta.url),
  execArgv: ['--conditions=source'],
};
const SENTENCE = 'The surveyors arrived at the harbour of Wexcombe on a grey morning in spring.';

let db: Db;
const servers: TestServer[] = [];

beforeAll(async () => {
  db = await createDb(testConfig());
});
afterAll(async () => {
  await db.close();
});
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
  delete process.env.FAKE_GEMINI;
});

/** A server whose OCR threads read with Gemini, over a stand-in client that plays `script`. */
async function geminiServer(
  env: Record<string, string> = {},
  script: FakeGeminiScript = {},
): Promise<TestServer> {
  process.env.FAKE_GEMINI = JSON.stringify({ firstLine: SENTENCE, ...script });
  const config = testConfig({
    OCR_PROVIDER: 'gemini',
    GEMINI_API_KEY: 'test-key-not-real',
    OCR_DPI: '72',
    ...env,
  });
  const workers = new IngestWorkerHost(
    {
      maxOldGenerationSizeMb: config.ingestWorkerMaxOldMb,
      pageTimeoutMs: config.ingestPageTimeoutMs,
      maxRssGrowthMb: config.ingestWorkerMaxRssGrowthMb,
    },
    { entry: FAKE_ENTRY },
  );
  const server = await startServer(db, config, { deps: { ingestion: { workers } } });
  servers.push(server);
  return server;
}

const chunkTexts = async (documentId: string): Promise<string> =>
  (await chunksRepo.forDocument(db, documentId)).map((chunk) => chunk.content).join('\n');

describe('the OCR stage with Gemini', () => {
  it('reads the three pages of a scan in one request: OCR pages without a confidence, highlighted as whole pages', async () => {
    const server = await geminiServer();
    const client = server.client();
    const ready = await waitForDocument(
      client,
      summaryOf(await client.uploadFixture('scanned-three.pdf')).id,
    );
    expect(ready.status).toBe('ready');
    expect(ready.warnings).toEqual([]); // no confidence: nothing is flagged LOW_TEXT_QUALITY
    expect(ready.pages.map((page) => [page.pageNumber, page.extraction, page.ocrConfidence])).toEqual([
      [1, 'ocr', null],
      [2, 'ocr', null],
      [3, 'ocr', null],
    ]);
    expect(ready.pages.every((page) => page.language === 'en')).toBe(true);
    const texts = await chunkTexts(ready.id);
    for (const page of [1, 2, 3]) expect(texts).toContain(`${SENTENCE} 1 page ${String(page)}`); // all from request 1
    expect(texts).not.toContain('request 2');

    const spans = (await chunksRepo.forDocument(db, ready.id)).flatMap(
      (chunk) =>
        chunk.highlights as { page: number; rects: { x: number; y: number; w: number; h: number }[] }[],
    );
    // Every page is highlighted somewhere; a page may be in the highlights of two chunks (chunks overlap, and a chunk has
    // one entry for each page it touches), so the pages are compared as a set.
    expect([...new Set(spans.map((span) => span.page))].sort()).toEqual([1, 2, 3]);
    for (const span of spans) expect(span.rects).toEqual([{ x: 0, y: 0, w: 1, h: 1 }]); // one rectangle: the page
  }, 120_000);

  it('asks for a page the answer left out once more, alone, and indexes it', async () => {
    const server = await geminiServer({}, { omitPageOfFirstRequest: 2 });
    const client = server.client();
    const ready = await waitForDocument(
      client,
      summaryOf(await client.uploadFixture('scanned-three.pdf')).id,
    );
    expect(ready.status).toBe('ready');
    expect(ready.warnings).toEqual([]);
    const texts = await chunkTexts(ready.id);
    expect(texts).toContain(`${SENTENCE} 2 page 1`); // page 2 came from the second request, which held one page
  }, 120_000);

  it('handles a mixed PDF page by page: the text page stays, the scanned page is read (mixed-scanned.pdf)', async () => {
    const server = await geminiServer();
    const client = server.client();
    const ready = await waitForDocument(
      client,
      summaryOf(await client.uploadFixture('mixed-scanned.pdf')).id,
    );
    expect(ready.status).toBe('ready');
    expect(ready.pages.map((page) => [page.pageNumber, page.extraction])).toEqual([
      [1, 'text'],
      [2, 'ocr'],
    ]);
    expect(ready.warnings).toEqual([]);
  }, 120_000);

  it('parks the document when the daily quota runs out in the middle of a scan, keeps what was read, and reads the rest after the reset', async () => {
    const server = await geminiServer({ OCR_PAGES_PER_REQUEST: '1' }, { quotaFromRequest: 2 });
    const client = server.client();
    const accepted = summaryOf(await client.uploadFixture('scanned-three.pdf'));
    const parked = (await tickUntilDone(client, accepted.id)).at(-1);
    // A wait, not a verdict: the document is not failed, not finished with pages missing, and its file is still there.
    expect(parked).toMatchObject({
      status: 'parked',
      progress: { stage: 'ocr', completed: 1, total: 3, unit: 'pages', detail: 'daily quota reached' },
    });
    expect(parked?.retryAfterMs).toBeGreaterThan(0);
    expect(await server.app.ingestion.storage.stat(`${accepted.id}.pdf`)).not.toBeNull();
    expect(
      (
        await db.query(
          'SELECT count(*)::int AS n FROM ingest_stage_data WHERE document_id = $1 AND kind = $2',
          [accepted.id, 'ocr'],
        )
      ).rows[0],
    ).toEqual({ n: 1 }); // page 1, read

    // The quota is back (a new day: the stand-in no longer refuses, the parking has run out): the pages left are read.
    process.env.FAKE_GEMINI = JSON.stringify({ firstLine: SENTENCE });
    await db.query(
      "UPDATE ingest_jobs SET parked_until = now() - interval '1 minute' WHERE document_id = $1",
      [accepted.id],
    );
    const ready = await waitForDocument(client, accepted.id);
    expect(ready.status).toBe('ready');
    expect(ready.warnings).toEqual([]);
    expect(ready.pages.map((page) => page.extraction)).toEqual(['ocr', 'ocr', 'ocr']);
    const texts = await chunkTexts(ready.id);
    expect(texts).toContain(`${SENTENCE} 1 page 1`);
    // The thread that went on after the reset numbers its requests from 1 again: page 2 was its first, page 3 its second.
    expect(texts).toContain(`${SENTENCE} 2 page 1`);
  }, 120_000);

  it('parks a scan whose pages could not be read at all because of the quota (it is not failed as RATE_LIMITED, nor deleted)', async () => {
    const server = await geminiServer({}, { quotaFromRequest: 1 });
    const client = server.client();
    const accepted = summaryOf(await client.uploadFixture('scanned-three.pdf'));
    const parked = (await tickUntilDone(client, accepted.id)).at(-1);
    expect(parked).toMatchObject({
      status: 'parked',
      progress: { stage: 'ocr', completed: 0, total: 3, detail: 'daily quota reached' },
    });
    expect((await detailOf(client, accepted.id)).status).toBe('processing');
    expect(await server.app.ingestion.storage.stat(`${accepted.id}.pdf`)).not.toBeNull();
  }, 120_000);

  it('counts the requests the worker really sends against the OCR budget: a batch answered wrongly is asked for page by page', async () => {
    // Every page of the first batch is numbered by its printed number in the answer: the model's answer cannot be trusted, and
    // each of the three pages is asked for again alone: four requests, not the one that was reserved for the call.
    await resetCounters(db); // (the budget of the day is the database's: what the tests before this one used is not this one's)
    const log = path.join(nextTestDirectory('request-log'), 'requests.log');
    await mkdir(path.dirname(log), { recursive: true });
    await writeFile(log, '');
    const server = await geminiServer(
      { GEMINI_DAILY_BUDGET_OCR: '50' },
      { numberPagesWrongly: true, requestLog: log },
    );
    const client = server.client();
    const ready = await waitForDocument(
      client,
      summaryOf(await client.uploadFixture('scanned-three.pdf')).id,
    );
    expect(ready.status).toBe('ready');
    const counted = (
      await db.query<{ count: number }>(`SELECT count FROM rate_counters WHERE key = 'gemini:ocr'`)
    ).rows[0]?.count;
    const sent = (await readFile(log, 'utf8')).split('\n').filter(Boolean).length;
    expect(sent).toBe(4); // the batch, and then each of its three pages alone
    expect(counted).toBe(sent); // one was reserved for the call; the count follows what was sent
  }, 120_000);
});

describe('scanned pages through the chunker', () => {
  it('keeps the pages of a scan apart when each ends on its page number: no chunk, and so no citation, spans two pages', async () => {
    const server = await geminiServer({}, { pageNumbers: true });
    const client = server.client();
    const ready = await waitForDocument(
      client,
      summaryOf(await client.uploadFixture('scanned-three.pdf')).id,
    );
    expect(ready.status).toBe('ready');
    expect(ready.pages.map((page) => page.extraction)).toEqual(['ocr', 'ocr', 'ocr']);
    const chunks = await chunksRepo.forDocument(db, ready.id);
    expect(chunks.length).toBeGreaterThanOrEqual(3);
    expect(chunks.every((chunk) => chunk.page_start === chunk.page_end)).toBe(true);
    expect(chunks.every((chunk) => chunk.highlights.every((h) => h.page === chunk.page_start))).toBe(true);
  }, 120_000);

  it('and without page numbers a paragraph that has no end still runs on over the page break, as it should', async () => {
    const server = await geminiServer();
    const client = server.client();
    const ready = await waitForDocument(
      client,
      summaryOf(await client.uploadFixture('scanned-three.pdf')).id,
    );
    const chunks = await chunksRepo.forDocument(db, ready.id);
    expect(chunks.some((chunk) => chunk.page_start !== chunk.page_end)).toBe(true);
  }, 120_000);
});

describe('the OCR stage with Gemini when the service is not there', () => {
  it('does not end the document over one request the service could not answer: that page is OCR_PARTIAL, the others are read', async () => {
    // five attempts of the first request fail (the provider's retries), the service is back for the second
    const server = await geminiServer({ OCR_PAGES_PER_REQUEST: '1' }, { unavailableFirstRequests: 5 });
    const client = server.client();
    const ready = await waitForDocument(
      client,
      summaryOf(await client.uploadFixture('scanned-three.pdf')).id,
    );
    expect(ready.status).toBe('ready');
    expect(ready.warnings).toEqual([{ code: 'OCR_PARTIAL', pages: [1] }]);
    expect(ready.pages.map((page) => page.extraction)).toEqual(['empty', 'ocr', 'ocr']);
  }, 120_000);

  it('reads all the pages of a batch that failed once and then went through: no page is lost to one bad request', async () => {
    const server = await geminiServer({}, { unavailableFirstRequests: 3 });
    const client = server.client();
    const ready = await waitForDocument(
      client,
      summaryOf(await client.uploadFixture('scanned-three.pdf')).id,
    );
    expect(ready.status).toBe('ready');
    expect(ready.warnings).toEqual([]);
    expect(ready.pages.map((page) => page.extraction)).toEqual(['ocr', 'ocr', 'ocr']);
  }, 120_000);

  it('fails a scan that could not be read at all because the service never answered as "try again later", not as damaged', async () => {
    const server = await geminiServer({}, { unavailableFirstRequests: 1000 });
    const client = server.client();
    const failed = await waitForDocument(
      client,
      summaryOf(await client.uploadFixture('scanned-three.pdf')).id,
    );
    expect(failed.status).toBe('failed');
    expect(failed.error?.code).toBe('LLM_UNAVAILABLE');
    expect(failed.error?.message).toContain('again in a moment');
  }, 120_000);
});

describe('the OCR stage with Gemini when the configuration is refused or the time runs out', () => {
  it.each([[401], [404]])(
    'fails a scan as a fault of the configuration on a %i, saying what to check, and asks for nothing more',
    async (httpStatus) => {
      const server = await geminiServer({}, { httpStatus });
      const client = server.client();
      const failed = await waitForDocument(
        client,
        summaryOf(await client.uploadFixture('scanned-three.pdf')).id,
      );
      expect(failed.status).toBe('failed');
      expect(failed.error?.code).toBe('LLM_UNAVAILABLE');
      expect(failed.error?.message).toContain('GEMINI_API_KEY and OCR_MODEL');
    },
    120_000,
  );

  it('fails a scan as a fault of the configuration when the model has no quota at all on the plan, never parks it for a quota that will not come', async () => {
    const server = await geminiServer({}, { noQuota: true });
    const client = server.client();
    const accepted = summaryOf(await client.uploadFixture('scanned-three.pdf'));
    const failed = await waitForDocument(client, accepted.id);
    expect(failed.status).toBe('failed'); // not 'parked': waiting for the reset does not give a model that has no quota one
    expect(failed.error?.code).toBe('LLM_UNAVAILABLE');
    expect(failed.error?.message).toContain('GEMINI_API_KEY and OCR_MODEL');
    expect(failed.error?.message).toContain('no quota');
    expect(await server.app.ingestion.storage.stat(`${accepted.id}.pdf`)).not.toBeNull(); // nothing is known against the file
  }, 120_000);

  it('keeps a document with text and flags the pages it could not read when the key is rejected', async () => {
    const server = await geminiServer({}, { httpStatus: 401 });
    const client = server.client();
    const ready = await waitForDocument(
      client,
      summaryOf(await client.uploadFixture('mixed-scanned.pdf')).id,
    );
    expect(ready.status).toBe('ready');
    expect(ready.warnings).toEqual([{ code: 'OCR_PARTIAL', pages: [2] }]);
  }, 120_000);

  it('fails a scan whose OCR time ran out in the middle of a request as "try again", not as damaged', async () => {
    const server = await geminiServer({ OCR_MAX_SECONDS: '1' }, { hangFromRequest: 1 });
    const client = server.client();
    const failed = await waitForDocument(
      client,
      summaryOf(await client.uploadFixture('scanned-three.pdf')).id,
    );
    expect(failed.status).toBe('failed');
    expect(failed.error?.code).toBe('LLM_UNAVAILABLE');
    expect(failed.error?.message).toContain('took longer than the time allowed');
  }, 120_000);
});

describe('the OCR stage with Gemini on a scan encrypted with an owner password only', () => {
  it('reads it: the page is rendered and sent as a picture, and the document is an OCR page, not an empty one', async () => {
    const server = await geminiServer();
    const client = server.client();
    const ready = await waitForDocument(
      client,
      summaryOf(await client.uploadFixture('scanned-ar-locked.pdf')).id,
    );
    expect(ready.status).toBe('ready');
    expect(ready.warnings).toEqual([]);
    expect(ready.pages.map((page) => [page.pageNumber, page.extraction])).toEqual([[1, 'ocr']]);
    expect(await chunkTexts(ready.id)).toContain(`${SENTENCE} 1 page 1`);
  }, 120_000);
});

describe('Gemini OCR without a key', () => {
  it('is unconfigured: pages that need OCR are OCR_UNAVAILABLE, the text pages are kept, and no thread is started for it', async () => {
    const config = testConfig({ OCR_PROVIDER: 'gemini' });
    expect(config.geminiApiKey).toBeNull();
    const server = await startServer(db, config);
    servers.push(server);
    const health = await server.app.inject('/api/health');
    expect(health.json<{ providers: { ocr: string } }>().providers.ocr).toBe('unconfigured');
    const client = server.client();
    const ready = await waitForDocument(
      client,
      summaryOf(await client.uploadFixture('mixed-scanned.pdf')).id,
    );
    expect(ready.status).toBe('ready');
    expect(ready.warnings).toEqual([{ code: 'OCR_UNAVAILABLE', pages: [2] }]);
  }, 120_000);

  it('says gemini:<model> in /api/health and /api/config once there is a key', async () => {
    const server = await startServer(
      db,
      testConfig({ OCR_PROVIDER: 'gemini', GEMINI_API_KEY: 'test-key-not-real' }),
    );
    servers.push(server);
    const health = await server.app.inject('/api/health');
    expect(health.json<{ providers: { ocr: string } }>().providers.ocr).toBe('gemini:gemini-3.5-flash-lite');
    const config = await server.app.inject('/api/config');
    expect(config.json<{ ocr: unknown }>().ocr).toEqual({ provider: 'gemini', available: true });
  }, 120_000);
});
