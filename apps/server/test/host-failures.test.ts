import { afterEach, describe, expect, it } from 'vitest';
import { runOcrStage } from '../src/ingest/ocr-stage.js';
import { IngestWorkerHost, MAX_OCR_STOPS, type HostLimits } from '../src/ingest/worker/host.js';
import type { OcrSettings } from '../src/ingest/worker/protocol.js';
import { ocrSettings, ocrStageConfig } from './ocr-doubles/settings.js';

/*
 * The host through failure windows a real engine cannot be made to hit on demand: the thread dies between two pages, or
 * after the last one, or hangs after a page; the engine is gone when a thread is restarted; pages that are lost one in
 * two; a document that uses up its time. The worker thread plays a script (ocr-doubles/scripted-worker.mjs).
 */

const SCRIPTED = {
  url: new URL('./ocr-doubles/scripted-worker.mjs', import.meta.url),
  execArgv: [] as string[],
};
const LIMITS: HostLimits = { maxOldGenerationSizeMb: 768, pageTimeoutMs: 300, maxRssGrowthMb: 16_384 };
const SETTINGS: OcrSettings = ocrSettings({ languages: ['eng'] });

const host = (limits: Partial<HostLimits> = {}): IngestWorkerHost =>
  new IngestWorkerHost({ ...LIMITS, ...limits }, { entry: SCRIPTED });

type Step = Record<string, unknown>;

/** Plays `script` in the threads that run during `run`. */
async function scripted<T>(script: Record<string, Step[]>, run: () => Promise<T>): Promise<T> {
  process.env.SCRIPTED_WORKER = JSON.stringify(script);
  try {
    return await run();
  } finally {
    delete process.env.SCRIPTED_WORKER;
  }
}

// What an OCR thread says.
const ready = (available = true): Step => ({ type: 'ocr-ready', available });
const start = (pageNumber: number): Step => ({ type: 'ocr-page-start', pageNumber, timeoutFactor: 1 });
const read = (pageNumber: number): Step => ({
  type: 'ocr-page',
  page: {
    pageNumber,
    confidence: 90,
    languages: ['eng'],
    text: {
      confidence: 90,
      text: `page ${String(pageNumber)}`,
      blocks: [],
      charCount: 6,
      fontStats: { bodyFontSize: 10, medianLeading: 12, sizes: [], fontNames: [] },
      quality: {},
    },
  },
});
const done: Step = { type: 'ocr-done' };
// What a parse thread says.
const opened = (pageCount: number): Step => ({ type: 'opened', pageCount });
const pageStart = (pageNumber: number): Step => ({ type: 'page-start', pageNumber });
const extracted = (pageNumber: number): Step => ({ type: 'page', page: { pageNumber } });
const parsed: Step = { type: 'parsed' };
const exit: Step = { $: 'exit' };
const hang: Step = { $: 'hang' };

const bytes = new Uint8Array([1, 2, 3]);
const ocr = (
  h: IngestWorkerHost,
  pages: number[],
  extra: { budgetMs?: number; signal?: AbortSignal } = {},
) => {
  const progress: [number, number][] = [];
  return {
    progress,
    run: () =>
      h.ocr(bytes, {
        pages,
        languageSample: '',
        settings: SETTINGS,
        onProgress: ({ completed, total }) => progress.push([completed, total]),
        ...extra,
      }),
  };
};

afterEach(() => {
  delete process.env.SCRIPTED_WORKER;
});

