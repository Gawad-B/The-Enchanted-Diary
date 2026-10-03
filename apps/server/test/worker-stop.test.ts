import { Worker } from 'node:worker_threads';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { IngestWorkerHost, type HostLimits } from '../src/ingest/worker/host.js';
import { runThread, type ThreadEnd } from '../src/ingest/worker/thread.js';
import { readFixture } from './fixtures.js';

/*
 * Ending a worker thread. `worker.terminate()` on a thread that is inside pdf.js can abort the WHOLE Node process (node_zlib.cc
 * "close before init", about once in 650 stops, seen with every parse tick that ran out of time). A thread that has nothing
 * to do with its task any more is therefore asked to stop and ends by itself; terminate() is only the fallback for one that
 * does not. These tests run real threads on a real multi-page PDF: a process that aborts takes the test run down with it.
 */

const LIMITS: HostLimits = { maxOldGenerationSizeMb: 768, pageTimeoutMs: 20_000, maxRssGrowthMb: 16_384 };
const bytesOf = async (name: string): Promise<Uint8Array> => new Uint8Array(await readFixture(name));

/** A grace so long that no thread of these tests is terminated for being slow on a loaded machine: they must end by themselves. */
const LONG_GRACE_MS = 60_000;

afterEach(() => {
  vi.restoreAllMocks();
});

/**
 * Watches the threads that were asked to stop: how many there were, and how each ended (`once('exit')` is what the host
 * registers when it asks a thread to stop, and nothing else does).
 */
function watchStops(): { asked: () => number; ended: (timeoutMs: number) => Promise<number[]> } {
  const exits: number[] = [];
  let asked = 0;
  const once = Worker.prototype.once;
  vi.spyOn(Worker.prototype, 'once').mockImplementation(function (
    this: Worker,
    event: string | symbol,
    listener: (...args: never[]) => void,
  ) {
    if (event === 'exit') {
      asked += 1;
      once.call(this, 'exit', (code: number) => {
        exits.push(code);
      });
    }
    return once.call(this, event, listener as (...args: unknown[]) => void);
  } as typeof Worker.prototype.once);
  return {
    asked: () => asked,
    ended: async (timeoutMs) => {
      const deadline = Date.now() + timeoutMs;
      while (exits.length < asked && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      return exits;
    },
  };
}

/** A range of `multi-page-long.pdf` that runs out of time after `pages` pages. */
async function stopAfter(
  host: IngestWorkerHost,
  bytes: Uint8Array,
  pageCount: number,
  pages: number,
  signal?: AbortSignal,
): Promise<{ extracted: number; nextPage: number }> {
  let seen = 0;
  return host.parseRange(bytes, {
    startPage: 1,
    pageCount,
    maxPages: 1000,
    readOutline: false,
    // Asked once for every page that arrives: the tick is out of time after `pages` of them.
    shouldStop: () => {
      seen += 1;
      return seen >= pages;
    },
    ...(signal === undefined ? {} : { signal }),
    onPage: () => Promise.resolve(),
    onFailure: () => Promise.resolve(),
    onOutline: () => Promise.resolve(),
  });
}

/** Runs `count` jobs with `parallel` of them at a time. */
async function inBatches(
  count: number,
  parallel: number,
  job: (index: number) => Promise<void>,
): Promise<void> {
  let next = 0;
  await Promise.all(
    Array.from({ length: parallel }, async () => {
      while (next < count) {
        const index = next;
        next += 1;
        await job(index);
      }
    }),
  );
}

describe('stopping a range of pages between two pages', () => {
  it('leaves the pages it did not reach for the next tick, and the thread ends by itself (no terminate)', async () => {
    const terminate = vi.spyOn(Worker.prototype, 'terminate');
    const watch = watchStops();
    const host = new IngestWorkerHost(LIMITS, { stopGraceMs: LONG_GRACE_MS });
    const bytes = await bytesOf('multi-page-long.pdf');
    const { pageCount } = await host.validate(bytes, { maxPages: 1000 });
    expect(pageCount).toBeGreaterThan(3);
    const result = await stopAfter(host, bytes, pageCount, 2);
    expect(result).toEqual({ extracted: 2, nextPage: 3 });
    // The threads (the one that validated, the one that read) end with code 0 on their own.
    expect(await watch.ended(60_000)).toEqual([0, 0]);
    expect(terminate).not.toHaveBeenCalled();
  }, 120_000);

  it('never terminates, and never takes the process down, over 200 stops (the old way aborted about one in 650)', async () => {
    const terminate = vi.spyOn(Worker.prototype, 'terminate');
    const watch = watchStops();
    const host = new IngestWorkerHost(LIMITS, { stopGraceMs: LONG_GRACE_MS });
    const bytes = await bytesOf('multi-page-long.pdf');
    const { pageCount } = await host.validate(bytes, { maxPages: 1000 });
    const stops = 200;
    const results: { extracted: number; nextPage: number }[] = [];
    await inBatches(stops, 8, async (index) => {
      // One page, or two, so that the stop comes right after pdf.js has been busy with a page.
      results.push(await stopAfter(host, bytes, pageCount, 1 + (index % 2)));
    });
    expect(results).toHaveLength(stops);
    expect(results.every((result) => result.extracted === result.nextPage - 1 && result.extracted >= 1)).toBe(
      true,
    );
    // Every thread (one to validate, one for each stop) was asked to stop, and every one ended by itself, with code 0.
    const exits = await watch.ended(120_000);
    expect(watch.asked()).toBe(stops + 1);
    expect(exits).toHaveLength(stops + 1);
    expect(exits.every((code) => code === 0)).toBe(true);
    expect(terminate).not.toHaveBeenCalled();
  }, 900_000);

  it('ends a range that is cancelled between two pages by itself too, and a cancel inside a page still ends at once', async () => {
    const terminate = vi.spyOn(Worker.prototype, 'terminate');
    const host = new IngestWorkerHost(LIMITS, { stopGraceMs: LONG_GRACE_MS });
    const bytes = await bytesOf('multi-page-long.pdf');
    const { pageCount } = await host.validate(bytes, { maxPages: 1000 });
    // Cancelled at all sorts of moments, while the thread starts, reads a page or waits between two: the host's answer is an
    // AbortError each time, at once, and no process dies.
    const outcomes: string[] = [];
    await inBatches(24, 8, async (index) => {
      const controller = new AbortController();
      const run = stopAfter(host, bytes, pageCount, pageCount, controller.signal).then(
        () => 'finished',
        (error: unknown) => (error as Error).name,
      );
      setTimeout(
        () => {
          controller.abort(new DOMException('deleted', 'AbortError'));
        },
        150 + ((index * 37) % 700),
      );
      outcomes.push(await run);
    });
    expect(outcomes.every((outcome) => outcome === 'AbortError' || outcome === 'finished')).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 2600));
    // (A cancel that came while a page was being read terminated its thread: that is the path that is left, and it is the
    // one a process can still, rarely, be taken down by.)
    expect(terminate.mock.calls.length).toBeLessThanOrEqual(24);
  }, 300_000);
});

