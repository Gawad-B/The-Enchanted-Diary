import { existsSync, readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createDb, type Db, type Queryable } from '../src/db/client.js';
import { chunksRepo } from '../src/db/repositories/chunks.js';
import { IngestWorkerHost } from '../src/ingest/worker/host.js';
import type { FakeOcrScript } from './ocr-doubles/fake-ocr-provider.js';
import {
  detailOf,
  keepTicking,
  startServer,
  summaryOf,
  tickUntilDone,
  waitForDocument,
  waitUntil,
  type TestServer,
} from './http-helpers.js';
import { nextTestDirectory, testConfig } from './helpers.js';
import { readFixture } from './fixtures.js';

/*
 * The OCR stage of the pipeline end to end (upload, worker threads, database, the ticks of the client), with a fake engine in the OCR
 * thread: what happens around the engine, deterministically. The real engine is in ocr-pipeline.model.test.ts.
 */

const FAKE_ENTRY = {
  url: new URL('./ocr-doubles/fake-ocr-worker.mjs', import.meta.url),
  execArgv: ['--conditions=source'],
};

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
  delete process.env.FAKE_OCR;
});

/** What was committed as the progress of a document: every `setProgress` of the ticks, in order. */
interface ProgressCommit {
  stage: string;
  completed: number;
  total: number;
  unit: string;
}

/** The database, watched: every write of a document's progress is recorded (the answers of the ticks are only samples of them). */
function recordingDb(real: Db, commits: ProgressCommit[]): Db {
  const watch =
    (target: Queryable): Queryable['query'] =>
    (sql, params) => {
      if (
        sql.includes('UPDATE documents') &&
        sql.includes('progress_completed = $3') &&
        params !== undefined
      ) {
        commits.push({
          stage: String(params[1]),
          completed: Number(params[2]),
          total: Number(params[3]),
          unit: String(params[4]),
        });
      }
      return target.query(sql, params);
    };
  return {
    ...real,
    query: watch(real),
    transaction: (fn) =>
      real.transaction((tx) => fn({ ...tx, query: watch(tx), exec: (sql: string) => tx.exec(sql) })),
  };
}