describe('OCR: a thread that dies after it reported a page', () => {
  it('does not charge the page it reported to the failure: the only page, read, stays read', async () => {
    const job = ocr(host(), [1]);
    const run = await scripted({ '1': [ready(), start(1), read(1), exit] }, job.run);
    expect(run.results.map((r) => r.pageNumber)).toEqual([1]);
    expect(run.failures).toEqual([]);
    expect(run.unavailable).toBe(false);
  }, 30_000);

  it('does not push the progress past the total, and the pipeline keeps both pages read', async () => {
    const job = ocr(host(), [1, 2]);
    const run = await scripted({ '1': [ready(), start(1), read(1), start(2), read(2), exit] }, job.run);
    expect(run.results.map((r) => r.pageNumber)).toEqual([1, 2]);
    expect(run.failures).toEqual([]);
    expect(job.progress.every(([completed, total]) => completed <= total)).toBe(true);
    expect(job.progress.at(-1)).toEqual([2, 2]);

    // The same run through the OCR stage: nothing that was read is downgraded to a failure.
    const stage = await scripted({ '1': [ready(), start(1), read(1), start(2), read(2), exit] }, () =>
      runOcrStage(
        {
          workers: host(),
          ocr: { isAvailable: () => Promise.resolve(true), peek: () => true },
          config: ocrStageConfig(),
          log: { info: () => undefined, warn: () => undefined, error: () => undefined },
        },
        {
          bytes,
          pages: [1, 2],
          languageSample: '',
          signal: new AbortController().signal,
          emit: () => Promise.resolve(),
          chain: (previous) => previous,
        },
      ),
    );
    expect([...stage.outcomes.values()].map((o) => o.kind)).toEqual(['read', 'read']);
  }, 30_000);

  it('blames the next page in line when the thread dies between pages, and a fresh thread carries on after it', async () => {
    const job = ocr(host(), [1, 2, 3]);
    const run = await scripted(
      {
        '1': [ready(), start(1), read(1), exit], // dies before it starts page 2
        '3': [ready(), start(3), read(3), done],
      },
      job.run,
    );
    expect(run.results.map((r) => r.pageNumber)).toEqual([1, 3]);
    expect(run.failures).toEqual([
      { pageNumber: 2, reason: 'crash', message: 'the worker stopped unexpectedly' },
    ]);
  }, 30_000);
});

describe('OCR: a thread that is restarted after a lost page', () => {
  const script = {
    '1': [ready(), start(1), read(1), start(2), hang],
    '3': [ready(false)], // the engine is gone when the second thread starts
  };

  it('keeps the pages already read when the engine is reported unavailable, and fails only the pages left', async () => {
    const job = ocr(host(), [1, 2, 3]);
    const run = await scripted(script, job.run);
    expect(run.unavailable).toBe(false);
    expect(run.results.map((r) => r.pageNumber)).toEqual([1]);
    expect(run.failures.map((f) => [f.pageNumber, f.reason])).toEqual([
      [2, 'timeout'],
      [3, 'error'],
    ]);
  }, 30_000);

  it('does so too when the second thread dies before its engine is ready', async () => {
    const job = ocr(host(), [1, 2, 3]);
    const run = await scripted({ ...script, '3': [exit] }, job.run);
    expect(run.unavailable).toBe(false);
    expect(run.results.map((r) => r.pageNumber)).toEqual([1]);
    expect(run.failures.map((f) => [f.pageNumber, f.reason])).toEqual([
      [2, 'timeout'],
      [3, 'error'],
    ]);
  }, 30_000);

  it('reaches the pipeline as one page read and two pages failed (OCR_PARTIAL), not as all pages unavailable', async () => {
    const stage = await scripted(script, () =>
      runOcrStage(
        {
          workers: host(),
          ocr: { isAvailable: () => Promise.resolve(true), peek: () => true },
          config: ocrStageConfig(),
          log: { info: () => undefined, warn: () => undefined, error: () => undefined },
        },
        {
          bytes,
          pages: [1, 2, 3],
          languageSample: '',
          signal: new AbortController().signal,
          emit: () => Promise.resolve(),
          chain: (previous) => previous,
        },
      ),
    );
    expect([...stage.outcomes.values()].map((o) => o.kind)).toEqual(['read', 'failed', 'failed']);
    expect(stage.available).toBe(true);
  }, 30_000);

  it('still reports an engine that is unavailable from the first thread as unavailable, with nothing read or failed', async () => {
    const job = ocr(host(), [1, 2]);
    const run = await scripted({ '1': [ready(false)] }, job.run);
    expect(run).toMatchObject({ unavailable: true, results: [], failures: [] });
  }, 30_000);
});

