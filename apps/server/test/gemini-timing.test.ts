import {
  ApiError,
  FinishReason,
  type GenerateContentParameters,
  type GenerateContentResponse,
} from '@google/genai';
import { describe, expect, it, vi } from 'vitest';
import {
  GeminiPacer,
  NO_QUOTA_DETAIL,
  TIMEOUT_DETAIL,
  classifyGeminiError,
  curatedDetail,
  geminiPacerBuffer,
  getGeminiPacer,
  isDailyQuotaError,
  isRetryableGeminiError,
  mapGeminiError,
  monotonicMs,
  useGeminiPacerBuffer,
  withGeminiRetry,
} from '../src/gemini/index.js';
import { AppError } from '../src/http/errors.js';
import { GeminiLlmProvider } from '../src/llm/gemini.js';
import { LlmError, type LlmRequest } from '../src/llm/provider.js';

/*
 * The clocks and the queue of Gemini calls (review issues I-3, I-12, I-13 and the minor M-6): a timeout counts from the moment
 * the request is SENT, never from the wait for the pacer's slot; any waiter in the queue can leave at once; every quota
 * bucket (model) has its own window; and the chat provider times out a request that never answers or goes quiet, and reports
 * how a reply ended.
 */

const REQUEST: LlmRequest = {
  system: 'You are a diary.',
  messages: [{ role: 'user', content: 'a question' }],
  maxTokens: 100,
  temperature: 0.2,
};

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** A pacer double that makes every caller wait `delayMs` for a slot (the queue is saturated), honouring the signal. */
const saturated = (delayMs: number): GeminiPacer =>
  ({
    acquire: (signal?: AbortSignal) =>
      new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, delayMs);
        signal?.addEventListener(
          'abort',
          () => {
            clearTimeout(timer);
            reject(new DOMException('cancelled', 'AbortError'));
          },
          { once: true },
        );
      }),
  }) as unknown as GeminiPacer;

describe('withGeminiRetry: the attempt clock starts when the slot is granted', () => {
  it('does not count the wait for the slot: a call that is quick once sent succeeds behind a long queue', async () => {
    const result = await withGeminiRetry(
      async () => {
        await wait(40);
        return 'answered';
      },
      { pacer: saturated(300), attemptTimeoutMs: 150 },
    );
    expect(result).toBe('answered');
  });

  it('times a slow call out as LLM_UNAVAILABLE `timeout`, counted from the send, and does not retry it', async () => {
    let calls = 0;
    const started = Date.now();
    const failure = await withGeminiRetry(
      (signal) => {
        calls += 1;
        return new Promise<string>((_resolve, reject) => {
          signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), {
            once: true,
          });
        });
      },
      { pacer: saturated(100), attemptTimeoutMs: 120 },
    ).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(AppError);
    expect((failure as AppError).code).toBe('LLM_UNAVAILABLE');
    expect((failure as AppError).detail).toBe(TIMEOUT_DETAIL);
    expect(calls).toBe(1);
    expect(Date.now() - started).toBeGreaterThanOrEqual(200); // the queue (100) plus the attempt (120), not the attempt alone
  });

  it('still ends at once when the visitor goes away while it waits in the queue', async () => {
    const controller = new AbortController();
    const pending = withGeminiRetry(() => Promise.resolve('never'), {
      pacer: saturated(5000),
      attemptTimeoutMs: 100,
      signal: controller.signal,
    }).catch((error: unknown) => error);
    setTimeout(() => controller.abort(), 20);
    const failure = (await pending) as Error;
    expect(failure.name).toBe('AbortError');
  });
});

