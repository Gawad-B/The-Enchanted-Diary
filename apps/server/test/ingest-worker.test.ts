import { describe, expect, it } from 'vitest';
import { AppError } from '../src/http/errors.js';
import {
  IngestWorkerHost,
  MAX_CONSECUTIVE_PAGE_FAILURES,
  type HostLimits,
  type HostOptions,
} from '../src/ingest/worker/host.js';
import { readFixture } from './fixtures.js';

const CHUNKING = { targetChars: 1100, maxChars: 1600, minChars: 200, overlapChars: 150 };
const MB = 1024 * 1024;
// The defaults of the configuration.
const DEFAULT_LIMITS: HostLimits = {
  maxOldGenerationSizeMb: 768,
  pageTimeoutMs: 20_000,
  maxRssGrowthMb: 512,
};
const host = (limits: Partial<HostLimits> = {}, options: HostOptions = {}): IngestWorkerHost =>
  new IngestWorkerHost({ ...DEFAULT_LIMITS, ...limits }, options);

const bytesOf = async (name: string): Promise<Uint8Array> => new Uint8Array(await readFixture(name));

const rejection = async (promise: Promise<unknown>): Promise<AppError> => {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(AppError);
  return error as AppError;
};

/** Samples the resident memory of this process while `run` runs; returns the peak growth in MB. */
async function peakGrowthMb(run: () => Promise<unknown>): Promise<number> {
  const base = process.memoryUsage.rss();
  let peak = 0;
  const timer = setInterval(() => {
    peak = Math.max(peak, process.memoryUsage.rss() - base);
  }, 25);
  try {
    await run();
  } finally {
    clearInterval(timer);
  }
  return Math.round(peak / MB);
}

const doubleEntry = (name: string) => ({
  url: new URL(`./doubles/${name}`, import.meta.url),
  execArgv: [] as string[],
});

