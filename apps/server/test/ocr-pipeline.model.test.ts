import path from 'node:path';
import { normalizeForMatch } from '@enchanted/shared';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { REPO_ROOT } from '../src/config.js';
import { createDb, type Db } from '../src/db/client.js';
import { chunksRepo } from '../src/db/repositories/chunks.js';
import { ocrSettingsOf } from '../src/ingest/ocr-settings.js';
import { IngestWorkerHost } from '../src/ingest/worker/host.js';
import {
  detailOf,
  startServer,
  summaryOf,
  tickUntilDone,
  waitForDocument,
  type TestServer,
} from './http-helpers.js';
import { readFixture } from './fixtures.js';
import { testConfig } from './helpers.js';

/*
 * The optional self-hosted engine (OCR_PROVIDER=tesseract: tesseract.js, offline from the packs `npm run models:fetch`
 * put in OCR_CACHE_DIR) behind the whole pipeline: scans, PDFs whose text layer is broken, and the hostile pages OCR
 * must not be a way around. Runs only where RUN_LOCAL_OCR_TESTS=1 is set (Kaggle, CI): the engine takes about 0.3 GB
 * and a minute of CPU per file, and the default OCR is Gemini (see ocr-gemini-pipeline.test.ts). Uses a fake embedding
 * model, so only the OCR engine is loaded.
 */
const RUN = process.env.RUN_LOCAL_OCR_TESTS === '1';

let db: Db;
const servers: TestServer[] = [];

beforeAll(async () => {
  if (!RUN) return;
  db = await createDb(testConfig());
});
afterAll(async () => {
  if (!RUN) return;
  await db.close();
});
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

async function ocrServer(env: Record<string, string> = {}): Promise<TestServer> {
  const server = await startServer(db, testConfig({ OCR_PROVIDER: 'tesseract', ...env }));
  servers.push(server);
  return server;
}

/** The share of the distinctive words of `expected` (4 letters or more) found in `actual`, case-insensitively. */
function wordRecall(expected: string, actual: string): number {
  const have = new Set(normalizeForMatch(actual).split(' '));
  const words = [
    ...new Set(
      normalizeForMatch(expected)
        .split(' ')
        .filter((word) => word.length >= 4),
    ),
  ];
  return words.filter((word) => have.has(word)).length / words.length;
}

async function pageTexts(documentId: string): Promise<string[]> {
  const rows = await db.query<{ text: string }>(
    'SELECT text FROM document_pages WHERE document_id = $1 ORDER BY page_number',
    [documentId],
  );
  return rows.rows.map((row) => row.text);
}

const SCANNED_EN_PAGES = [
  'The Lighthouse at Saltmarsh. The lighthouse at Saltmarsh was built in 1884 by a mason named Oswin Hartley, who carried every stone from the quarry on a flat wooden cart. For forty winters the lamp was tended by the keeper Marguerite Dunmore, who recorded the weather in a blue ledger. Ships passing the headland could see the beam for twelve miles, and the harbour master praised its steady light.',
  "The Blue Ledger. The blue ledger survives in the village archive. Its last entry, dated 3 November 1923, reads that the fog bell rang for nine hours and that three fishing boats found the harbour safely. After the keeper retired the lamp was automated, and the keeper's cottage became a small museum open on summer weekends.",
];