describe('GeminiPacer: a queue of waiters that can each leave on their own', () => {
  function clocked(maxPerMinute: number) {
    let now = 1_000_000;
    const sleepers: {
      until: number;
      wake: () => void;
      reject: (error: unknown) => void;
      signal: AbortSignal | undefined;
    }[] = [];
    const pacer = new GeminiPacer({
      maxPerMinute,
      now: () => now,
      sleep: (ms, signal) =>
        new Promise<void>((resolve, reject) => {
          if (signal?.aborted === true) {
            reject(new DOMException('cancelled', 'AbortError'));
            return;
          }
          const entry = { until: now + ms, wake: resolve, reject, signal };
          sleepers.push(entry);
          signal?.addEventListener('abort', () => reject(new DOMException('cancelled', 'AbortError')), {
            once: true,
          });
        }),
    });
    return {
      pacer,
      advance: async (ms: number) => {
        now += ms;
        for (const sleeper of sleepers.splice(0)) sleeper.wake();
        await wait(5);
      },
    };
  }

  it('lets an aborted waiter BEHIND another one leave at once, without waiting for the one in front', async () => {
    const { pacer } = clocked(1);
    await pacer.acquire(); // takes the only slot of the minute
    const front = pacer.acquire();
    const controller = new AbortController();
    const behind = pacer.acquire(controller.signal);
    const behindResult = behind.then(
      () => 'granted',
      (error: unknown) => (error as Error).name,
    );
    let frontSettled = false;
    void front.then(() => (frontSettled = true));
    await wait(5);
    expect(pacer.waiting).toBe(2);
    controller.abort();
    expect(await behindResult).toBe('AbortError');
    expect(frontSettled).toBe(false); // the waiter in front is still waiting, and the aborted one did not wait for it
    expect(pacer.waiting).toBe(1);
  });

  it('serves the next waiter when the one at the head leaves, and takes no slot for the one that left', async () => {
    const { pacer, advance } = clocked(1);
    await pacer.acquire();
    const headController = new AbortController();
    const head = pacer.acquire(headController.signal).catch((error: unknown) => (error as Error).name);
    const next = pacer.acquire();
    await wait(5);
    headController.abort();
    expect(await head).toBe('AbortError');
    let granted = false;
    void next.then(() => (granted = true));
    await advance(30_000);
    expect(granted).toBe(false); // the slot of the minute is still taken
    await advance(31_000);
    await next;
    expect(granted).toBe(true);
  });

  it('rejects at once for a signal that is already aborted', async () => {
    const { pacer } = clocked(5);
    const controller = new AbortController();
    controller.abort();
    await expect(pacer.acquire(controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(pacer.waiting).toBe(0);
  });

  it('serves waiters in the order they asked', async () => {
    const { pacer, advance } = clocked(1);
    await pacer.acquire();
    const order: string[] = [];
    const first = pacer.acquire().then(() => order.push('first'));
    const second = pacer.acquire().then(() => order.push('second'));
    await wait(5);
    await advance(61_000);
    await first;
    await advance(61_000);
    await second;
    expect(order).toEqual(['first', 'second']);
  });
});

describe('one pacer window per quota bucket', () => {
  it('gives each bucket (a model) its own window, and the same bucket the same pacer', async () => {
    const answers = getGeminiPacer({ geminiMaxRpm: 1 }, 'bucket-answer-model');
    const small = getGeminiPacer({ geminiMaxRpm: 1 }, 'bucket-small-model');
    expect(answers).not.toBe(small);
    expect(getGeminiPacer({ geminiMaxRpm: 1 }, 'bucket-answer-model')).toBe(answers);
    expect(geminiPacerBuffer('bucket-answer-model')).not.toBe(geminiPacerBuffer('bucket-small-model'));
    expect(geminiPacerBuffer('bucket-answer-model')).toBe(geminiPacerBuffer('bucket-answer-model'));
    // the answer model's window is full; the small model's is not touched
    await answers.acquire();
    expect(answers.tryAcquire()).toBeGreaterThan(0);
    expect(small.tryAcquire()).toBe(0);
  });

  it('lets a worker thread attach to the window of one bucket without touching the others', () => {
    const shared = new SharedArrayBuffer(geminiPacerBuffer('bucket-attach-a').byteLength);
    useGeminiPacerBuffer(shared, 'bucket-attach-a');
    expect(geminiPacerBuffer('bucket-attach-a')).toBe(shared);
    expect(geminiPacerBuffer('bucket-attach-b')).not.toBe(shared);
  });
});

// --- the chat provider's clocks ---------------------------------------------------------------------------------

type StreamScript = (signal: AbortSignal | undefined) => AsyncIterable<GenerateContentResponse>;

const chunkOf = (text: string, finish?: FinishReason): GenerateContentResponse =>
  ({
    candidates: [
      { content: { parts: [{ text }] }, ...(finish === undefined ? {} : { finishReason: finish }) },
    ],
  }) as unknown as GenerateContentResponse;

/** A client whose stream is played by a script that gets the abort signal the SDK was given. */
function client(script: StreamScript) {
  const requests: GenerateContentParameters[] = [];
  return {
    requests,
    models: {
      generateContentStream: (
        params: GenerateContentParameters,
      ): Promise<AsyncIterable<GenerateContentResponse>> => {
        requests.push(params);
        return Promise.resolve(script(params.config?.abortSignal));
      },
    },
  };
}

/** An iterable that never yields and ends with an AbortError when the signal aborts (a connection that hangs). */
const hanging: StreamScript = (signal) => ({
  [Symbol.asyncIterator]: () => ({
    next: () =>
      new Promise<IteratorResult<GenerateContentResponse>>((_resolve, reject) => {
        signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), {
          once: true,
        });
      }),
  }),
});