describe('IngestWorkerHost (real worker threads)', () => {
  it('validates a PDF: page count from a worker thread, the caller bytes untouched', async () => {
    const bytes = await bytesOf('text-en.pdf');
    const before = bytes.byteLength;
    expect(await host().validate(bytes, { maxPages: 300 })).toEqual({ pageCount: 5 });
    expect(bytes.byteLength).toBe(before);
  }, 30_000);

  it('maps what is wrong with a file to the right error code', async () => {
    const h = host();
    expect((await rejection(h.validate(await bytesOf('encrypted.pdf'), { maxPages: 300 }))).code).toBe(
      'PDF_ENCRYPTED',
    );
    expect((await rejection(h.validate(await bytesOf('malformed.pdf'), { maxPages: 300 }))).code).toBe(
      'PDF_MALFORMED',
    );
    expect((await rejection(h.validate(await bytesOf('not-a-pdf.pdf'), { maxPages: 300 }))).code).toBe(
      'PDF_MALFORMED',
    );
    const tooMany = await rejection(h.validate(await bytesOf('twelve-pages.pdf'), { maxPages: 10 }));
    expect(tooMany.code).toBe('TOO_MANY_PAGES');
    expect(tooMany.message).toContain('12 pages');
  }, 60_000);

  it('parses every page with progress, then analyses and chunks in another worker', async () => {
    const h = host();
    const bytes = await bytesOf('text-en.pdf');
    const progress: number[] = [];
    const parsed = await h.parse(bytes, { maxPages: 300, onProgress: (p) => progress.push(p.completed) });
    expect(parsed.pageCount).toBe(5);
    expect(parsed.failures).toEqual([]);
    expect(parsed.pages.map((page) => page.pageNumber)).toEqual([1, 2, 3, 4, 5]);
    expect(progress.at(-1)).toBe(5);
    expect(progress).toEqual([...progress].sort((a, b) => a - b));
    expect(parsed.pages[1]?.text).toContain('Alaric Thornquist');
    expect('items' in (parsed.pages[0] ?? {})).toBe(false);
    expect(parsed.pages[0]?.blocks[0]?.lines[0]?.rect.w).toBeGreaterThan(0);

    const steps: string[] = [];
    const analysis = await h.analyze(parsed.pages, {
      outline: parsed.outline,
      chunking: CHUNKING,
      onProgress: (step) => steps.push(step),
    });
    expect(analysis.sections.map((s) => s.title)).toEqual([
      'A Brief History of Thornquist House',
      'The Founding',
      'The Lost Archive',
      'Conclusion',
    ]);
    expect(analysis.chunks).toHaveLength(5);
    expect(analysis.primaryLanguage).toBe('en');
    expect(new Set(steps)).toEqual(new Set(['analyzing', 'chunking']));
  }, 60_000);

  it('stops a memory bomb of images with the DEFAULT limits: the page is recorded as unreadable and the process stays bounded', async () => {
    // 40 images of 14.4 megapixels on one page: every one is below the extraction image limit, together they decode to
    // about 2 GB of typed arrays that no heap limit covers. The 20 s page timeout is nowhere near.
    const bytes = await bytesOf('hostile-images.pdf');
    const started = Date.now();
    let result: Awaited<ReturnType<IngestWorkerHost['parse']>> | undefined;
    const growth = await peakGrowthMb(async () => {
      result = await host().parse(bytes, { maxPages: 300 });
    });
    expect(result?.pages).toEqual([]);
    expect(result?.failures.map((failure) => [failure.pageNumber, failure.reason])).toEqual([[1, 'memory']]);
    expect(result?.failures[0]?.message).toBe('it used more than 512 MB of memory');
    // Unbounded the process grows by 2,100 MB; stopped at the limit it is about 850 MB (350 MB of that is the worker
    // starting through tsx in development, before the page that is limited).
    expect(growth).toBeLessThan(1300);
    expect(Date.now() - started).toBeLessThan(15_000); // long before the 20 s page timeout
  }, 60_000);

  it('refuses an image above the extraction limit at once and reports it as removed', async () => {
    const bytes = await bytesOf('oversized-image.pdf');
    let result: Awaited<ReturnType<IngestWorkerHost['parse']>> | undefined;
    const growth = await peakGrowthMb(async () => {
      result = await host().parse(bytes, { maxPages: 300 });
    });
    expect(result?.failures).toEqual([]);
    expect(result?.pages.map((page) => [page.charCount, page.removedImages, page.imageCoverage])).toEqual([
      [0, 1, 1],
    ]);
    expect(growth).toBeLessThan(500); // nothing was decoded
  }, 60_000);

  it('gives up on a document whose pages keep failing, after five in a row', async () => {
    // Seven pages that all raise an error: the host stops after the fifth and never shows the raw text to the caller.
    const logged: object[] = [];
    const error = await rejection(
      host(
        {},
        { entry: doubleEntry('failing-pages-worker.mjs'), log: { warn: (object) => logged.push(object) } },
      ).parse(new Uint8Array([1]), { maxPages: 300 }),
    );
    expect(error.code).toBe('PDF_UNREADABLE');
    expect(error.detail).toBe(
      `${String(MAX_CONSECUTIVE_PAGE_FAILURES)} pages in a row could not be read (the last was page 5)`,
    );
    expect(JSON.stringify(error)).not.toContain('/home/secret');
    expect(JSON.stringify(logged)).toContain('/home/secret/x.pdf');
  }, 30_000);

  it('terminates the worker at once when the signal is aborted (DELETE during ingestion)', async () => {
    const controller = new AbortController();
    const promise = host({ pageTimeoutMs: 60_000, maxRssGrowthMb: 16_384 }).parse(
      await bytesOf('hostile-images.pdf'),
      {
        maxPages: 300,
        signal: controller.signal,
      },
    );
    const settled = promise.then(
      () => 'finished',
      (e: unknown) => (e as Error).name,
    );
    await new Promise((resolve) => setTimeout(resolve, 2500)); // the thread is busy decoding images by now
    const abortedAt = Date.now();
    controller.abort(new DOMException('deleted', 'AbortError'));
    expect(await settled).toBe('AbortError');
    expect(Date.now() - abortedAt).toBeLessThan(1000);
  }, 60_000);

  it('rejects at once when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort(new DOMException('deleted', 'AbortError'));
    await expect(
      host().validate(await bytesOf('text-en.pdf'), { maxPages: 300, signal: controller.signal }),
    ).rejects.toMatchObject({
      name: 'AbortError',
    });
  });
});