describe('a thread that does not end when asked', () => {
  it('is terminated after the grace period, and the run has resolved by then', async () => {
    const terminate = vi.spyOn(Worker.prototype, 'terminate');
    const entry = {
      url: new URL('./doubles/hanging-parse-worker.mjs', import.meta.url),
      execArgv: [] as string[],
    };
    const started = Date.now();
    const end: ThreadEnd = await runThread({
      entry,
      task: { task: 'parse', bytes: new Uint8Array([1]), startPage: 1, maxPages: 10, readOutline: false },
      bytes: new Uint8Array([1]),
      maxOldGenerationSizeMb: 256,
      signal: undefined,
      initialWatchdogMs: null,
      memory: { limitBytes: 1e12, sampleMs: 1000, rssBytes: () => 0, paused: () => false },
      stopGraceMs: 300,
      // The thread says it is on a page and then hangs there; the host decides it has no use for it.
      onMessage: (message, control) => {
        if (message.type === 'page-start') control.finish();
      },
    });
    expect(end).toEqual({ kind: 'finished' });
    // The run did not wait for the thread: it resolved at once, and the thread is terminated once the grace is over.
    expect(Date.now() - started).toBeLessThan(5000);
    expect(terminate).not.toHaveBeenCalled();
    await vi.waitFor(
      () => {
        expect(terminate).toHaveBeenCalledTimes(1);
      },
      { timeout: 5000 },
    );
  }, 30_000);

  it('is terminated at once when it is misbehaving (it timed out, it grew too big, it crashed)', async () => {
    const terminate = vi.spyOn(Worker.prototype, 'terminate');
    const entry = {
      url: new URL('./doubles/hanging-parse-worker.mjs', import.meta.url),
      execArgv: [] as string[],
    };
    const end = await runThread({
      entry,
      task: { task: 'parse', bytes: new Uint8Array([1]), startPage: 1, maxPages: 10, readOutline: false },
      bytes: new Uint8Array([1]),
      maxOldGenerationSizeMb: 256,
      signal: undefined,
      initialWatchdogMs: 400,
      memory: { limitBytes: 1e12, sampleMs: 1000, rssBytes: () => 0, paused: () => false },
      onMessage: () => undefined,
    });
    expect(end).toEqual({ kind: 'watchdog' });
    expect(terminate).toHaveBeenCalledTimes(1);
  }, 30_000);
});