const geminiWith = (
  fake: ReturnType<typeof client>,
  extra: {
    pacer?: GeminiPacer;
    firstByteMs?: number;
    stallMs?: number;
    maxRpm?: number;
    model?: string;
    auxModel?: string;
  } = {},
): GeminiLlmProvider =>
  new GeminiLlmProvider({
    apiKey: 'k',
    model: extra.model ?? 'gemini-3.5-flash-lite',
    auxModel: extra.auxModel ?? 'gemini-3.1-flash-lite',
    client: fake,
    retry: { sleep: () => Promise.resolve(), random: () => 0.5 },
    ...(extra.pacer === undefined ? {} : { pacer: extra.pacer }),
    ...(extra.maxRpm === undefined ? {} : { maxRpm: extra.maxRpm }),
    timeouts: { firstByteMs: extra.firstByteMs ?? 5000, stallMs: extra.stallMs ?? 5000 },
  });

async function collect(stream: AsyncIterable<string>): Promise<string> {
  let text = '';
  for await (const piece of stream) text += piece;
  return text;
}

async function failureOf(stream: AsyncIterable<string>): Promise<unknown> {
  try {
    await collect(stream);
  } catch (error) {
    return error;
  }
  throw new Error('the stream did not fail');
}

describe('the chat provider times a request out from the send', () => {
  it('ends a request that never answers as LLM_UNAVAILABLE `timeout` (first-byte clock), not as the visitor leaving', async () => {
    const fake = client(hanging);
    const failure = (await failureOf(geminiWith(fake, { firstByteMs: 80 }).stream(REQUEST))) as LlmError;
    expect(failure).toBeInstanceOf(LlmError);
    expect(failure.code).toBe('LLM_UNAVAILABLE');
    expect(failure.detail).toBe('timeout');
    expect(failure.name).toBe('LlmError');
  });

  it('ends a stream that goes quiet after some text (stall clock) and keeps the text that came', async () => {
    const fake = client((signal) => ({
      async *[Symbol.asyncIterator]() {
        yield chunkOf('Hello');
        await new Promise<void>((_resolve, reject) => {
          signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), {
            once: true,
          });
        });
      },
    }));
    const received: string[] = [];
    let failure: unknown;
    try {
      for await (const piece of geminiWith(fake, { firstByteMs: 5000, stallMs: 80 }).stream(REQUEST))
        received.push(piece);
    } catch (error) {
      failure = error;
    }
    expect(received).toEqual(['Hello']);
    expect((failure as LlmError).detail).toBe('timeout');
  });

  it('does not count the wait for a pacer slot against the first-byte clock or the caller’s deadline', async () => {
    const fake = client(() => ({
      async *[Symbol.asyncIterator]() {
        await wait(20);
        yield chunkOf('yes');
      },
    }));
    const slow = geminiWith(fake, { pacer: saturated(300), firstByteMs: 150 });
    expect(await collect(slow.stream({ ...REQUEST, tier: 'auxiliary', timeoutMs: 150 }))).toBe('yes');
  });

  it('honours the caller’s deadline (`timeoutMs`) once the request is sent', async () => {
    const fake = client(hanging);
    const failure = (await failureOf(
      geminiWith(fake).stream({ ...REQUEST, tier: 'auxiliary', timeoutMs: 80 }),
    )) as LlmError;
    expect(failure.detail).toBe('timeout');
  });

  it('still ends silently (an AbortError) when it is the visitor who goes away', async () => {
    const fake = client(hanging);
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 30);
    const failure = (await failureOf(
      geminiWith(fake, { firstByteMs: 5000 }).stream({ ...REQUEST, signal: controller.signal }),
    )) as Error;
    expect(failure.name).toBe('AbortError');
  });

  it('gives every model its own pacer window: a burst of answers does not delay the small calls', async () => {
    const fake = client(() => ({
      async *[Symbol.asyncIterator]() {
        await Promise.resolve();
        yield chunkOf('ok');
      },
    }));
    const provider = geminiWith(fake, {
      maxRpm: 1,
      model: 'timing-test-answer-model',
      auxModel: 'timing-test-small-model',
    });
    await collect(provider.stream(REQUEST)); // the answer model's only slot of the minute
    const started = Date.now();
    await collect(provider.stream({ ...REQUEST, tier: 'auxiliary' })); // the small model has a slot of its own
    expect(Date.now() - started).toBeLessThan(500);
  });
});

