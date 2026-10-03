import type { ProgressEvent } from '@enchanted/shared';
import { describe, expect, it } from 'vitest';
import { languageSampleOf, runOcrStage, type OcrStageDeps } from '../src/ingest/ocr-stage.js';
import type { OcrOptions, OcrRun } from '../src/ingest/worker/host.js';
import type { OcrPageResult } from '../src/ingest/worker/protocol.js';
import { buildOcrPageText } from '../src/ocr/ocr-page.js';
import { ocrSettings, ocrStageConfig } from './ocr-doubles/settings.js';

const pageText = (words: string) =>
  buildOcrPageText(
    {
      text: words,
      confidence: 88,
      languagesUsed: ['eng'],
      lines: [{ text: words, confidence: 88, bbox: { x0: 100, y0: 100, x1: 900, y1: 140 } }],
    },
    { pageWidth: 612, pageHeight: 792, imageWidth: 1700, imageHeight: 2200 },
  );

const result = (pageNumber: number): OcrPageResult => ({
  pageNumber,
  confidence: 88,
  languages: ['eng'],
  text: pageText(`text of page ${String(pageNumber)}`),
});

interface Harness {
  deps: OcrStageDeps;
  asked: OcrOptions[];
  events: ProgressEvent[];
  emit: (progress: ProgressEvent) => Promise<void>;
  chain: (previous: Promise<void>, progress: ProgressEvent) => Promise<void>;
}

function harness(options: {
  provider?: 'tesseract' | 'none';
  available?: boolean;
  maxPages?: number;
  run?: (options: OcrOptions) => OcrRun;
}): Harness {
  const asked: OcrOptions[] = [];
  const events: ProgressEvent[] = [];
  const run =
    options.run ??
    ((o: OcrOptions): OcrRun => ({
      results: o.pages.map(result),
      failures: [],
      unavailable: false,
      languages: ['eng'],
      quotaReached: false,
      configFault: null,
      requests: null,
    }));
  return {
    asked,
    events,
    emit: (progress) => {
      events.push(progress);
      return Promise.resolve();
    },
    chain: (previous, progress) => previous.then(() => void events.push(progress)),
    deps: {
      workers: {
        ocr: (_bytes, o) => {
          asked.push(o);
          for (const [index] of o.pages.entries())
            o.onProgress?.({ completed: index + 1, total: o.pages.length });
          return Promise.resolve(run(o));
        },
      },
      ocr: {
        isAvailable: () => Promise.resolve(options.available ?? true),
        peek: () => options.available ?? true,
      },
      config: ocrStageConfig({
        ocrProvider: options.provider ?? 'tesseract',
        ocrLanguages: ['eng', 'ara'],
        ocrMaxPages: options.maxPages ?? 60,
        ocrCacheDir: '/tessdata',
        ocrDpi: 200,
      }),
      log: { info: () => undefined, warn: () => undefined, error: () => undefined },
    },
  };
}

const bytes = new Uint8Array(4);
const stage = (h: Harness, pages: number[]) =>
  runOcrStage(h.deps, {
    bytes,
    pages,
    languageSample: 'sample',
    signal: new AbortController().signal,
    emit: h.emit,
    chain: h.chain,
  });

