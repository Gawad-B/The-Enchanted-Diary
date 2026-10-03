import { ApiError, type GenerateContentResponse } from '@google/genai';
import { Worker } from 'node:worker_threads';
import { describe, expect, it } from 'vitest';
import {
  DAILY_QUOTA_DETAIL,
  GeminiBlockedError,
  GeminiEmptyResponseError,
  GeminiPacer,
  classifyGeminiError,
  createPacerBuffer,
  geminiText,
  getGeminiClient,
  getGeminiPacer,
  hasGeminiKey,
  isAbortLike,
  isDailyQuotaError,
  isRetryableGeminiError,
  mapGeminiError,
  parseGeminiError,
  withGeminiRetry,
} from '../src/gemini/index.js';
import { AppError } from '../src/http/errors.js';
import { apiError, dailyQuota, rateLimited } from './ocr-doubles/fake-gemini.js';

/*
 * The shared Gemini module (src/gemini): what a failure of the service means, how a call is retried and paced, how a
 * response is read. Everything here runs against stand-ins; nothing reaches Google.
 */

const noSleep = { sleep: () => Promise.resolve(), random: () => 0.5 };

describe('failures of the service', () => {
  it('reads the status, the delay the service asks for and a daily quota out of the error body', () => {
    expect(parseGeminiError(rateLimited('23s'))).toMatchObject({
      status: 429,
      retryDelayMs: 23_000,
      dailyQuota: false,
    });
    expect(parseGeminiError(dailyQuota())).toMatchObject({ status: 429, dailyQuota: true });
    expect(parseGeminiError(apiError(429, { message: 'Please retry in 1.5s.' })).retryDelayMs).toBe(1500);
    expect(parseGeminiError(new Error('plain'))).toMatchObject({ status: null, retryDelayMs: null });
  });

  it('maps every failure to one of the codes the server speaks, with a curated message', () => {
    const cases: [unknown, string][] = [
      [rateLimited(), 'RATE_LIMITED'],
      [dailyQuota(), 'RATE_LIMITED'],
      [apiError(503, { status: 'UNAVAILABLE' }), 'LLM_UNAVAILABLE'],
      [apiError(500), 'LLM_UNAVAILABLE'],
      [
        apiError(401, { message: 'API key not valid. Please pass a valid API key: AIzaSy-leak' }),
        'LLM_UNAVAILABLE',
      ],
      [apiError(404, { message: 'models/nope is not found' }), 'LLM_UNAVAILABLE'],
      [apiError(400, { message: 'Invalid JSON payload received. Unknown name "x"' }), 'LLM_FAILED'],
      [new TypeError('fetch failed'), 'LLM_UNAVAILABLE'],
      [new GeminiBlockedError('SAFETY'), 'OUTPUT_BLOCKED'],
    ];
    for (const [error, code] of cases) {
      const mapped = mapGeminiError(error);
      expect(mapped).toBeInstanceOf(AppError);
      expect(mapped.code).toBe(code);
      expect(mapped.message + String(mapped.detail)).not.toMatch(/AIzaSy|Invalid JSON|models\/nope/u);
    }
    const own = new AppError('INTERNAL', 'mine');
    expect(mapGeminiError(own)).toBe(own);
  });

  it('tells a daily quota from a rate limit, in the raw error and in the AppError made of it', () => {
    expect(isDailyQuotaError(dailyQuota())).toBe(true);
    expect(isDailyQuotaError(mapGeminiError(dailyQuota()))).toBe(true);
    expect(mapGeminiError(dailyQuota()).detail).toBe(DAILY_QUOTA_DETAIL);
    expect(isDailyQuotaError(rateLimited())).toBe(false);
    expect(isDailyQuotaError(new Error('x'))).toBe(false);
  });

  it('retries a rate limit, a timeout, a server error and a dropped connection, and nothing else', () => {
    expect(isRetryableGeminiError(rateLimited())).toBe(true);
    expect(isRetryableGeminiError(apiError(503))).toBe(true);
    expect(isRetryableGeminiError(apiError(408))).toBe(true);
    expect(isRetryableGeminiError(new TypeError('fetch failed'))).toBe(true);
    const timeout = new Error('slow');
    timeout.name = 'TimeoutError';
    expect(isRetryableGeminiError(timeout)).toBe(true);
    expect(isRetryableGeminiError(dailyQuota())).toBe(false);
    expect(isRetryableGeminiError(apiError(400))).toBe(false);
    expect(isRetryableGeminiError(apiError(401))).toBe(false);
    expect(isRetryableGeminiError(new GeminiBlockedError('SAFETY'))).toBe(false);
  });

  it('classifies for callers with their own error type', () => {
    expect(classifyGeminiError(rateLimited())).toMatchObject({ retryable: true, status: 429 });
    expect(classifyGeminiError(dailyQuota())).toMatchObject({ retryable: false });
    expect(classifyGeminiError(apiError(400))).toMatchObject({ retryable: false, status: 400 });
    expect(classifyGeminiError(apiError(503)).retryable).toBe(true);
  });

  it('recognises a cancellation, also behind a cause', () => {
    const abort = new Error('x');
    abort.name = 'AbortError';
    expect(isAbortLike(abort)).toBe(true);
    expect(isAbortLike(new Error('wrapped', { cause: abort }))).toBe(true);
    expect(isAbortLike(new Error('other'))).toBe(false);
  });
});