describe('the chat provider reports how a reply ended', () => {
  const finishOf = async (chunks: GenerateContentResponse[]) => {
    const fake = client(() => ({
      async *[Symbol.asyncIterator]() {
        await Promise.resolve();
        for (const piece of chunks) yield piece;
      },
    }));
    let finish: { reason: string | null; truncated: boolean } | undefined;
    const text = await collect(
      geminiWith(fake).stream({
        ...REQUEST,
        onFinish: (info) => {
          finish = info;
        },
      }),
    );
    return { text, finish };
  };

  it('is complete when the model stops of itself', async () => {
    expect(await finishOf([chunkOf('Done [S1].', FinishReason.STOP)])).toEqual({
      text: 'Done [S1].',
      finish: { reason: 'STOP', truncated: false },
    });
  });

  it.each([
    ['the output limit', FinishReason.MAX_TOKENS],
    ['a recitation stop', FinishReason.RECITATION],
    ['a safety stop after some text', FinishReason.SAFETY],
    ['an unnamed stop', FinishReason.OTHER],
    ['a language stop', FinishReason.LANGUAGE],
  ])('marks the text of %s as truncated, and keeps what came', async (_name, reason) => {
    const result = await finishOf([chunkOf('The keeper was Morwenna [S1] and she lived in the tow', reason)]);
    expect(result.text).toBe('The keeper was Morwenna [S1] and she lived in the tow');
    expect(result.finish).toEqual({ reason, truncated: true });
  });

  it('fails with LLM_FAILED, and the reason in the cause only, when a filter stops the reply before any text', async () => {
    for (const reason of [
      FinishReason.SAFETY,
      FinishReason.RECITATION,
      FinishReason.OTHER,
      FinishReason.LANGUAGE,
    ]) {
      const fake = client(() => ({
        async *[Symbol.asyncIterator]() {
          await Promise.resolve();
          yield { candidates: [{ finishReason: reason }] } as unknown as GenerateContentResponse;
        },
      }));
      const failure = (await failureOf(geminiWith(fake).stream(REQUEST))) as LlmError;
      expect(failure.code, reason).toBe('LLM_FAILED');
      expect(failure.message).not.toContain(reason);
      expect(failure.detail).toBeUndefined();
      expect((failure.cause as Error).message).toContain(reason);
    }
  });
});

describe('only curated details reach a client', () => {
  it('keeps the curated ones and drops a status line or any provider word', async () => {
    const detailOf = async (status: number): Promise<string | undefined> => {
      const fake = {
        models: {
          generateContentStream: () =>
            Promise.reject(
              new ApiError({
                status,
                message: JSON.stringify({
                  error: { code: status, status: 'X', message: 'secret project 12345' },
                }),
              }),
            ),
        },
      };
      const failure = (await failureOf(
        geminiWith(fake as unknown as ReturnType<typeof client>).stream(REQUEST),
      )) as LlmError;
      return failure.detail;
    };
    expect(await detailOf(404)).toBe('model not found');
    expect(await detailOf(403)).toBe('the key was rejected');
    expect(await detailOf(400)).toBeUndefined(); // "status 400" stays server-side
    expect(await detailOf(503)).toBeUndefined();
  });
});