describe.skipIf(!RUN)('scanned pages through the pipeline (real Tesseract)', () => {
  it('reads an English scan: OCR pages, the words that were drawn, highlights from the OCR line boxes (scanned-en.pdf)', async () => {
    const server = await ocrServer();
    const client = server.client();
    const accepted = summaryOf(await client.uploadFixture('scanned-en.pdf'));
    const answers = await tickUntilDone(client, accepted.id, { timeoutMs: 120_000 });
    const progress = answers.flatMap((answer) =>
      answer.progress.stage === 'ocr'
        ? [{ completed: answer.progress.completed, total: answer.progress.total }]
        : [],
    );
    const ready = await detailOf(client, accepted.id);

    expect(ready.status).toBe('ready');
    expect(ready.warnings).toEqual([]);
    expect(ready.primaryLanguage).toBe('en');
    expect(ready.direction).toBe('ltr');
    expect(
      ready.pages.map((page) => [page.pageNumber, page.extraction, page.language, page.direction]),
    ).toEqual([
      [1, 'ocr', 'en', 'ltr'],
      [2, 'ocr', 'en', 'ltr'],
    ]);
    for (const page of ready.pages) {
      expect(page.ocrConfidence).toBeGreaterThan(85);
      expect(page.width).toBeCloseTo(595.44, 1); // the page size in points, not the pixels of the render
    }
    const texts = await pageTexts(ready.id);
    SCANNED_EN_PAGES.forEach((expected, index) => {
      expect(wordRecall(expected, texts[index] ?? '')).toBeGreaterThanOrEqual(0.8);
    });
    // Real progress: one event per page, out of the two pages that need OCR.
    expect(progress.map((p) => p.completed)).toEqual([0, 1, 2]);
    expect(progress.every((p) => p.total === 2)).toBe(true);

    // The highlights are the OCR line boxes: the first chunk starts with the heading at the top left of page 1.
    const chunks = await chunksRepo.forDocument(db, ready.id);
    const spans = chunks[0]?.highlights as {
      page: number;
      rects: { x: number; y: number; w: number; h: number }[];
    }[];
    expect(spans[0]?.page).toBe(1);
    const rects = spans[0]?.rects ?? [];
    expect(rects.length).toBeGreaterThanOrEqual(2);
    for (const rect of rects) {
      expect(rect.x).toBeGreaterThan(0.08);
      expect(rect.x + rect.w).toBeLessThan(0.95);
      expect(rect.y + rect.h).toBeLessThanOrEqual(1);
    }
    expect(Math.min(...rects.map((rect) => rect.y))).toBeLessThan(0.12); // the heading is 8% down the page
    expect(chunks.every((chunk) => chunk.section_title === null)).toBe(true); // a scan has no headings to tell by
  }, 180_000);

  it('reads an Arabic scan: Arabic, right to left, and the key word after normalisation (scanned-ar.pdf)', async () => {
    const server = await ocrServer();
    const client = server.client();
    const ready = await waitForDocument(
      client,
      summaryOf(await client.uploadFixture('scanned-ar.pdf')).id,
      120_000,
    );
    expect(ready.status).toBe('ready');
    expect(ready.primaryLanguage).toBe('ar');
    expect(ready.direction).toBe('rtl');
    expect(ready.pages[0]).toMatchObject({ extraction: 'ocr', language: 'ar', direction: 'rtl' });
    expect(ready.pages[0]?.ocrConfidence).toBeGreaterThan(60);
    const [text] = await pageTexts(ready.id);
    expect(normalizeForMatch(text ?? '')).toContain(normalizeForMatch('المرصد'));
    const chunks = await chunksRepo.forDocument(db, ready.id);
    expect(chunks.every((chunk) => chunk.direction === 'rtl' && chunk.language === 'ar')).toBe(true);
  }, 180_000);

  it('handles a mixed PDF page by page: the text page stays text, the scanned page is OCR (mixed-scanned.pdf)', async () => {
    const server = await ocrServer();
    const client = server.client();
    const ready = await waitForDocument(
      client,
      summaryOf(await client.uploadFixture('mixed-scanned.pdf')).id,
      120_000,
    );
    expect(ready.status).toBe('ready');
    expect(ready.pages.map((page) => [page.pageNumber, page.extraction])).toEqual([
      [1, 'text'],
      [2, 'ocr'],
    ]);
    expect(ready.pages[0]?.ocrConfidence).toBeNull();
    expect(ready.pages[1]?.ocrConfidence).toBeGreaterThan(85);
    expect(ready.warnings).toEqual([]);
    const [, second] = await pageTexts(ready.id);
    expect(
      wordRecall(
        'The second station lies beside the old pumping house. Herons nest in the reeds there',
        second ?? '',
      ),
    ).toBeGreaterThanOrEqual(0.8);
  }, 180_000);

  it('reads a scan whose image is above the 16 megapixel extraction limit (scanned-large.pdf: 4320 x 4320)', async () => {
    const server = await ocrServer();
    const client = server.client();
    const ready = await waitForDocument(
      client,
      summaryOf(await client.uploadFixture('scanned-large.pdf')).id,
      120_000,
    );
    expect(ready.status).toBe('ready');
    expect(ready.pages[0]).toMatchObject({ extraction: 'ocr' });
    const [text] = await pageTexts(ready.id);
    expect(
      wordRecall(
        'A high resolution scan keeps every detail of the page, but its image is far larger than the limit',
        text ?? '',
      ),
    ).toBeGreaterThanOrEqual(0.8);
  }, 180_000);

  it('reads a Persian scan with the Persian pack: Persian letters, language fa (scanned-fa.pdf)', async () => {
    const server = await ocrServer();
    const client = server.client();
    const ready = await waitForDocument(
      client,
      summaryOf(await client.uploadFixture('scanned-fa.pdf')).id,
      120_000,
    );
    expect(ready.status).toBe('ready');
    expect(ready.primaryLanguage).toBe('fa');
    expect(ready.direction).toBe('rtl');
    expect(ready.pages[0]).toMatchObject({ extraction: 'ocr', language: 'fa', direction: 'rtl' });
    const [text] = await pageTexts(ready.id);
    // `ara` cannot write these letters: seeing them means the page was read with `fas`.
    expect(text).toMatch(/[پچژگ]/u);
    expect(normalizeForMatch(text ?? '')).toContain(normalizeForMatch('رصدخانه'));
    const chunks = await chunksRepo.forDocument(db, ready.id);
    expect(chunks.every((chunk) => chunk.language === 'fa' && chunk.direction === 'rtl')).toBe(true);
  }, 180_000);

  it('reads an Urdu scan with the Urdu pack: letters only Urdu has, language ur (scanned-ur.pdf)', async () => {
    const server = await ocrServer();
    const client = server.client();
    const ready = await waitForDocument(
      client,
      summaryOf(await client.uploadFixture('scanned-ur.pdf')).id,
      120_000,
    );
    expect(ready.status).toBe('ready');
    expect(ready.primaryLanguage).toBe('ur');
    expect(ready.pages[0]).toMatchObject({ extraction: 'ocr', language: 'ur', direction: 'rtl' });
    const [text] = await pageTexts(ready.id);
    expect(text).toMatch(/[ٹڈڑںے]/u);
    expect(normalizeForMatch(text ?? '')).toContain(normalizeForMatch('رصد'));
  }, 180_000);

  it('reads a French scan with the French pack, found by the trial from English and Arabic (scanned-fr.pdf)', async () => {
    const server = await ocrServer();
    const client = server.client();
    const ready = await waitForDocument(
      client,
      summaryOf(await client.uploadFixture('scanned-fr.pdf')).id,
      120_000,
    );
    expect(ready.status).toBe('ready');
    expect(ready.primaryLanguage).toBe('fr');
    expect(ready.direction).toBe('ltr');
    const [text] = await pageTexts(ready.id);
    expect(
      wordRecall(
        'Le phare de Saltmarsh fut construit en 1884 par un maçon nommé Oswin Hartley, qui transporta chaque pierre depuis la carrière sur une charrette en bois. Pendant quarante hivers, la lampe fut entretenue par la gardienne Marguerite Dunmore',
        text ?? '',
      ),
    ).toBeGreaterThanOrEqual(0.8);
    expect(text).toContain('maçon'); // read with `fra`: the accents are there
  }, 180_000);

  it('chooses the language of a scan by trying the candidates on the first page: English, Arabic, Persian, Urdu and French scans each get their own pack', async () => {
    const host = new IngestWorkerHost({
      maxOldGenerationSizeMb: 768,
      pageTimeoutMs: 20_000,
      maxRssGrowthMb: 512,
    });
    const settings = ocrSettingsOf(testConfig({ OCR_PROVIDER: 'tesseract' })); // eng and ara, English and Arabic packs
    const english = await host.ocr(new Uint8Array(await readFixture('scanned-en.pdf')), {
      pages: [1, 2],
      languageSample: '',
      settings,
    });
    expect(english.languages).toEqual(['eng']);
    expect(english.results.map((r) => r.languages)).toEqual([['eng'], ['eng']]);
    const arabic = await host.ocr(new Uint8Array(await readFixture('scanned-ar.pdf')), {
      pages: [1],
      languageSample: '',
      settings,
    });
    expect(arabic.languages).toEqual(['ara']);
    const run = (name: string) =>
      readFixture(name).then((bytes) =>
        host.ocr(new Uint8Array(bytes), { pages: [1], languageSample: '', settings }),
      );
    expect((await run('scanned-fa.pdf')).languages).toEqual(['fas']);
    expect((await run('scanned-ur.pdf')).languages).toEqual(['urd']);
    expect((await run('scanned-fr.pdf')).languages).toEqual(['fra']);
    expect(settings.cacheDir).toBe(path.join(REPO_ROOT, '.data', 'tessdata'));
  }, 180_000);
});