describe('OCR: a per-document budget', () => {
  it('gives up after a few pages stopped by the time limit, even when pages are read in between (one page in two hangs)', async () => {
    expect(MAX_OCR_STOPS).toBe(3);
    const job = ocr(host(), [1, 2, 3, 4, 5, 6, 7, 8]);
    const started = Date.now();
    const run = await scripted(
      {
        '1': [ready(), start(1), hang],
        '2': [ready(), start(2), read(2), start(3), hang],
        '4': [ready(), start(4), read(4), start(5), hang],
      },
      job.run,
    );
    expect(run.results.map((r) => r.pageNumber)).toEqual([2, 4]);
    expect(run.failures.map((f) => [f.pageNumber, f.reason])).toEqual([
      [1, 'timeout'],
      [3, 'timeout'],
      [5, 'timeout'],
      [6, 'error'],
      [7, 'error'],
      [8, 'error'],
    ]);
    expect(run.failures[3]?.message).toContain('too long');
    expect(Date.now() - started).toBeLessThan(20_000);
  }, 60_000);

  it('stops a document that has used up its OCR time: the page in flight and the pages left fail, what was read stays', async () => {
    const job = ocr(host({ pageTimeoutMs: 60_000 }), [1, 2, 3], { budgetMs: 700 });
    const started = Date.now();
    const run = await scripted({ '1': [ready(), start(1), read(1), start(2), hang] }, job.run);
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(run.results.map((r) => r.pageNumber)).toEqual([1]);
    expect(run.failures.map((f) => [f.pageNumber, f.reason])).toEqual([
      [2, 'budget'],
      [3, 'budget'],
    ]);
    expect(run.unavailable).toBe(false);
  }, 30_000);

  it('still lets the caller cancel: DELETE is an AbortError, not a budget failure', async () => {
    const controller = new AbortController();
    const job = ocr(host({ pageTimeoutMs: 60_000 }), [1, 2], { budgetMs: 60_000, signal: controller.signal });
    setTimeout(() => controller.abort(), 400);
    await expect(scripted({ '1': [ready(), start(1), hang] }, job.run)).rejects.toMatchObject({
      name: 'AbortError',
    });
  }, 30_000);
});

describe('OCR: the model service runs out of its daily quota', () => {
  it('keeps the pages read, records every page left as failed with the reason "quota", and starts no other thread', async () => {
    const job = ocr(host(), [1, 2, 3, 4]);
    // The thread ran the first request (page 1), started the second, and heard that the quota is gone.
    const run = await scripted(
      { '1': [ready(), start(1), read(1), start(2), { type: 'ocr-quota' }, hang] },
      job.run,
    );
    expect(run.results.map((r) => r.pageNumber)).toEqual([1]);
    expect(run.failures).toEqual([
      { pageNumber: 2, reason: 'quota', message: 'daily quota reached' },
      { pageNumber: 3, reason: 'quota', message: 'daily quota reached' },
      { pageNumber: 4, reason: 'quota', message: 'daily quota reached' },
    ]);
    expect(run.quotaReached).toBe(true);
    expect(run.unavailable).toBe(false);
    expect(job.progress.at(-1)).toEqual([4, 4]);
  }, 30_000);

  it('reaches the pages as outcomes "failed" with the detail, and the stage says why', async () => {
    const stage = await scripted({ '1': [ready(), start(1), read(1), { type: 'ocr-quota' }] }, () =>
      runOcrStage(
        {
          workers: host(),
          ocr: { isAvailable: () => Promise.resolve(true), peek: () => true },
          config: ocrStageConfig(),
          log: { info: () => undefined, warn: () => undefined, error: () => undefined },
        },
        {
          bytes,
          pages: [1, 2, 3],
          languageSample: '',
          signal: new AbortController().signal,
          emit: () => Promise.resolve(),
          chain: (previous) => previous,
        },
      ),
    );
    expect([...stage.outcomes.entries()].map(([page, outcome]) => [page, outcome.kind])).toEqual([
      [1, 'read'],
      [2, 'failed'],
      [3, 'failed'],
    ]);
    expect(stage.outcomes.get(2)).toEqual({ kind: 'failed', detail: 'daily quota reached' });
    expect(stage.detail).toBe('daily quota reached');
    expect(stage.available).toBe(true);
  }, 30_000);

  it('gives a request the time it names, beyond the page timeout, and stops it when that is used up too', async () => {
    // The page timeout is 300 ms; the thread announces a request that may take 3 s, and answers after 800 ms.
    const long = { type: 'ocr-page-start', pageNumber: 1, timeoutFactor: 1, timeoutMs: 3000 };
    const job = ocr(host(), [1]);
    const run = await scripted({ '1': [ready(), long, { $: 'wait', ms: 800 }, read(1), done] }, job.run);
    expect(run.results.map((r) => r.pageNumber)).toEqual([1]);
    expect(run.failures).toEqual([]);

    const hung = ocr(host({ pageTimeoutMs: 200 }), [1]);
    const stopped = await scripted({ '1': [ready(), { ...long, timeoutMs: 600 }, hang] }, hung.run);
    expect(stopped.failures).toMatchObject([{ pageNumber: 1, reason: 'timeout' }]);
  }, 30_000);
});