describe('withGeminiRetry', () => {
  it('returns the first answer without waiting', async () => {
    let calls = 0;
    const value = await withGeminiRetry(() => Promise.resolve(++calls), noSleep);
    expect([value, calls]).toEqual([1, 1]);
  });

  it('waits the delay the service asks for, with a little jitter, then succeeds', async () => {
    const waits: number[] = [];
    let calls = 0;
    const value = await withGeminiRetry(
      () => (++calls < 3 ? Promise.reject(rateLimited('4s')) : Promise.resolve('done')),
      { sleep: (ms) => Promise.resolve(void waits.push(ms)), random: () => 0.4 },
    );
    expect(value).toBe('done');
    expect(waits).toEqual([4100, 4100]); // 4 s + 250 ms * 0.4
  });

  it('backs off exponentially when the service names no delay', async () => {
    const waits: number[] = [];
    let calls = 0;
    await withGeminiRetry(() => (++calls < 4 ? Promise.reject(apiError(503)) : Promise.resolve(0)), {
      maxAttempts: 4,
      baseDelayMs: 500,
      sleep: (ms) => Promise.resolve(void waits.push(ms)),
      random: () => 0.5, // jitter factor 1
    });
    expect(waits).toEqual([500, 1000, 2000]);
  });

  it('stops after its attempts with the mapped error', async () => {
    let calls = 0;
    const failure = await withGeminiRetry(() => Promise.reject((++calls, apiError(503))), {
      ...noSleep,
      maxAttempts: 3,
    }).catch((error: unknown) => error);
    expect(calls).toBe(3);
    expect(failure).toMatchObject({ code: 'LLM_UNAVAILABLE' });
  });

  it('does not wait for a delay longer than it will wait, nor past its total', async () => {
    let calls = 0;
    const long = await withGeminiRetry(() => Promise.reject((++calls, rateLimited('120s'))), noSleep).catch(
      (error: unknown) => error,
    );
    expect(calls).toBe(1);
    expect(long).toMatchObject({ code: 'RATE_LIMITED' });

    calls = 0;
    await withGeminiRetry(() => Promise.reject((++calls, rateLimited('20s'))), {
      ...noSleep,
      maxAttempts: 10,
      maxTotalWaitMs: 45_000,
    }).catch(() => undefined);
    expect(calls).toBe(3); // 20 s + 20 s waited, the third wait would pass 45 s
  });

  it('never retries a daily quota or a request the service refused', async () => {
    let calls = 0;
    await expect(
      withGeminiRetry(() => Promise.reject((++calls, dailyQuota())), noSleep),
    ).rejects.toMatchObject({
      detail: DAILY_QUOTA_DETAIL,
    });
    await expect(
      withGeminiRetry(() => Promise.reject((++calls, apiError(400))), noSleep),
    ).rejects.toMatchObject({
      code: 'LLM_FAILED',
    });
    expect(calls).toBe(2);
  });

  it('lets an AppError and a cancellation through as they are', async () => {
    const own = new AppError('INTERNAL', 'mine');
    await expect(withGeminiRetry(() => Promise.reject(own), noSleep)).rejects.toBe(own);
    const controller = new AbortController();
    let calls = 0;
    const abort = new Error('aborted');
    abort.name = 'AbortError';
    await expect(
      withGeminiRetry(
        () => {
          calls += 1;
          controller.abort();
          return Promise.reject(abort);
        },
        { ...noSleep, signal: controller.signal },
      ),
    ).rejects.toBe(abort);
    expect(calls).toBe(1);
  });

  it('stops waiting when cancelled', async () => {
    const controller = new AbortController();
    const waiting = withGeminiRetry(() => Promise.reject(rateLimited('10s')), {
      signal: controller.signal,
      random: () => 0,
    });
    setTimeout(() => controller.abort(), 20);
    await expect(waiting).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('takes a slot from the pacer before every attempt', async () => {
    const events: string[] = [];
    const pacer = { acquire: () => Promise.resolve(void events.push('slot')) } as unknown as GeminiPacer;
    let calls = 0;
    await withGeminiRetry(
      () => {
        events.push('call');
        return ++calls < 2 ? Promise.reject(apiError(503)) : Promise.resolve(1);
      },
      { ...noSleep, pacer },
    );
    expect(events).toEqual(['slot', 'call', 'slot', 'call']);
  });
});

describe('GeminiPacer', () => {
  const clock = () => {
    const state = { t: 0, slept: [] as number[] };
    return {
      state,
      options: {
        now: () => state.t,
        sleep: (ms: number) => {
          state.slept.push(ms);
          state.t += ms;
          return Promise.resolve();
        },
      },
    };
  };

  it('lets maxPerMinute requests through at once and holds the next until the oldest is a minute old', async () => {
    const { state, options } = clock();
    const pacer = new GeminiPacer({ maxPerMinute: 3, ...options });
    for (let i = 0; i < 3; i += 1) await pacer.acquire();
    expect(state.slept).toEqual([]);
    state.t = 10_000;
    await pacer.acquire(); // the first of the three was sent at 0: wait until 60 000
    expect(state.slept).toEqual([50_000]);
    expect(state.t).toBe(60_000);
  });

  it('serves callers in the order they asked', async () => {
    const { options } = clock();
    const pacer = new GeminiPacer({ maxPerMinute: 1, ...options });
    const order: number[] = [];
    await Promise.all([1, 2, 3].map((n) => pacer.acquire().then(() => order.push(n))));
    expect(order).toEqual([1, 2, 3]);
  });

  it('is switched off by a limit of 0', async () => {
    const { state, options } = clock();
    const pacer = new GeminiPacer({ maxPerMinute: 0, ...options });
    for (let i = 0; i < 50; i += 1) await pacer.acquire();
    expect(state.slept).toEqual([]);
  });

  it('stops waiting when cancelled', async () => {
    const pacer = new GeminiPacer({ maxPerMinute: 1 });
    await pacer.acquire();
    const controller = new AbortController();
    const waiting = pacer.acquire(controller.signal);
    setTimeout(() => controller.abort(), 20);
    await expect(waiting).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('is one per process, with the limit of the latest caller', () => {
    const first = getGeminiPacer({ geminiMaxRpm: 5 });
    expect(getGeminiPacer({ geminiMaxRpm: 7 })).toBe(first);
  });
});

describe('the budget of requests per minute is one for the whole process', () => {
  const clock = () => {
    const state = { t: 1_000_000 };
    return { state, now: () => state.t };
  };

  it('is drawn on by every pacer that shares the window: two threads cannot send more than the limit between them', () => {
    const { state, now } = clock();
    const buffer = createPacerBuffer();
    const main = new GeminiPacer({ maxPerMinute: 10, shared: buffer, now });
    const worker = new GeminiPacer({ maxPerMinute: 10, shared: buffer, now });
    for (let i = 0; i < 6; i += 1) expect(main.tryAcquire()).toBe(0);
    state.t += 1000;
    for (let i = 0; i < 4; i += 1) expect(worker.tryAcquire()).toBe(0);
    // ten sent in all: neither may send another until the first six are a minute old
    expect(main.tryAcquire()).toBe(59_000);
    expect(worker.tryAcquire()).toBe(59_000);
    state.t += 58_999;
    expect(worker.tryAcquire()).toBe(1);
    state.t += 1;
    // the six of the main thread are a minute old; the four of the worker are not, and they count for the main thread too
    for (let i = 0; i < 6; i += 1) expect(worker.tryAcquire()).toBe(0);
    expect(main.tryAcquire()).toBeGreaterThan(0);
  });

  it('keeps a window of its own when it is not given one', () => {
    const { now } = clock();
    const a = new GeminiPacer({ maxPerMinute: 2, now });
    const b = new GeminiPacer({ maxPerMinute: 2, now });
    expect([a.tryAcquire(), a.tryAcquire(), a.tryAcquire() > 0]).toEqual([0, 0, true]);
    expect(b.tryAcquire()).toBe(0);
  });

  it('shares the limit too: the latest caller sets it for everybody, and a limit of 0 switches pacing off for all', () => {
    const { now } = clock();
    const buffer = createPacerBuffer();
    const a = new GeminiPacer({ maxPerMinute: 1, shared: buffer, now });
    const b = new GeminiPacer({ maxPerMinute: 1, shared: buffer, now });
    expect(a.tryAcquire()).toBe(0);
    expect(b.tryAcquire()).toBeGreaterThan(0);
    a.setMaxPerMinute(3);
    expect(b.tryAcquire()).toBe(0);
    expect(b.tryAcquire()).toBe(0);
    expect(b.tryAcquire()).toBeGreaterThan(0);
    a.setMaxPerMinute(0);
    expect(b.tryAcquire()).toBe(0);
  });

  it('answers at once, never spinning, when the lock is held; takes it over only after the same holder has sat on it for a while', async () => {
    const { now } = clock();
    const buffer = createPacerBuffer();
    const lockWord = new Int32Array(buffer, 0, 1);
    const pacer = new GeminiPacer({ maxPerMinute: 5, shared: buffer, now, staleLockMs: 40 });
    lockWord[0] = 777; // held by a thread that is gone
    const started = performance.now();
    for (let i = 0; i < 20; i += 1) expect(pacer.tryAcquire()).toBe(1); // busy: "come back in a millisecond"
    expect(performance.now() - started).toBeLessThan(35); // twenty answers, none of them a wait for the lock
    expect(lockWord[0]).toBe(777); // not taken over yet: the holder may be slow
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(pacer.tryAcquire()).toBe(1); // this call takes it over ...
    expect(lockWord[0]).toBe(0);
    expect(pacer.tryAcquire()).toBe(0); // ... and the next takes a slot
    expect(lockWord[0]).toBe(0); // released with its own token
  });

  it('never releases a lock that somebody else has taken since: the token is the proof of ownership', () => {
    const { now } = clock();
    const buffer = createPacerBuffer();
    const pacer = new GeminiPacer({ maxPerMinute: 5, shared: buffer, now });
    expect(pacer.tryAcquire()).toBe(0);
    const lockWord = new Int32Array(buffer, 0, 1);
    expect(lockWord[0]).toBe(0);
    // a lock that another holder took while this thread was paused inside its critical section stays
    const unlock = (pacer as unknown as { unlock(token: number): void }).unlock.bind(pacer);
    lockWord[0] = 31337;
    unlock(1);
    expect(lockWord[0]).toBe(31337);
  });

  it('waits for the lock without blocking the thread: acquire() from a main thread whose lock holder was terminated stays responsive', async () => {
    const buffer = createPacerBuffer();
    const holder = new Worker(new URL('./ocr-doubles/pacer-hold-worker.mjs', import.meta.url), {
      workerData: { buffer },
    });
    await new Promise((resolve, reject) => {
      holder.once('message', resolve);
      holder.once('error', reject);
    });
    await holder.terminate(); // inside the critical section: the lock is left held for good
    expect(new Int32Array(buffer, 0, 1)[0]).toBe(424242);
    const pacer = new GeminiPacer({ maxPerMinute: 10, shared: buffer, staleLockMs: 120 });
    // a timer that ticks every 5 ms: if acquire() spun, it would stop ticking
    let last = performance.now();
    let longest = 0;
    const ticker = setInterval(() => {
      const at = performance.now();
      longest = Math.max(longest, at - last);
      last = at;
    }, 5);
    const started = performance.now();
    await pacer.acquire(); // takes the slot after the holder is found stale
    clearInterval(ticker);
    const took = performance.now() - started;
    expect(took).toBeGreaterThanOrEqual(100); // it did wait out the stale time, asynchronously ...
    expect(took).toBeLessThan(1500);
    expect(longest).toBeLessThan(60); // ... and the event loop kept ticking
  }, 15_000);

  it('lets only one of several threads take over a stale lock: no two are ever inside at once, the limit is exact', async () => {
    const buffer = createPacerBuffer();
    new Int32Array(buffer, 0, 1)[0] = 555; // a lock left behind
    const entry = new URL('./ocr-doubles/pacer-race-worker.mjs', import.meta.url);
    const threads = [0, 1, 2, 3, 4, 5].map(() => {
      const thread = new Worker(entry, {
        workerData: { buffer, max: 40, forMs: 600, staleLockMs: 30 },
        execArgv: ['--conditions=source'],
      });
      const done = new Promise<number>((resolve, reject) => {
        thread.on('message', (message: unknown) => {
          if (typeof message === 'number') resolve(message);
        });
        thread.once('error', reject);
      });
      const ready = new Promise<void>((resolve) => {
        thread.once('message', () => resolve());
      });
      return { thread, done, ready };
    });
    await Promise.all(threads.map((entryThread) => entryThread.ready));
    for (const { thread } of threads) thread.postMessage('go');
    const grants = await Promise.all(threads.map((entryThread) => entryThread.done));
    expect(grants.reduce((sum, count) => sum + count, 0)).toBe(40); // exactly the limit: nobody got in twice
  }, 30_000);

  it('refuses a buffer that is not a pacer window', () => {
    expect(() => new GeminiPacer({ maxPerMinute: 1, shared: new SharedArrayBuffer(8) })).toThrow();
  });

  it('is shared between real threads: the main thread and two worker threads at 10 a minute get ten between them, not thirty', async () => {
    const buffer = createPacerBuffer();
    const main = new GeminiPacer({ maxPerMinute: 10, shared: buffer });
    let granted = 0;
    for (let i = 0; i < 3; i += 1) if (main.tryAcquire() === 0) granted += 1;
    const entry = new URL('./ocr-doubles/pacer-worker.mjs', import.meta.url);
    const grants = await Promise.all(
      [0, 1].map(
        () =>
          new Promise<number>((resolve, reject) => {
            const thread = new Worker(entry, {
              workerData: { buffer, max: 10, tries: 500 },
              execArgv: ['--conditions=source'],
            });
            thread.once('message', (count: number) => resolve(count));
            thread.once('error', reject);
          }),
      ),
    );
    expect(granted).toBe(3);
    expect(granted + grants[0]! + grants[1]!).toBe(10);
  }, 30_000);
});

describe('an answer with no candidate, and the errors that waiting does not mend', () => {
  it('is a flake worth another request: retried, and unavailable if it stays', async () => {
    expect(isRetryableGeminiError(new GeminiEmptyResponseError())).toBe(true);
    expect(mapGeminiError(new GeminiEmptyResponseError())).toMatchObject({ code: 'LLM_UNAVAILABLE' });
    let calls = 0;
    const value = await withGeminiRetry(
      () => (++calls < 3 ? Promise.reject(new GeminiEmptyResponseError()) : Promise.resolve('answered')),
      noSleep,
    );
    expect([value, calls]).toEqual(['answered', 3]);
  });

  it('does not call a rejected key (401, 403) or an unknown model (404) retryable, although they are LLM_UNAVAILABLE', () => {
    for (const status of [401, 403, 404]) {
      expect(classifyGeminiError(apiError(status))).toMatchObject({ retryable: false, status });
      expect(mapGeminiError(apiError(status)).code).toBe('LLM_UNAVAILABLE');
      // the verdict is the same for the AppError made of it
      expect(classifyGeminiError(mapGeminiError(apiError(status))).retryable).toBe(false);
    }
    expect(classifyGeminiError(apiError(503)).retryable).toBe(true);
    expect(classifyGeminiError(new TypeError('fetch failed')).retryable).toBe(true);
    expect(classifyGeminiError(new GeminiEmptyResponseError()).retryable).toBe(true);
  });
});

describe('geminiText', () => {
  const response = (candidate: object, extra: object = {}): GenerateContentResponse =>
    ({ candidates: [candidate], ...extra }) as unknown as GenerateContentResponse;

  it('joins the text parts of the first candidate and leaves the thoughts out', () => {
    const text = geminiText(
      response({
        content: { parts: [{ text: 'thinking...', thought: true }, { text: 'Hello ' }, { text: 'world' }] },
        finishReason: 'STOP',
      }),
    );
    expect(text).toEqual({ text: 'Hello world', truncated: false, stoppedEarly: false });
  });

  it('says when the answer was cut off by the token limit, or by a filter after some text', () => {
    expect(
      geminiText(response({ content: { parts: [{ text: 'abc' }] }, finishReason: 'MAX_TOKENS' })).truncated,
    ).toBe(true);
    const early = geminiText(response({ content: { parts: [{ text: 'abc' }] }, finishReason: 'SAFETY' }));
    expect(early).toMatchObject({ text: 'abc', stoppedEarly: true });
  });

  it('raises GeminiBlockedError for a blocked prompt and for an answer a filter emptied', () => {
    expect(() => geminiText(response({}, { promptFeedback: { blockReason: 'PROHIBITED_CONTENT' } }))).toThrow(
      GeminiBlockedError,
    );
    expect(() => geminiText(response({ finishReason: 'SAFETY' }))).toThrow(GeminiBlockedError);
    expect(() =>
      geminiText(response({ content: { parts: [{ text: ' ' }] }, finishReason: 'RECITATION' })),
    ).toThrow(GeminiBlockedError);
  });

  it('raises LLM_FAILED when there is no candidate at all', () => {
    expect(() => geminiText({} as GenerateContentResponse)).toThrow(AppError);
  });
});

describe('the client', () => {
  it('needs a key, says so without naming one, and is one per key', () => {
    expect(hasGeminiKey({ geminiApiKey: null })).toBe(false);
    expect(hasGeminiKey({ geminiApiKey: 'k' })).toBe(true);
    expect(() => getGeminiClient({ geminiApiKey: null })).toThrow(
      expect.objectContaining({ code: 'LLM_UNAVAILABLE' }) as Error,
    );
    const a = getGeminiClient({ geminiApiKey: 'test-key-a-not-real' });
    expect(getGeminiClient({ geminiApiKey: 'test-key-a-not-real' })).toBe(a);
    expect(getGeminiClient({ geminiApiKey: 'test-key-b-not-real' })).not.toBe(a);
    expect(typeof a.models.generateContent).toBe('function');
  });

  it('keeps ApiError the way the SDK builds it', () => {
    const error = new ApiError({ status: 429, message: '{"error":{"code":429}}' });
    expect(error.name).toBe('ApiError');
    expect(error.status).toBe(429);
  });
});
