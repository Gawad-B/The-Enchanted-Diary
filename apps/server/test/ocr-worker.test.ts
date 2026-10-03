import { afterEach, describe, expect, it } from 'vitest';
import {
  IngestWorkerHost,
  type HostLimits,
  type HostLogger,
  type HostOptions,
  type OcrRun,
} from '../src/ingest/worker/host.js';
import type { OcrSettings } from '../src/ingest/worker/protocol.js';
import { ocrSettings } from './ocr-doubles/settings.js';
import type { FakeOcrScript } from './ocr-doubles/fake-ocr-provider.js';
import { readFixture } from './fixtures.js';

/*
 * The OCR task through the real host and real worker threads, with a fake engine in the thread (the engine itself is
 * tested in ocr-tesseract.model.test.ts): what is asked of the engine, in what order, and what the host does when a
 * page throws, hangs, eats memory, or the engine does not start.
 */

const SETTINGS: OcrSettings = ocrSettings();
const LIMITS: HostLimits = { maxOldGenerationSizeMb: 768, pageTimeoutMs: 20_000, maxRssGrowthMb: 512 };
const FAKE_ENTRY = {
  url: new URL('./ocr-doubles/fake-ocr-worker.mjs', import.meta.url),
  execArgv: ['--conditions=source'],
};

const warnings: { object: object; message: string }[] = [];
const log: HostLogger = { warn: (object, message) => void warnings.push({ object, message }) };

const host = (limits: Partial<HostLimits> = {}, options: HostOptions = {}): IngestWorkerHost =>
  new IngestWorkerHost({ ...LIMITS, ...limits }, { log, entry: FAKE_ENTRY, ...options });

/** Runs `run` with the fake engine behaving as `script` (the thread reads FAKE_OCR when it starts). */
async function withScript<T>(script: FakeOcrScript, run: () => Promise<T>): Promise<T> {
  process.env.FAKE_OCR = JSON.stringify(script);
  try {
    return await run();
  } finally {
    delete process.env.FAKE_OCR;
  }
}

const pdf = async (): Promise<Uint8Array> => new Uint8Array(await readFixture('twelve-pages.pdf'));
const textOf = (run: OcrRun, pageNumber: number): string =>
  run.results.find((result) => result.pageNumber === pageNumber)?.text.text ?? '';

afterEach(() => {
  warnings.length = 0;
});