describe('the memory watchdog', () => {
  // A process that gains 100 MB at every sample, whatever it is doing.
  const growingProcess = (): (() => number) => {
    let rss = 1000 * MB;
    return () => (rss += 100 * MB);
  };

  it('ends a worker that grows the process past the limit while it reads a page, and records that page as lost', async () => {
    const h = host(
      { maxRssGrowthMb: 256 },
      { entry: doubleEntry('hanging-page-worker.mjs'), rssBytes: growingProcess(), memorySampleMs: 20 },
    );
    const result = await h.parse(new Uint8Array([1]), { maxPages: 10 });
    expect(result.pages).toEqual([]);
    expect(result.failures).toEqual([
      { pageNumber: 1, reason: 'memory', message: 'it used more than 256 MB of memory' },
      { pageNumber: 2, reason: 'memory', message: 'it used more than 256 MB of memory' },
    ]);
  }, 30_000);

  it('does not hold the embedding model loading against a worker: the baseline follows the process meanwhile', async () => {
    const h = host(
      { maxRssGrowthMb: 256, pageTimeoutMs: 400 },
      {
        entry: doubleEntry('hanging-page-worker.mjs'),
        rssBytes: growingProcess(),
        memorySampleMs: 20,
        pauseMemoryWatch: () => true,
      },
    );
    const result = await h.parse(new Uint8Array([1]), { maxPages: 10 });
    // Not memory: the pages hung and were cut off by the page timeout instead.
    expect(result.failures.map((failure) => [failure.pageNumber, failure.reason])).toEqual([
      [1, 'timeout'],
      [2, 'timeout'],
    ]);
  }, 30_000);

  it('does not watch opening a document or analysing text: growth elsewhere in the process is not theirs', async () => {
    // Other uploads, a model download: the process grows while a PDF is merely being opened. That must not fail it.
    const bytes = await bytesOf('text-en.pdf');
    const growing = host({ maxRssGrowthMb: 64 }, { rssBytes: growingProcess(), memorySampleMs: 10 });
    expect(await growing.validate(bytes, { maxPages: 300 })).toEqual({ pageCount: 5 });
    const parsed = await host().parse(bytes, { maxPages: 300 });
    const analysis = await growing.analyze(parsed.pages, { outline: [], chunking: CHUNKING });
    expect(analysis.chunks).toHaveLength(5);
  }, 60_000);
});

describe('worker misbehaviour', () => {
  it('never sends the raw text of a worker exception to the caller (it is logged)', async () => {
    const logged: object[] = [];
    const h = host(
      {},
      { entry: doubleEntry('misbehaving-worker.mjs'), log: { warn: (object) => logged.push(object) } },
    );
    const error = await rejection(h.validate(new Uint8Array([1, 2, 3]), { maxPages: 10 }));
    expect(error.code).toBe('INTERNAL');
    expect(error.message).toBe('The document could not be processed because of an unexpected error.');
    expect(JSON.stringify(error)).not.toContain('/home/secret');
    expect(error.detail).toBeUndefined();
    expect(JSON.stringify(logged)).toContain('/home/secret/project'); // the log has what the client does not
  });

  it('covers reading the outline with the open limit: a worker that opens the document and then hangs is cut off', async () => {
    const started = Date.now();
    const h = host({}, { entry: doubleEntry('misbehaving-worker.mjs'), openTimeoutMs: 300 });
    const result = await h.parse(new Uint8Array([1]), { maxPages: 10 });
    // No page ever started: each of the three is lost to the open limit, one fresh worker after the other.
    expect(result.pages).toEqual([]);
    expect(result.failures.map((failure) => [failure.pageNumber, failure.reason])).toEqual([
      [1, 'timeout'],
      [2, 'timeout'],
      [3, 'timeout'],
    ]);
    expect(Date.now() - started).toBeLessThan(10_000);
  }, 30_000);

  it('gives the analyse task a limit too', async () => {
    const h = host({}, { entry: doubleEntry('misbehaving-worker.mjs'), analyzeIdleTimeoutMs: 300 });
    const error = await rejection(h.analyze([], { outline: [], chunking: CHUNKING }));
    expect(error.code).toBe('PDF_UNREADABLE');
    expect(error.detail).toBe('analysing the text failed: it took too long');
  }, 30_000);

  it('does not spin forever on a document that reports no pages', async () => {
    const h = host({}, { entry: doubleEntry('empty-document-worker.mjs') });
    const result = await h.parse(new Uint8Array([1]), { maxPages: 10 });
    expect(result).toMatchObject({ pageCount: 0, pages: [], failures: [], outline: [] });
  }, 30_000);
});