// To run on Kaggle (real Tesseract): these three need the engine and are not run on the development laptop.
describe.skipIf(!RUN)('text drawn as vector outlines, through OCR (real Tesseract)', () => {
  it('recovers the text of a PDF whose glyphs are filled paths, English (outlined-en.pdf, gs -dNoOutputFonts)', async () => {
    const server = await ocrServer();
    const client = server.client();
    const ready = await waitForDocument(
      client,
      summaryOf(await client.uploadFixture('outlined-en.pdf')).id,
      120_000,
    );
    expect(ready.status).toBe('ready');
    expect(ready.pages.map((page) => page.extraction)).toEqual(['ocr']);
    expect(ready.pages[0]?.ocrConfidence).toBeGreaterThan(85);
    expect(ready.primaryLanguage).toBe('en');
    const [text] = await pageTexts(ready.id);
    expect(
      wordRecall(
        'The Founding. The house was founded by Alaric Thornquist, a cartographer who bought the hill in the spring of 1847. According to the deed, the purchase was completed on 14 March 1847 and the first stones were laid before the summer.',
        text ?? '',
      ),
    ).toBeGreaterThanOrEqual(0.8);
  }, 180_000);

  it('recovers the text of a PDF whose glyphs are filled paths, Arabic (outlined-ar.pdf)', async () => {
    const server = await ocrServer();
    const client = server.client();
    const ready = await waitForDocument(
      client,
      summaryOf(await client.uploadFixture('outlined-ar.pdf')).id,
      120_000,
    );
    expect(ready.status).toBe('ready');
    expect(ready.pages[0]).toMatchObject({ extraction: 'ocr', language: 'ar', direction: 'rtl' });
    expect(ready.primaryLanguage).toBe('ar');
    const [text] = await pageTexts(ready.id);
    expect(normalizeForMatch(text ?? '')).toContain(normalizeForMatch('المكتبة'));
    expect(normalizeForMatch(text ?? '')).toContain(normalizeForMatch('المدينة القديمة'));
  }, 180_000);

  it('reads the outlined page of a document that has a text page, page by page (mixed-outlined.pdf)', async () => {
    const server = await ocrServer();
    const client = server.client();
    const ready = await waitForDocument(
      client,
      summaryOf(await client.uploadFixture('mixed-outlined.pdf')).id,
      120_000,
    );
    expect(ready.status).toBe('ready');
    expect(ready.pages.map((page) => page.extraction)).toEqual(['text', 'ocr']);
    expect(ready.warnings).toEqual([]);
    const [, second] = await pageTexts(ready.id);
    expect(normalizeForMatch(second ?? '')).toContain(normalizeForMatch('المكتبة'));
  }, 180_000);
});