describe('IngestWorkerHost.ocr', () => {
  it('reads the pages in order with real progress, deciding the languages once on the first page', async () => {
    const progress: [number, number][] = [];
    const run = await withScript({ confidence: { eng: 92, ara: 31 } }, async () =>
      host().ocr(await pdf(), {
        pages: [1, 2, 3],
        languageSample: '',
        settings: SETTINGS,
        onProgress: ({ completed, total }) => progress.push([completed, total]),
      }),
    );
    expect(run.unavailable).toBe(false);
    expect(run.failures).toEqual([]);
    expect(run.results.map((result) => result.pageNumber)).toEqual([1, 2, 3]);
    expect(run.languages).toEqual(['eng']);
    expect(progress).toEqual([
      [1, 3],
      [2, 3],
      [3, 3],
    ]);
    // The first page ran the trial (eng, then ara); the other pages were read with the decided language only.
    expect(textOf(run, 1)).toContain('languages eng calls eng\n'.trim());
    expect(textOf(run, 2)).toContain('languages eng calls eng,ara,eng');
    expect(textOf(run, 3)).toContain('languages eng calls eng,ara,eng,eng');
    const first = run.results[0];
    expect(first?.confidence).toBe(90); // the confidence of its lines (the engine's own, 92, was for the trial)
    expect(first?.languages).toEqual(['eng']);
    expect(first?.text.blocks[0]?.lines[0]?.text).toBe('Fake page 1 line one');
    // The box is a fraction of the page: 10% from the left, 15% from the top, 80% wide, 3% high.
    const rect = first?.text.blocks[0]?.lines[0]?.rect;
    expect(rect?.x).toBeCloseTo(0.1, 2);
    expect(rect?.y).toBeCloseTo(0.15, 2);
    expect(rect?.w).toBeCloseTo(0.8, 2);
    expect(rect?.h).toBeCloseTo(0.03, 2);
  }, 60_000);

  it('uses the languages of the document text for the candidates when it has any', async () => {
    const french =
      'La maison a été fondée par un cartographe qui a acheté la colline au printemps et qui a construit un atelier avec de hautes fenêtres.';
    const run = await withScript({}, async () =>
      host().ocr(await pdf(), {
        pages: [1],
        languageSample: french,
        settings: { ...SETTINGS, languages: ['eng', 'ara'], extraLanguages: ['fra', 'spa'] },
      }),
    );
    // French is allowed through OCR_EXTRA_LANGUAGES: it is the only candidate, so there is one read and no trial.
    expect(textOf(run, 1)).toContain('languages fra calls fra');
    expect(run.languages).toEqual(['fra']);
  }, 60_000);

  it('records a page that throws as failed, with a curated message, and goes on with the next one', async () => {
    const run = await withScript({ throwOnPage: [2], confidence: { eng: 92, ara: 31 } }, async () =>
      host().ocr(await pdf(), { pages: [1, 2, 3], languageSample: '', settings: SETTINGS }),
    );
    expect(run.results.map((result) => result.pageNumber)).toEqual([1, 3]);
    expect(run.failures).toEqual([
      { pageNumber: 2, reason: 'error', message: 'the page could not be read by OCR' },
    ]);
    expect(JSON.stringify(run)).not.toContain('/home/secret');
    expect(warnings.some((w) => JSON.stringify(w.object).includes('/home/secret/path'))).toBe(true); // logged only
  }, 60_000);

  it('stops a page that never returns at the page timeout, and a fresh thread carries on with the decided languages', async () => {
    const run = await withScript({ hangOnPage: [2], confidence: { eng: 92, ara: 31 } }, async () =>
      host({ pageTimeoutMs: 2000 }).ocr(await pdf(), {
        pages: [1, 2, 3],
        languageSample: '',
        settings: SETTINGS,
      }),
    );
    expect(run.failures).toEqual([{ pageNumber: 2, reason: 'timeout', message: 'it took too long' }]); // after 2 x 2 s
    expect(run.results.map((result) => result.pageNumber)).toEqual([1, 3]);
    // The new thread did not run the trial again: it read page 3 once, with the language decided on page 1.
    expect(textOf(run, 3)).toContain('languages eng calls eng');
    expect(textOf(run, 3)).not.toContain('calls eng,');
  }, 60_000);

  it('gives the trial page the time of all its reads, and a page that is not the trial one read', async () => {
    // Every read takes 1.5 s against a page timeout of 2 s: a page with one read fits, and the trial page, which reads
    // twice (3 s) with more to come, fits because it is allowed the time of all its reads.
    const run = await withScript({ delayMs: 1500, confidence: { eng: 92, ara: 31 } }, async () =>
      host({ pageTimeoutMs: 2000 }).ocr(await pdf(), {
        pages: [1, 2],
        languageSample: '',
        settings: SETTINGS,
      }),
    );
    expect(run.failures).toEqual([]);
    expect(run.results.map((result) => result.pageNumber)).toEqual([1, 2]);
  }, 60_000);

  it('holds a page that is not the trial page to one page timeout for its one read', async () => {
    const run = await withScript({ delayMs: 2500, confidence: { eng: 92, ara: 31 } }, async () =>
      host({ pageTimeoutMs: 2000 }).ocr(await pdf(), {
        pages: [1, 2],
        languageSample:
          'The house was founded by a cartographer who bought the hill in the spring and built a workroom.',
        settings: SETTINGS, // English only: page 1 is the trial page (allowed its extra reads), page 2 is read once
      }),
    );
    expect(run.results.map((result) => result.pageNumber)).toEqual([1]);
    expect(run.failures).toEqual([{ pageNumber: 2, reason: 'timeout', message: 'it took too long' }]);
  }, 60_000);

  it('stops the rendering of a page that takes more than twice the page timeout (a huge image decodes for minutes)', async () => {
    const bytes = new Uint8Array(await readFixture('oversized-image.pdf'));
    const started = Date.now();
    const run = await withScript({}, async () =>
      // The memory watchdog is out of the way: only time can stop this page.
      host({ pageTimeoutMs: 1500, maxRssGrowthMb: 16_384 }).ocr(bytes, {
        pages: [1],
        languageSample: '',
        settings: SETTINGS,
      }),
    );
    expect(run.failures).toEqual([{ pageNumber: 1, reason: 'timeout', message: 'it took too long' }]);
    expect(Date.now() - started).toBeLessThan(30_000);
  }, 60_000);

  it('stops a page that grows the process too much, like a page that timed out', async () => {
    const run = await withScript({ hogOnPage: { '2': 400 }, confidence: { eng: 92, ara: 31 } }, async () =>
      host({ maxRssGrowthMb: 128, pageTimeoutMs: 30_000 }).ocr(await pdf(), {
        pages: [1, 2, 3],
        languageSample: '',
        settings: SETTINGS,
      }),
    );
    expect(run.failures).toEqual([
      { pageNumber: 2, reason: 'memory', message: 'it used more than 128 MB of memory' },
    ]);
    expect(run.results.map((result) => result.pageNumber)).toEqual([1, 3]);
  }, 60_000);

  it('reports an engine that cannot start as unavailable, without reading anything', async () => {
    const run = await withScript({ unavailable: true }, async () =>
      host().ocr(await pdf(), { pages: [1, 2], languageSample: '', settings: SETTINGS }),
    );
    expect(run).toMatchObject({ unavailable: true, results: [], failures: [] });
  }, 60_000);

  it('gives up after five pages in a row fail, and records the rest as failed too', async () => {
    const run = await withScript({ throwOnPage: [1, 2, 3, 4, 5, 6, 7] }, async () =>
      host().ocr(await pdf(), { pages: [1, 2, 3, 4, 5, 6, 7], languageSample: '', settings: SETTINGS }),
    );
    expect(run.results).toEqual([]);
    expect(run.failures.map((failure) => failure.pageNumber)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(run.failures.every((failure) => failure.reason === 'error')).toBe(true);
  }, 60_000);

  it('stops at once when cancelled', async () => {
    const controller = new AbortController();
    const reading = withScript({ hangOnPage: [1] }, async () =>
      host({ pageTimeoutMs: 60_000 }).ocr(await pdf(), {
        pages: [1, 2],
        languageSample: '',
        settings: SETTINGS,
        signal: controller.signal,
      }),
    );
    setTimeout(() => controller.abort(), 3000);
    const started = Date.now();
    await expect(reading).rejects.toMatchObject({ name: 'AbortError' });
    expect(Date.now() - started).toBeLessThan(10_000);
  }, 60_000);
});

describe('IngestWorkerHost.checkOcr', () => {
  it('says whether the engine can start, from a worker thread', async () => {
    expect(await withScript({}, () => host().checkOcr(SETTINGS))).toBe(true);
    expect(await withScript({ unavailable: true }, () => host().checkOcr(SETTINGS))).toBe(false);
  }, 60_000);

  it('is false for OCR_PROVIDER=none (the real worker)', async () => {
    const real = new IngestWorkerHost(LIMITS, { log });
    expect(await real.checkOcr({ ...SETTINGS, provider: 'none' })).toBe(false);
  }, 60_000);
});