const requestFailed = (pageNumbers: number[]): Step => ({
  type: 'ocr-request-failed',
  pageNumbers,
  service: true,
  message: 'the model service was not available',
  raw: 'status 503',
});

describe('OCR: requests the model service could not answer', () => {
  it('counts a failed batch once: eight pages fail together and the pages after them are still read', async () => {
    const job = ocr(host(), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    const run = await scripted(
      {
        '1': [
          ready(),
          start(1),
          requestFailed([1, 2, 3, 4, 5, 6, 7, 8]), // more than the five pages that used to end the document's OCR
          start(9),
          read(9),
          read(10),
          done,
        ],
      },
      job.run,
    );
    expect(run.results.map((r) => r.pageNumber)).toEqual([9, 10]);
    expect(run.failures.map((f) => [f.pageNumber, f.reason])).toEqual(
      [1, 2, 3, 4, 5, 6, 7, 8].map((page) => [page, 'service']),
    );
    expect(run.failures[0]?.message).toBe('the model service was not available');
    expect(run.quotaReached).toBe(false);
    expect(job.progress.at(-1)).toEqual([10, 10]);
  }, 30_000);

  it('gives up after five failed requests in a row, and the pages left are "service" failures, not damaged ones', async () => {
    const job = ocr(host(), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    const run = await scripted(
      {
        '1': [
          ready(),
          start(1),
          requestFailed([1, 2]),
          requestFailed([3, 4]),
          requestFailed([5, 6]),
          requestFailed([7, 8]),
          requestFailed([9, 10]),
          start(11),
          read(11),
          done,
        ],
      },
      job.run,
    );
    expect(run.results).toEqual([]); // page 11 was never reached: the host had given up
    expect(run.failures).toHaveLength(12);
    expect(run.failures.every((f) => f.reason === 'service')).toBe(true);
    expect(run.failures.at(-1)?.message).toBe('OCR stopped: the model service did not answer');
  }, 30_000);

  it('leaves no page without an outcome when a page the answer left out meets the quota after the pages behind it were read', async () => {
    const job = ocr(host(), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    const run = await scripted(
      {
        '1': [
          ready(),
          start(1),
          ...[2, 3, 4, 5, 6, 7, 8].map(read), // the batch's answer had every page but the first
          start(1), // page 1 asked for alone ...
          { type: 'ocr-quota' }, // ... and the daily quota is gone
          hang,
        ],
      },
      job.run,
    );
    expect(run.results.map((r) => r.pageNumber)).toEqual([2, 3, 4, 5, 6, 7, 8]);
    expect(run.failures.map((f) => [f.pageNumber, f.reason])).toEqual([
      [1, 'quota'],
      [9, 'quota'],
      [10, 'quota'],
    ]);
    expect(run.results.length + run.failures.length).toBe(10); // every page settled exactly once
    expect(job.progress.at(-1)).toEqual([10, 10]);
  }, 30_000);

  it('turns a scan whose every request failed into a "try again later" document, through the stage and the settling', async () => {
    const stage = await scripted({ '1': [ready(), start(1), requestFailed([1, 2, 3]), done] }, () =>
      runOcrStage(
        {
          workers: host(),
          ocr: { isAvailable: () => Promise.resolve(true), peek: () => true },
          config: ocrStageConfig(),
          log: { info: () => undefined, warn: () => undefined, error: () => undefined },
        },
        {
          bytes,
          pages: [1, 2, 3],
          languageSample: '',
          signal: new AbortController().signal,
          emit: () => Promise.resolve(),
          chain: (previous) => previous,
        },
      ),
    );
    expect([...stage.outcomes.values()]).toEqual([
      { kind: 'failed', detail: 'model service unavailable' },
      { kind: 'failed', detail: 'model service unavailable' },
      { kind: 'failed', detail: 'model service unavailable' },
    ]);
    expect(stage.detail).toBe('model service unavailable');
  }, 30_000);
});

describe('OCR: the service refuses the configuration, or the time allowed runs out', () => {
  /** The OCR stage over the scripted thread, with what it logged. */
  const stage = (pages: number[], options: { maxSeconds?: number } = {}) => {
    const logged: { level: string; message: string }[] = [];
    return {
      logged,
      run: () =>
        runOcrStage(
          {
            workers: host(),
            ocr: { isAvailable: () => Promise.resolve(true), peek: () => true },
            config: ocrStageConfig({ ocrMaxSeconds: options.maxSeconds ?? 600 }),
            log: {
              info: () => undefined,
              warn: (_object, message) => void logged.push({ level: 'warn', message }),
              error: (_object, message) => void logged.push({ level: 'error', message }),
            },
          },
          {
            bytes,
            pages,
            languageSample: '',
            signal: new AbortController().signal,
            emit: () => Promise.resolve(),
            chain: (previous) => previous,
          },
        ),
    };
  };

  it('fails the pages left with the curated fault, keeps the pages read, and does not start another thread', async () => {
    const job = ocr(host(), [1, 2, 3, 4, 5, 6]);
    const run = await scripted(
      {
        '1': [
          ready(),
          start(1),
          read(1),
          start(2),
          { type: 'ocr-config-fault', detail: 'the key was rejected' },
          hang,
        ],
      },
      job.run,
    );
    expect(run.results.map((r) => r.pageNumber)).toEqual([1]);
    expect(run.failures.map((f) => [f.pageNumber, f.reason, f.message])).toEqual(
      [2, 3, 4, 5, 6].map((page) => [page, 'config', 'the key was rejected']),
    );
    expect(run.configFault).toBe('the key was rejected');
    expect(run.quotaReached).toBe(false);
    expect(job.progress.at(-1)).toEqual([6, 6]);
  }, 30_000);

  it('reaches the pages as outcomes with that detail, and is logged once at error level', async () => {
    const job = stage([1, 2, 3]);
    const result = await scripted(
      { '1': [ready(), start(1), { type: 'ocr-config-fault', detail: 'model not found' }] },
      job.run,
    );
    expect([...result.outcomes.values()]).toEqual(
      [1, 2, 3].map(() => ({ kind: 'failed', detail: 'model not found' })),
    );
    expect(result.detail).toBe('model not found');
    const errors = job.logged.filter((entry) => entry.level === 'error');
    expect(errors).toHaveLength(1);
    expect(errors[0]?.message).toContain('GEMINI_API_KEY and OCR_MODEL');
  }, 30_000);

  it('gives the pages left when the time allowed runs out, mid-request, a detail of their own, not none', async () => {
    // page 1's request never comes back; the budget (1 s) ends the thread
    const job = stage([1, 2, 3], { maxSeconds: 1 });
    const request = { type: 'ocr-page-start', pageNumber: 1, timeoutFactor: 1, timeoutMs: 60_000 }; // a request may take long
    const result = await scripted({ '1': [ready(), request, hang] }, job.run);
    expect([...result.outcomes.values()]).toEqual(
      [1, 2, 3].map(() => ({ kind: 'failed', detail: 'time allowed for OCR used up' })),
    );
    expect(result.detail).toBe('time allowed for OCR used up');
    expect(
      job.logged.some(
        (entry) => entry.level === 'warn' && entry.message.includes('time allowed for OCR used up'),
      ),
    ).toBe(true);
  }, 30_000);
});

describe('parse: a thread that dies between pages', () => {
  const parse = (h: IngestWorkerHost) => {
    const progress: [number, number][] = [];
    return {
      progress,
      run: () =>
        h.parse(bytes, {
          maxPages: 300,
          onProgress: ({ completed, total }) => progress.push([completed, total]),
        }),
    };
  };

  it('blames the next page, not the one it extracted, and carries on after it', async () => {
    const job = parse(host());
    const result = await scripted(
      {
        '1': [opened(3), pageStart(1), extracted(1), exit], // dies before it starts page 2
        '3': [opened(3), pageStart(3), extracted(3), parsed],
      },
      job.run,
    );
    expect(result.pageCount).toBe(3);
    expect(result.pages.map((p) => p.pageNumber)).toEqual([1, 3]);
    expect(result.failures).toEqual([
      { pageNumber: 2, reason: 'crash', message: 'the worker stopped unexpectedly' },
    ]);
    expect(job.progress.every(([completed, total]) => completed <= total)).toBe(true);
    expect(job.progress.at(-1)).toEqual([3, 3]);
  }, 30_000);

  it('blames nobody when it dies after the last page and before it says it is finished', async () => {
    const job = parse(host());
    const result = await scripted(
      { '1': [opened(2), pageStart(1), extracted(1), pageStart(2), extracted(2), exit] },
      job.run,
    );
    expect(result.pages.map((p) => p.pageNumber)).toEqual([1, 2]);
    expect(result.failures).toEqual([]);
  }, 30_000);
});