describe.skipIf(!RUN)('PDFs whose text layer is broken, through OCR (real Tesseract)', () => {
  it('recovers the Arabic text of a PDF without ToUnicode maps: OCR replaces the garbage (arabic-no-tounicode.pdf)', async () => {
    const server = await ocrServer();
    const client = server.client();
    const ready = await waitForDocument(
      client,
      summaryOf(await client.uploadFixture('arabic-no-tounicode.pdf')).id,
      120_000,
    );
    expect(ready.status).toBe('ready');
    expect(ready.pages.map((page) => page.extraction)).toEqual(['ocr', 'ocr', 'ocr']);
    expect(ready.warnings).toEqual([]);
    expect(ready.primaryLanguage).toBe('ar');
    expect(ready.direction).toBe('rtl');
    const texts = await pageTexts(ready.id);
    // The name of the founder, on page 2, is exactly what pdf.js could not give: it is in the OCR text.
    expect(normalizeForMatch(texts[1] ?? '')).toContain(normalizeForMatch('يوسف القرطبي'));
    expect(normalizeForMatch(texts[0] ?? '')).toContain(normalizeForMatch('المكتبة'));
    const chunks = await chunksRepo.forDocument(db, ready.id);
    expect(chunks.every((chunk) => chunk.language === 'ar' && chunk.direction === 'rtl')).toBe(true);
  }, 180_000);

  it('sends a PDF that lost glyphs through OCR and keeps whichever text is better, page by page (arabic-damaged.pdf)', async () => {
    const server = await ocrServer();
    const client = server.client();
    const accepted = summaryOf(await client.uploadFixture('arabic-damaged.pdf'));
    const answers = await tickUntilDone(client, accepted.id, { timeoutMs: 120_000 });
    const ocrProgress = answers.flatMap((answer) =>
      answer.progress.stage === 'ocr' ? [answer.progress.completed] : [],
    );
    const ready = await detailOf(client, accepted.id);
    expect(ready.status).toBe('ready');
    expect(ocrProgress.at(-1)).toBe(3); // all three pages were read by OCR
    // Measured against the text that was typeset, word by word (recall): the extracted text of page 1 (a few lost glyphs)
    // is more accurate than OCR (1.00 against 0.81) and stays, and on page 3 OCR is better (0.92 against 0.88). Page 2 is
    // a close call (0.96 against 0.88 by the measure; scores 83 and 81 by the rule), so the test does not pin it: it only
    // asks that the page is flagged exactly when its text is the extracted text.
    expect(ready.pages[0]?.extraction).toBe('text');
    expect(ready.pages[2]?.extraction).toBe('ocr');
    const flagged = ready.pages.filter((page) => page.extraction === 'text').map((page) => page.pageNumber);
    expect(ready.warnings).toEqual([{ code: 'LOW_TEXT_QUALITY', pages: flagged }]);
    expect(ready.pages[2]?.ocrConfidence).toBeGreaterThan(80);
    expect(ready.primaryLanguage).toBe('ar');
  }, 180_000);

  it('keeps the cleaned text and flags LOW_TEXT_QUALITY when OCR is not available (arabic-damaged.pdf, OCR_PROVIDER=none)', async () => {
    const server = await startServer(db, testConfig({ OCR_PROVIDER: 'none' }));
    servers.push(server);
    const client = server.client();
    const ready = await waitForDocument(
      client,
      summaryOf(await client.uploadFixture('arabic-damaged.pdf')).id,
    );
    expect(ready.status).toBe('ready');
    expect(ready.warnings).toEqual([
      { code: 'OCR_UNAVAILABLE', pages: [1, 2, 3] },
      { code: 'LOW_TEXT_QUALITY', pages: [1, 2, 3] },
    ]);
    expect(ready.pages.every((page) => page.extraction === 'text')).toBe(true);
  }, 120_000);
});