describe('runOcrStage', () => {
  it('does nothing, and says nothing, when no page needs OCR', async () => {
    const h = harness({});
    const outcome = await stage(h, []);
    expect(outcome.outcomes.size).toBe(0);
    expect(outcome.available).toBeNull();
    expect(h.events).toEqual([]);
    expect(h.asked).toEqual([]);
  });

  it('reads the pages with real progress: completed over the number of pages that will be read', async () => {
    const h = harness({});
    const outcome = await stage(h, [2, 4, 5]);
    expect(h.asked[0]?.pages).toEqual([2, 4, 5]);
    expect(h.asked[0]?.languageSample).toBe('sample');
    expect(h.asked[0]?.settings).toEqual(
      ocrSettings({ cacheDir: '/tessdata', languages: ['eng', 'ara'], dpi: 200, geminiMaxRpm: 0 }),
    );
    expect(h.events.map((e) => [e.stage, e.completed, e.total, e.unit])).toEqual([
      ['ocr', 0, 3, 'pages'],
      ['ocr', 1, 3, 'pages'],
      ['ocr', 2, 3, 'pages'],
      ['ocr', 3, 3, 'pages'],
    ]);
    expect([...outcome.outcomes.entries()].map(([page, o]) => [page, o.kind])).toEqual([
      [2, 'read'],
      [4, 'read'],
      [5, 'read'],
    ]);
    expect(outcome.available).toBe(true);
  });

  it('skips the pages beyond OCR_MAX_PAGES (the first pages are read) and counts only the others in the progress', async () => {
    const h = harness({ maxPages: 2 });
    const outcome = await stage(h, [1, 2, 3, 4]);
    expect(h.asked[0]?.pages).toEqual([1, 2]);
    expect(h.events.at(-1)).toMatchObject({ completed: 2, total: 2 });
    expect([...outcome.outcomes.entries()].map(([page, o]) => [page, o.kind])).toEqual([
      [1, 'read'],
      [2, 'read'],
      [3, 'skipped'],
      [4, 'skipped'],
    ]);
  });

  it('marks pages the engine failed on as failed and keeps the ones it read', async () => {
    const h = harness({
      run: () => ({
        results: [result(1), result(3)],
        failures: [{ pageNumber: 2, reason: 'timeout', message: 'it took too long' }],
        unavailable: false,
        languages: ['eng'],
        quotaReached: false,
        configFault: null,
        requests: null,
      }),
    });
    const outcome = await stage(h, [1, 2, 3]);
    expect([...outcome.outcomes.entries()].map(([page, o]) => [page, o.kind])).toEqual([
      [1, 'read'],
      [2, 'failed'],
      [3, 'read'],
    ]);
    const first = outcome.outcomes.get(1);
    expect(first).toMatchObject({ kind: 'read', confidence: 88, languages: ['eng'] });
  });

  it('marks the pages the daily quota left unread as failed with the reason, says why, and keeps the pages read', async () => {
    const warnings: [object, string][] = [];
    const h = harness({
      run: () => ({
        results: [result(1)],
        failures: [
          { pageNumber: 2, reason: 'quota', message: 'daily quota reached' },
          { pageNumber: 3, reason: 'quota', message: 'daily quota reached' },
        ],
        unavailable: false,
        languages: null,
        quotaReached: true,
        configFault: null,
        requests: null,
      }),
    });
    h.deps.log = {
      info: () => undefined,
      warn: (object, message) => void warnings.push([object, message]),
      error: () => undefined,
    };
    const outcome = await stage(h, [1, 2, 3]);
    expect([...outcome.outcomes.entries()].map(([page, o]) => [page, o.kind])).toEqual([
      [1, 'read'],
      [2, 'failed'],
      [3, 'failed'],
    ]);
    expect(outcome.outcomes.get(2)).toEqual({ kind: 'failed', detail: 'daily quota reached' });
    expect(outcome.detail).toBe('daily quota reached');
    expect(outcome.available).toBe(true);
    expect(warnings).toEqual([[{ pages: 2 }, 'OCR stopped: daily quota reached']]);
  });

  it('has no detail when nothing but the usual happened', async () => {
    expect((await stage(harness({}), [1])).detail).toBeNull();
    expect((await stage(harness({ provider: 'none' }), [1])).detail).toBeNull();
  });

  it('marks every page unavailable, without starting a thread, when OCR is switched off or the engine is known not to start', async () => {
    for (const h of [harness({ provider: 'none' }), harness({ available: false })]) {
      const outcome = await stage(h, [1, 2]);
      expect([...outcome.outcomes.values()].map((o) => o.kind)).toEqual(['unavailable', 'unavailable']);
      expect(outcome.available).toBe(false);
      expect(h.asked).toEqual([]);
      expect(h.events).toEqual([]);
    }
  });

  it('marks every page unavailable when the worker thread reports that the engine did not start', async () => {
    const h = harness({
      run: () => ({
        results: [],
        failures: [],
        unavailable: true,
        languages: null,
        quotaReached: false,
        configFault: null,
        requests: null,
      }),
    });
    const outcome = await stage(h, [1, 2, 3]);
    expect([...outcome.outcomes.values()].map((o) => o.kind)).toEqual([
      'unavailable',
      'unavailable',
      'unavailable',
    ]);
    expect(outcome.available).toBe(false);
  });

  it('gives the worker the OCR time budget of the document (OCR_MAX_SECONDS) in milliseconds', async () => {
    const h = harness({});
    h.deps.config.ocrMaxSeconds = 90;
    await stage(h, [1]);
    expect(h.asked[0]?.budgetMs).toBe(90_000);
  });

  it('skips every page without asking the engine when OCR_MAX_PAGES is 0', async () => {
    const h = harness({ maxPages: 0 });
    const outcome = await stage(h, [1, 2]);
    expect([...outcome.outcomes.values()].map((o) => o.kind)).toEqual(['skipped', 'skipped']);
    expect(h.asked).toEqual([]);
  });
});

describe('languageSampleOf', () => {
  const english =
    'The house was founded by a cartographer in the spring of the year and a workroom was built. ';
  it('takes the text of the pages that have enough of it and are not garbage, in page order, within a limit', () => {
    const pages = [
      { pageNumber: 1, text: english, charCount: english.length },
      { pageNumber: 2, text: 'short', charCount: 5 },
      { pageNumber: 3, text: 'garbage garbage garbage garbage garbage', charCount: 35 },
      { pageNumber: 4, text: english.repeat(100), charCount: english.length * 100 },
    ];
    const sample = languageSampleOf(pages, {
      minChars: 25,
      unreliable: (pageNumber) => pageNumber === 3,
      maxChars: 500,
    });
    expect(sample.startsWith(english)).toBe(true);
    expect(sample).not.toContain('short');
    expect(sample).not.toContain('garbage');
    expect(sample.length).toBeLessThanOrEqual(500);
  });
});