describe('a quota of zero is a configuration fault, not a rate limit', () => {
  const zeroQuota = (): ApiError =>
    new ApiError({
      status: 429,
      message: JSON.stringify({
        error: {
          code: 429,
          status: 'RESOURCE_EXHAUSTED',
          message:
            'You exceeded your current quota. Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_requests, limit: 0, model: gemini-3.8-flash',
          details: [
            {
              '@type': 'type.googleapis.com/google.rpc.QuotaFailure',
              violations: [
                {
                  quotaMetric: 'x',
                  quotaId: 'GenerateRequestsPerDayPerProjectPerModel-FreeTier',
                  quotaValue: '0',
                },
              ],
            },
            { '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '30s' },
          ],
        },
      }),
    });

  it('maps to LLM_UNAVAILABLE with the curated detail that names the fix, never RATE_LIMITED or "daily quota"', () => {
    const mapped = mapGeminiError(zeroQuota());
    expect(mapped.code).toBe('LLM_UNAVAILABLE');
    expect(mapped.detail).toBe(NO_QUOTA_DETAIL);
    expect(NO_QUOTA_DETAIL).toBe('this model has no quota on your Gemini plan — pick another model');
    expect(isDailyQuotaError(zeroQuota())).toBe(false);
    expect(curatedDetail(mapped.detail)).toBe(NO_QUOTA_DETAIL);
    expect(classifyGeminiError(zeroQuota()).retryable).toBe(false);
    expect(isRetryableGeminiError(zeroQuota())).toBe(false);
  });

  it('is found by its message alone, by its quotaValue alone, and is not mistaken for "limit: 10" or a daily quota', () => {
    const byMessage = new ApiError({
      status: 429,
      message: JSON.stringify({ error: { code: 429, message: 'Quota exceeded, limit: 0, model: m' } }),
    });
    expect(mapGeminiError(byMessage).detail).toBe(NO_QUOTA_DETAIL);
    const byValue = new ApiError({
      status: 429,
      message: JSON.stringify({
        error: { code: 429, details: [{ '@type': 'x.QuotaFailure', violations: [{ quotaValue: 0 }] }] },
      }),
    });
    expect(mapGeminiError(byValue).detail).toBe(NO_QUOTA_DETAIL);
    const ordinary = new ApiError({
      status: 429,
      message: JSON.stringify({ error: { code: 429, message: 'Quota exceeded, limit: 10, model: m' } }),
    });
    expect(mapGeminiError(ordinary).code).toBe('RATE_LIMITED');
    const daily = new ApiError({
      status: 429,
      message: JSON.stringify({
        error: {
          code: 429,
          details: [
            {
              '@type': 'x.QuotaFailure',
              violations: [{ quotaId: 'RequestsPerDay-FreeTier', quotaValue: '500' }],
            },
          ],
        },
      }),
    });
    expect(mapGeminiError(daily).detail).toBe('daily quota reached');
  });

  it('is not retried: one request, then the configuration fault', async () => {
    let calls = 0;
    const failure = await withGeminiRetry(
      () => {
        calls += 1;
        return Promise.reject(zeroQuota());
      },
      { sleep: () => Promise.resolve(), random: () => 0.5 },
    ).catch((error: unknown) => error);
    expect((failure as AppError).detail).toBe(NO_QUOTA_DETAIL);
    expect(calls).toBe(1);
  });

  it('reaches the visitor as the chat provider’s curated detail', async () => {
    const fake = { models: { generateContentStream: () => Promise.reject(zeroQuota()) } };
    const failure = (await failureOf(
      geminiWith(fake as unknown as ReturnType<typeof client>).stream(REQUEST),
    )) as LlmError;
    expect(failure.code).toBe('LLM_UNAVAILABLE');
    expect(failure.detail).toBe(NO_QUOTA_DETAIL);
  });
});

describe('the pacer’s clock does not follow the wall clock', () => {
  it('is not stalled by a backward step of Date.now: the window is measured on a monotonic clock', () => {
    const pacer = new GeminiPacer({ maxPerMinute: 1 });
    expect(pacer.tryAcquire()).toBe(0); // the only slot of the minute
    const real = Date.now();
    const spy = vi.spyOn(Date, 'now').mockReturnValue(real - 3_600_000); // the wall clock jumps an hour back
    try {
      const wait = pacer.tryAcquire();
      expect(wait).toBeGreaterThan(0);
      // with Date.now stamps this would be about an hour; the monotonic window says: at most the minute that is left
      expect(wait).toBeLessThanOrEqual(60_000);
    } finally {
      spy.mockRestore();
    }
  });

  it('is not hurried by a forward step either: a burst does not get through because the wall clock jumped', () => {
    const pacer = new GeminiPacer({ maxPerMinute: 2 });
    expect(pacer.tryAcquire()).toBe(0);
    expect(pacer.tryAcquire()).toBe(0);
    const spy = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 3_600_000);
    try {
      expect(pacer.tryAcquire()).toBeGreaterThan(0);
    } finally {
      spy.mockRestore();
    }
  });

  it('reads one clock for every thread: two pacers on one buffer agree, and `monotonicMs` only goes forward', () => {
    const buffer = new SharedArrayBuffer(geminiPacerBuffer('clock-test').byteLength);
    const main = new GeminiPacer({ maxPerMinute: 1, shared: buffer });
    const worker = new GeminiPacer({ maxPerMinute: 1, shared: buffer });
    expect(main.tryAcquire()).toBe(0);
    expect(worker.tryAcquire()).toBeGreaterThan(0); // the same window
    const first = monotonicMs();
    const second = monotonicMs();
    expect(second).toBeGreaterThanOrEqual(first);
  });

  it('still takes an injected simulated clock, which is how the windows are tested', () => {
    let now = 5_000;
    const pacer = new GeminiPacer({ maxPerMinute: 1, now: () => now });
    expect(pacer.tryAcquire()).toBe(0);
    now -= 40_000; // a simulated backward step: the injected clock is the caller's business
    expect(pacer.tryAcquire()).toBeGreaterThan(0);
    now += 100_000;
    expect(pacer.tryAcquire()).toBe(0);
  });
});