/** A server whose OCR threads run the fake engine as `script` says. */
async function fakeOcrServer(
  env: Record<string, string> = {},
  script: FakeOcrScript = {},
  available = true,
  database: Db = db,
): Promise<TestServer> {
  process.env.FAKE_OCR = JSON.stringify(script);
  // The fake engine's text reads as French to the language detector: no extra language is allowed, so there is no
  // extra trial to confuse the counts.
  const config = testConfig({
    OCR_PROVIDER: 'tesseract',
    OCR_DPI: '72',
    OCR_LANGUAGES: 'eng',
    OCR_EXTRA_LANGUAGES: 'urd',
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
  const server = await startServer(database, config, {
    deps: {
      ingestion: { workers, ocr: { isAvailable: () => Promise.resolve(available), peek: () => available } },
    },
  });
  servers.push(server);
  return server;
}

const chunkTexts = async (documentId: string): Promise<string[]> =>
  (await chunksRepo.forDocument(db, documentId)).map((chunk) => chunk.content);

describe('the OCR stage with a fake engine', () => {
  it('reads every page of a scan: pages become OCR pages with confidence, language and highlights from the line boxes', async () => {
    const server = await fakeOcrServer(
      {},
      { firstLine: 'The surveyors arrived at the harbour of Wexcombe on a grey morning in spring.' },
    );
    const client = server.client();
    const ready = await waitForDocument(
      client,
      summaryOf(await client.uploadFixture('scanned-three.pdf')).id,
    );
    expect(ready.status).toBe('ready');
    expect(ready.warnings).toEqual([]);
    expect(ready.pages.map((page) => [page.pageNumber, page.extraction, page.ocrConfidence])).toEqual([
      [1, 'ocr', 90],
      [2, 'ocr', 90],
      [3, 'ocr', 90],
    ]);
    expect(ready.pages.every((page) => page.charCount > 40 && page.language === 'en')).toBe(true);

    // The stored page text is the OCR text, line by line.
    const stored = await db.query<{ page_number: number; text: string; extraction: string }>(
      'SELECT page_number, text, extraction FROM document_pages WHERE document_id = $1 ORDER BY page_number',
      [ready.id],
    );
    expect(stored.rows.map((row) => [row.page_number, row.extraction])).toEqual([
      [1, 'ocr'],
      [2, 'ocr'],
      [3, 'ocr'],
    ]);
    expect(stored.rows[0]?.text).toContain('The surveyors arrived at the harbour of Wexcombe');
    const chunks = await chunksRepo.forDocument(db, ready.id);
    // The three short pages share one chunk; its highlight has one span per page, made of the OCR line boxes: the fake
    // engine puts its lines between 15% and 28% of the page height, from 10% to 90% of its width.
    const spans = chunks.flatMap(
      (chunk) =>
        chunk.highlights as { page: number; rects: { x: number; y: number; w: number; h: number }[] }[],
    );
    expect(spans.map((span) => span.page)).toEqual([1, 2, 3]);
    for (const rect of spans.flatMap((span) => span.rects)) {
      expect(rect.x).toBeCloseTo(0.1, 2);
      expect(rect.w).toBeCloseTo(0.8, 2);
      expect(rect.y).toBeGreaterThanOrEqual(0.14);
      expect(rect.y + rect.h).toBeLessThanOrEqual(0.281);
    }
  }, 180_000);

  it('records a page the engine throws on as OCR_PARTIAL and indexes the others (the provider fails on page 2 of 3)', async () => {
    const server = await fakeOcrServer({}, { throwOnPage: [2] });
    const client = server.client();
    const ready = await waitForDocument(
      client,
      summaryOf(await client.uploadFixture('scanned-three.pdf')).id,
    );
    expect(ready.status).toBe('ready');
    expect(ready.warnings).toEqual([{ code: 'OCR_PARTIAL', pages: [2] }]);
    expect(ready.pages.map((page) => [page.pageNumber, page.extraction])).toEqual([
      [1, 'ocr'],
      [2, 'empty'],
      [3, 'ocr'],
    ]);
    // Nothing of page 2 was read, so nothing of it is indexed; pages 1 and 3 are.
    const texts = (await chunkTexts(ready.id)).join('\n');
    expect(texts).toContain('Fake page 1 line one');
    expect(texts).toContain('Fake page 3 line one');
    expect(texts).not.toContain('Fake page 2');
    expect(JSON.stringify(ready)).not.toContain('/home/secret'); // the engine's own error text stays in the log
  }, 180_000);

  it('stops a page that never returns at the page timeout: that page is OCR_PARTIAL, the others are read', async () => {
    const server = await fakeOcrServer({ INGEST_PAGE_TIMEOUT_MS: '1500' }, { hangOnPage: [2] });
    const client = server.client();
    const ready = await waitForDocument(
      client,
      summaryOf(await client.uploadFixture('scanned-three.pdf')).id,
    );
    expect(ready.status).toBe('ready');
    expect(ready.warnings).toEqual([{ code: 'OCR_PARTIAL', pages: [2] }]);
    expect(ready.pages.map((page) => page.extraction)).toEqual(['ocr', 'empty', 'ocr']);
  }, 180_000);

  it('reads only the first OCR_MAX_PAGES pages and lists the others in OCR_PARTIAL', async () => {
    const server = await fakeOcrServer({ OCR_MAX_PAGES: '2', INGEST_TICK_BUDGET_MS: '1000' });
    const client = server.client();
    const accepted = summaryOf(await client.uploadFixture('scanned-three.pdf'));
    const answers = await tickUntilDone(client, accepted.id);
    const seen = answers.flatMap((answer) =>
      answer.progress.stage === 'ocr'
        ? [{ completed: answer.progress.completed, total: answer.progress.total }]
        : [],
    );
    const ready = await detailOf(client, accepted.id);
    expect(ready.status).toBe('ready');
    expect(ready.warnings).toEqual([{ code: 'OCR_PARTIAL', pages: [3] }]);
    expect(ready.pages.map((page) => page.extraction)).toEqual(['ocr', 'ocr', 'empty']);
    expect(seen.at(-1)).toEqual({ completed: 2, total: 2 });
  }, 180_000);

  it('commits real progress for the ocr stage, a unit of work at a time: 4, 8, 12 of 12 pages, never back, between parsing and the analysis', async () => {
    // A scan of twelve pages (the three of scanned-three.pdf four times over): the engine reads four pages a call.
    const source = await PDFDocument.load(await readFixture('scanned-three.pdf'));
    const twelve = await PDFDocument.create();
    for (let copy = 0; copy < 4; copy += 1) {
      for (const page of await twelve.copyPages(source, [0, 1, 2])) twelve.addPage(page);
    }
    const commits: ProgressCommit[] = [];
    const server = await fakeOcrServer({ INGEST_TICK_BUDGET_MS: '1000' }, {}, true, recordingDb(db, commits));
    const client = server.client();
    const accepted = summaryOf(await client.upload(await twelve.save(), { filename: 'twelve-scanned.pdf' }));
    // (About 40 s on a quiet machine: the deadline of the loop is the test's own, less a margin, so that a loaded one passes.)
    await tickUntilDone(client, accepted.id, { timeoutMs: 150_000 });
    expect((await detailOf(client, accepted.id)).status).toBe('ready');

    // Every commit of the stage, not the answers that happened to see it.
    const ocr = commits.filter((commit) => commit.stage === 'ocr');
    expect(ocr.map((commit) => commit.completed)).toEqual([0, 4, 8, 12]);
    expect(ocr.every((commit) => commit.total === 12 && commit.unit === 'pages')).toBe(true);
    // The stages come in this order, each entered once and never left for an earlier one.
    const order = commits.map((commit) => commit.stage).filter((stage, i, all) => stage !== all[i - 1]);
    expect(order.slice(0, 4)).toEqual(['validating', 'parsing', 'ocr', 'analyzing']);
    expect(order.indexOf('ocr')).toBeLessThan(order.indexOf('analyzing'));
    expect(new Set(order).size).toBe(order.length);
  }, 180_000);

  it('handles a mixed PDF page by page: a text page stays text, the scanned page is OCR (mixed-scanned.pdf)', async () => {
    const server = await fakeOcrServer();
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
    expect(ready.pages[0]?.ocrConfidence).toBeNull();
    expect(ready.pages[1]?.ocrConfidence).toBe(90);
    expect(ready.warnings).toEqual([]);
    // The language comes from the text page (English): one candidate, so no trial on the scanned page.
    const texts = (await chunkTexts(ready.id)).join('\n');
    expect(texts).toContain('languages eng calls eng');
    expect(texts).not.toContain('calls eng,');
  }, 180_000);

  it('tries the configured languages on the first page of a scan that has no text pages, once', async () => {
    const server = await fakeOcrServer({ OCR_LANGUAGES: 'eng+ara' }, { confidence: { eng: 93, ara: 30 } });
    const client = server.client();
    const ready = await waitForDocument(
      client,
      summaryOf(await client.uploadFixture('scanned-three.pdf')).id,
    );
    const texts = (await chunkTexts(ready.id)).join('\n');
    expect(texts).toContain('calls eng,ara'); // page 1: the trial
    expect(texts).toContain('calls eng,ara,eng'); // page 2: the chosen language only
    expect(texts).not.toContain('calls eng,ara,eng,ara');
  }, 180_000);

  it('fails a scan whose pages all fail as PDF_UNREADABLE, not as an empty document', async () => {
    const server = await fakeOcrServer({}, { throwOnPage: [1, 2, 3] });
    const client = server.client();
    const failed = await waitForDocument(
      client,
      summaryOf(await client.uploadFixture('scanned-three.pdf')).id,
    );
    expect(failed.status).toBe('failed');
    expect(failed.error?.code).toBe('PDF_UNREADABLE');
    expect(failed.error?.message).toContain('3 of 3 pages could not be read');
  }, 180_000);

  it('treats an engine that does not start in the worker thread as unavailable', async () => {
    const server = await fakeOcrServer({}, { unavailable: true }); // the main thread believes it works; the thread finds out
    const client = server.client();
    const failed = await waitForDocument(
      client,
      summaryOf(await client.uploadFixture('scanned-three.pdf')).id,
    );
    expect(failed.status).toBe('failed');
    expect(failed.error?.code).toBe('PDF_EMPTY');
    expect(failed.error?.message).toContain('OCR_UNAVAILABLE');
  }, 180_000);

  it('keeps the cleaned text of a mixed document and flags the pages when OCR is unavailable', async () => {
    const server = await fakeOcrServer({}, {}, false);
    const client = server.client();
    const ready = await waitForDocument(
      client,
      summaryOf(await client.uploadFixture('mixed-scanned.pdf')).id,
    );
    expect(ready.status).toBe('ready');
    expect(ready.warnings).toEqual([{ code: 'OCR_UNAVAILABLE', pages: [2] }]);
    expect(ready.pages.map((page) => page.extraction)).toEqual(['text', 'empty']);
  }, 180_000);
});

describe('pages whose text layer is broken, when OCR cannot read them', () => {
  it('keeps the cleaned text of arabic-damaged.pdf and flags every page (OCR_PARTIAL and LOW_TEXT_QUALITY) when the engine fails on them', async () => {
    const server = await fakeOcrServer({}, { throwOnPage: [1, 2, 3] });
    const client = server.client();
    const ready = await waitForDocument(
      client,
      summaryOf(await client.uploadFixture('arabic-damaged.pdf')).id,
    );
    expect(ready.status).toBe('ready');
    expect(ready.pages.every((page) => page.extraction === 'text' && page.charCount > 50)).toBe(true);
    expect(ready.warnings).toEqual([
      { code: 'OCR_PARTIAL', pages: [1, 2, 3] },
      { code: 'LOW_TEXT_QUALITY', pages: [1, 2, 3] },
    ]);
    expect(ready.primaryLanguage).toBe('ar');
    expect((await chunkTexts(ready.id)).join('\n')).toContain('الكربون'); // the text that pdf.js gave is indexed
  }, 180_000);

  it('replaces the garbage of arabic-no-tounicode.pdf with what the engine reads (the fake engine answers)', async () => {
    const server = await fakeOcrServer(
      { OCR_LANGUAGES: 'ara', OCR_EXTRA_LANGUAGES: 'urd' },
      { firstLine: 'تقع المكتبة في قلب المدينة القديمة وقد بنيت قبل أكثر من ثلاثة قرون' },
    );
    const client = server.client();
    const ready = await waitForDocument(
      client,
      summaryOf(await client.uploadFixture('arabic-no-tounicode.pdf')).id,
    );
    expect(ready.pages.map((page) => page.extraction)).toEqual(['ocr', 'ocr', 'ocr']);
    expect(ready.warnings).toEqual([]);
    expect(ready.primaryLanguage).toBe('ar'); // from the OCR text, not from the garbage that was extracted
    expect(ready.direction).toBe('rtl');
    expect((await chunkTexts(ready.id)).join('\n')).toContain('تقع المكتبة في قلب المدينة');
  }, 180_000);
});

describe('OCR does not take what it should not', () => {
  it('starts no OCR thread for a blank page: a text page and a blank page give a ready document with no warning', async () => {
    const pdf = await PDFDocument.create();
    const font = await pdf.embedFont(StandardFonts.TimesRoman);
    const first = pdf.addPage([595, 842]);
    first.drawText('The first page has enough text to be read without any help from OCR at all.', {
      x: 50,
      y: 780,
      size: 12,
      font,
    });
    pdf.addPage([595, 842]); // blank
    // Any read would fail: if an OCR thread ran for page 2 the document would carry OCR_PARTIAL.
    const commits: ProgressCommit[] = [];
    const entered = path.join(nextTestDirectory('entered'), 'pages.log');
    await mkdir(path.dirname(entered), { recursive: true });
    const server = await fakeOcrServer(
      {},
      { throwOnPage: [1, 2], enteredLog: entered },
      true,
      recordingDb(db, commits),
    );
    const client = server.client();
    const accepted = summaryOf(await client.upload(await pdf.save(), { filename: 'blank-second.pdf' }));
    await tickUntilDone(client, accepted.id);
    const stages = commits.map((commit) => commit.stage);
    const ready = await detailOf(client, accepted.id);
    expect(ready.status).toBe('ready');
    expect(ready.pages.map((page) => page.extraction)).toEqual(['text', 'empty']);
    expect(ready.warnings).toEqual([]);
    // Every commit of the document's progress is in `stages`, and the engine never started on a page.
    expect(stages).toContain('parsing');
    expect(stages).not.toContain('ocr');
    expect(existsSync(entered)).toBe(false);
  }, 180_000);

  it('keeps the extracted text of arabic-damaged.pdf when OCR reads only a part of each page, however sure it is', async () => {
    // The fake engine reads three short lines per page at confidence 90: about 60 characters of 120 to 135.
    const server = await fakeOcrServer({ OCR_LANGUAGES: 'ara', INGEST_TICK_BUDGET_MS: '1000' }, {});
    const client = server.client();
    const accepted = summaryOf(await client.uploadFixture('arabic-damaged.pdf'));
    const answers = await tickUntilDone(client, accepted.id);
    const read = answers.flatMap((answer) =>
      answer.progress.stage === 'ocr' ? [answer.progress.completed] : [],
    );
    const ready = await detailOf(client, accepted.id);
    expect(read.at(-1)).toBe(3); // all three pages were read by OCR...
    expect(ready.pages.map((page) => page.extraction)).toEqual(['text', 'text', 'text']); // ...and none replaced the text
    expect(ready.warnings).toEqual([{ code: 'LOW_TEXT_QUALITY', pages: [1, 2, 3] }]);
    expect((await chunkTexts(ready.id)).join('\n')).toContain('الكربون');
  }, 180_000);

  it('gives a document the time OCR_MAX_SECONDS allows and no more: the page that does not finish in time is OCR_PARTIAL', async () => {
    // Every read takes 5 s and the document may use 1 s: page 2 (the scan) cannot be read, whatever the machine.
    const server = await fakeOcrServer({ OCR_MAX_SECONDS: '1' }, { delayMs: 5000 });
    const client = server.client();
    const started = Date.now();
    const ready = await waitForDocument(
      client,
      summaryOf(await client.uploadFixture('mixed-scanned.pdf')).id,
    );
    expect(Date.now() - started).toBeLessThan(15_000);
    expect(ready.status).toBe('ready');
    expect(ready.pages.map((page) => page.extraction)).toEqual(['text', 'empty']);
    expect(ready.warnings).toEqual([{ code: 'OCR_PARTIAL', pages: [2] }]);
  }, 180_000);
});

describe('text drawn as vector outlines (no text layer, no image: print-ready and flattened files)', () => {
  const ENGLISH_LINE =
    'The house was founded by a cartographer who bought the hill in the spring of the year.';

  it('is read by OCR, not taken for blank: outlined-en.pdf gives an OCR page (the fake engine answers)', async () => {
    const server = await fakeOcrServer({ INGEST_TICK_BUDGET_MS: '1000' }, { firstLine: ENGLISH_LINE });
    const client = server.client();
    const accepted = summaryOf(await client.uploadFixture('outlined-en.pdf'));
    const answers = await tickUntilDone(client, accepted.id);
    const read = answers.flatMap((answer) =>
      answer.progress.stage === 'ocr' ? [answer.progress.completed] : [],
    );
    const ready = await detailOf(client, accepted.id);
    expect(ready.status).toBe('ready');
    expect(read.at(-1)).toBe(1); // the one page was sent to OCR
    expect(ready.pages.map((page) => [page.extraction, page.ocrConfidence])).toEqual([['ocr', 90]]);
    expect(ready.warnings).toEqual([]);
    expect((await chunkTexts(ready.id)).join('\n')).toContain(ENGLISH_LINE);
  }, 180_000);

  it('handles a text page and an outlined page page by page (mixed-outlined.pdf)', async () => {
    const server = await fakeOcrServer({ OCR_LANGUAGES: 'ara' }, {});
    const client = server.client();
    const ready = await waitForDocument(
      client,
      summaryOf(await client.uploadFixture('mixed-outlined.pdf')).id,
    );
    expect(ready.status).toBe('ready');
    expect(ready.pages.map((page) => page.extraction)).toEqual(['text', 'ocr']);
    expect(ready.warnings).toEqual([]);
  }, 180_000);

  it('flags the outlined page OCR_PARTIAL when the engine fails on it: never a silent empty page', async () => {
    const server = await fakeOcrServer({}, { throwOnPage: [2] });
    const client = server.client();
    const ready = await waitForDocument(
      client,
      summaryOf(await client.uploadFixture('mixed-outlined.pdf')).id,
    );
    expect(ready.status).toBe('ready');
    expect(ready.pages.map((page) => page.extraction)).toEqual(['text', 'empty']);
    expect(ready.warnings).toEqual([{ code: 'OCR_PARTIAL', pages: [2] }]);
  }, 180_000);
});

describe('cancelling during OCR', () => {
  it('stops a job whose OCR thread is busy at once, and leaves nothing behind (DELETE while page 2 hangs)', async () => {
    // The page timeout is out of the way: only the DELETE can stop this job.
    const entered = path.join(nextTestDirectory('entered'), 'pages.log');
    await mkdir(path.dirname(entered), { recursive: true });
    await writeFile(entered, '');
    const server = await fakeOcrServer(
      { INGEST_PAGE_TIMEOUT_MS: '600000' },
      { hangOnPage: [2], enteredLog: entered },
    );
    const client = server.client();
    const accepted = summaryOf(await client.uploadFixture('scanned-three.pdf'));
    const ticking = keepTicking(client, accepted.id);
    // The engine says when it has started on page 2, where it hangs: that is the moment, not a guess at how long it takes.
    await waitUntil(() => readFileSync(entered, 'utf8').includes('page 2'), 'the engine to start on page 2');
    const asked = Date.now();
    expect((await client.delete(`/api/documents/${accepted.id}`)).statusCode).toBe(204);
    expect(Date.now() - asked).toBeLessThan(3000);
    expect((await ticking).stoppedBy).toEqual({ statusCode: 404, code: 'DOCUMENT_NOT_FOUND' });
    const rows = await db.query('SELECT 1 FROM documents WHERE id = $1', [accepted.id]);
    expect(rows.rows).toEqual([]);
    expect(await server.app.ingestion.storage.stat(`${accepted.id}.pdf`)).toBeNull();
  }, 180_000);
});

describe('OCR_PROVIDER=none', () => {
  it('flags an outlined page OCR_UNAVAILABLE, not silence, and fails an all-outlined PDF as PDF_EMPTY with it in the detail', async () => {
    const server = await startServer(db, testConfig({ OCR_PROVIDER: 'none' }));
    servers.push(server);
    const client = server.client();
    const ready = await waitForDocument(
      client,
      summaryOf(await client.uploadFixture('mixed-outlined.pdf')).id,
    );
    expect(ready.status).toBe('ready');
    expect(ready.pages.map((page) => page.extraction)).toEqual(['text', 'empty']);
    expect(ready.warnings).toEqual([{ code: 'OCR_UNAVAILABLE', pages: [2] }]);
    const failed = await waitForDocument(client, summaryOf(await client.uploadFixture('outlined-en.pdf')).id);
    expect(failed.status).toBe('failed');
    expect(failed.error?.code).toBe('PDF_EMPTY');
    expect(failed.error?.message).toContain('OCR_UNAVAILABLE');
  }, 180_000);

  it('fails a scan as PDF_EMPTY and records OCR_UNAVAILABLE in the error detail', async () => {
    const server = await startServer(db, testConfig({ OCR_PROVIDER: 'none' }));
    servers.push(server);
    const client = server.client();
    const failed = await waitForDocument(client, summaryOf(await client.uploadFixture('scanned-en.pdf')).id);
    expect(failed.status).toBe('failed');
    expect(failed.error?.code).toBe('PDF_EMPTY');
    expect(failed.error?.message).toBe(
      'The PDF has no readable text. (no page contains text and OCR is not available (OCR_UNAVAILABLE))',
    );
  }, 180_000);
});