describe.skipIf(!RUN)('OCR is no way around the limits on hostile PDFs (real Tesseract)', () => {
  it('does not try OCR on a page whose extraction already failed (hostile-images.pdf stays unreadable)', async () => {
    const server = await ocrServer();
    const client = server.client();
    const failed = await waitForDocument(
      client,
      summaryOf(await client.uploadFixture('hostile-images.pdf')).id,
      120_000,
    );
    expect(failed.status).toBe('failed');
    expect(failed.error?.code).toBe('PDF_UNREADABLE');
    expect(failed.error?.message).toBe(
      'The pages appear damaged or unreadable. (1 of 1 pages could not be read)',
    );
  }, 180_000);

  it('stops OCR on a 62 megapixel image at the render timeout, and /api/health keeps answering meanwhile (oversized-image.pdf)', async () => {
    const server = await ocrServer({ INGEST_PAGE_TIMEOUT_MS: '8000' });
    const client = server.client();
    await server.app.ingestion.ocr.isAvailable(); // the engine is checked at start-up in production
    const accepted = summaryOf(await client.uploadFixture('oversized-image.pdf'));
    const latencies: number[] = [];
    let status = 'processing';
    while (status === 'processing') {
      const began = Date.now();
      expect((await server.app.inject('/api/health')).statusCode).toBe(200);
      latencies.push(Date.now() - began);
      status = (await detailOf(client, accepted.id)).status;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const failed = await detailOf(client, accepted.id);
    expect(failed.status).toBe('failed');
    expect(failed.error?.code).toBe('PDF_UNREADABLE');
    expect(failed.error?.message).toContain('hold images too large to decode');
    expect(Math.max(...latencies)).toBeLessThan(1000);
  }, 180_000);

  it('fails a blank PDF as PDF_EMPTY without starting OCR: there is nothing on the page to read (empty.pdf)', async () => {
    const server = await ocrServer();
    const client = server.client();
    const accepted = summaryOf(await client.uploadFixture('empty.pdf'));
    const stages = (await tickUntilDone(client, accepted.id, { timeoutMs: 120_000 })).map(
      (answer) => answer.progress.stage,
    );
    const failed = await detailOf(client, accepted.id);
    expect(failed.status).toBe('failed');
    expect(failed.error?.code).toBe('PDF_EMPTY');
    expect(failed.error?.message).toBe('The PDF has no readable text. (no page contains text)');
    expect(stages).not.toContain('ocr');
    expect(server.app.ingestion.ocr.peek()).toBeNull(); // the engine was never even asked about
  }, 180_000);
});

describe.skipIf(!RUN)('OCR health (real Tesseract)', () => {
  it('says "checking" until the engine has been checked, then that it is available, and does not start it again for every call', async () => {
    const server = await ocrServer();
    const before = await server.app.inject('/api/health');
    expect(before.json<{ providers: { ocr: string } }>().providers.ocr).toBe('checking');
    expect(await server.app.ingestion.ocr.isAvailable()).toBe(true); // what start-up does once the embedding model is loaded
    const first = await server.app.inject('/api/health');
    expect(first.json<{ providers: { ocr: string } }>().providers.ocr).toBe('tesseract');
    const config = await server.app.inject('/api/config');
    expect(config.json<{ ocr: unknown }>().ocr).toEqual({ provider: 'tesseract', available: true });
    const started = performance.now();
    for (let i = 0; i < 5; i += 1) await server.app.inject('/api/health');
    expect(performance.now() - started).toBeLessThan(250); // cached: no thread, no engine
  }, 120_000);
});
