import {
  ApiError,
  BlockedReason,
  type GenerateContentParameters,
  type GenerateContentResponse,
} from '@google/genai';
import { describe, expect, it } from 'vitest';
import { GeminiPacer, getGeminiPacer, mapGeminiError, parseGeminiError } from '../src/gemini/index.js';
import { GeminiLlmProvider, isGemini3OrLater, thinkingVariants } from '../src/llm/gemini.js';
import { createLlmProvider } from '../src/llm/index.js';
import { LlmError, type LlmRequest } from '../src/llm/provider.js';
import { testConfig } from './helpers.js';

/*
 * The Gemini chat provider, against a stand-in for the SDK client: nothing here reaches Google. The stand-in records every
 * request (model, system instruction, thinking, temperature) and plays a script of replies and errors.
 */

const KEY = 'AIzaSy-test-key-do-not-leak-0123456789';
const REQUEST: LlmRequest = {
  system: 'You are a diary.',
  messages: [
    { role: 'user', content: 'first question' },
    { role: 'assistant', content: 'first answer' },
    { role: 'user', content: 'second question' },
  ],
  maxTokens: 300,
  temperature: 0.2,
};

type Step = GenerateContentResponse[] | Error;

const chunk = (text: string, extra: Partial<GenerateContentResponse> = {}): GenerateContentResponse =>
  ({ candidates: [{ content: { parts: [{ text }] } }], ...extra }) as unknown as GenerateContentResponse;

class FakeClient {
  readonly requests: GenerateContentParameters[] = [];
  private index = 0;

  constructor(private readonly script: Step[]) {}

  readonly models = {
    generateContentStream: (
      params: GenerateContentParameters,
    ): Promise<AsyncIterable<GenerateContentResponse>> => {
      this.requests.push(params);
      const step = this.script[Math.min(this.index, this.script.length - 1)];
      this.index += 1;
      if (step === undefined || step instanceof Error) return Promise.reject(step ?? new Error('no script'));
      return Promise.resolve(
        (async function* () {
          await Promise.resolve();
          for (const part of step) yield part;
        })(),
      );
    },
  };
}

const apiError = (status: number, body: object): ApiError =>
  new ApiError({ status, message: JSON.stringify({ error: { code: status, ...body } }) });

const fast = { sleep: () => Promise.resolve(), random: () => 0.5 };

function provider(
  client: FakeClient,
  options: { model?: string; auxModel?: string; pacer?: GeminiPacer } = {},
): GeminiLlmProvider {
  return new GeminiLlmProvider({
    apiKey: KEY,
    model: options.model ?? 'gemini-3.5-flash-lite',
    auxModel: options.auxModel ?? 'gemini-3.1-flash-lite',
    client,
    retry: fast,
    ...(options.pacer === undefined ? {} : { pacer: options.pacer }),
  });
}

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

describe('GeminiLlmProvider: the request', () => {
  it('streams the text of every chunk, with the system prompt as the system instruction and model turns for the diary', async () => {
    const client = new FakeClient([[chunk('Hello'), chunk(', world')]]);
    expect(await collect(provider(client).stream(REQUEST))).toBe('Hello, world');
    const [request] = client.requests;
    expect(request?.model).toBe('gemini-3.5-flash-lite');
    expect(request?.config?.systemInstruction).toBe('You are a diary.');
    expect(request?.config?.maxOutputTokens).toBe(300);
    expect(request?.contents).toEqual([
      { role: 'user', parts: [{ text: 'first question' }] },
      { role: 'model', parts: [{ text: 'first answer' }] },
      { role: 'user', parts: [{ text: 'second question' }] },
    ]);
  });

  it('uses the auxiliary model for the small calls, and the answer model when none is configured', async () => {
    const client = new FakeClient([[chunk('yes')]]);
    await collect(provider(client).stream({ ...REQUEST, tier: 'auxiliary' }));
    await collect(provider(client).stream({ ...REQUEST, tier: 'primary' }));
    await collect(provider(client, { auxModel: '' }).stream({ ...REQUEST, tier: 'auxiliary' }));
    expect(client.requests.map((request) => request.model)).toEqual([
      'gemini-3.1-flash-lite',
      'gemini-3.5-flash-lite',
      'gemini-3.5-flash-lite',
    ]);
  });

  it('keeps thinking minimal and leaves the temperature of a Gemini 3 model alone', async () => {
    const client = new FakeClient([[chunk('ok')]]);
    await collect(provider(client).stream(REQUEST));
    const config = client.requests[0]?.config;
    expect(config?.thinkingConfig).toEqual({ thinkingLevel: 'MINIMAL' });
    expect(config).not.toHaveProperty('temperature');
  });

  it('sends the temperature and a zero thinking budget to a Gemini 2.x model', async () => {
    const client = new FakeClient([[chunk('ok')]]);
    await collect(provider(client, { model: 'gemini-2.5-flash' }).stream(REQUEST));
    const config = client.requests[0]?.config;
    expect(config?.thinkingConfig).toEqual({ thinkingBudget: 0 });
    expect(config?.temperature).toBe(0.2);
  });

  it('knows which models are Gemini 3 or later (the -latest aliases point at them)', () => {
    expect(isGemini3OrLater('gemini-3.5-flash-lite')).toBe(true);
    expect(isGemini3OrLater('gemini-3.8-flash')).toBe(true);
    expect(isGemini3OrLater('gemini-flash-latest')).toBe(true);
    expect(isGemini3OrLater('gemini-2.5-flash')).toBe(false);
    expect(thinkingVariants('gemini-2.5-flash')).toEqual([{ thinkingBudget: 0 }, undefined]);
  });

  it('asks again with a lower thinking setting when the model refuses one (3.8 Flash has no minimal), and in the end with none', async () => {
    const refusal = apiError(400, {
      status: 'INVALID_ARGUMENT',
      message: 'Thinking level MINIMAL is not supported',
    });
    const client = new FakeClient([refusal, refusal, [chunk('fine')]]);
    expect(await collect(provider(client, { model: 'gemini-3.8-flash' }).stream(REQUEST))).toBe('fine');
    expect(client.requests.map((request) => request.config?.thinkingConfig)).toEqual([
      { thinkingLevel: 'MINIMAL' },
      { thinkingLevel: 'LOW' },
      undefined,
    ]);
  });

  it('is configured with a key (or an injected client), and refuses to stream without either', async () => {
    expect(new GeminiLlmProvider({ apiKey: null, model: 'm', auxModel: '' }).isConfigured()).toBe(false);
    const failure = await failureOf(
      new GeminiLlmProvider({ apiKey: null, model: 'm', auxModel: '' }).stream(REQUEST),
    );
    expect((failure as LlmError).code).toBe('LLM_UNAVAILABLE');
  });
});

describe('GeminiLlmProvider: replies that are not text', () => {
  it('ignores thought parts', async () => {
    const thought = {
      candidates: [{ content: { parts: [{ text: 'secret thinking', thought: true }, { text: 'answer' }] } }],
    };
    const client = new FakeClient([[thought as unknown as GenerateContentResponse]]);
    expect(await collect(provider(client).stream(REQUEST))).toBe('answer');
  });

  it('turns a blocked prompt into LLM_FAILED with one of our own sentences', async () => {
    const client = new FakeClient([
      [{ promptFeedback: { blockReason: BlockedReason.PROHIBITED_CONTENT } } as GenerateContentResponse],
    ]);
    const failure = (await failureOf(provider(client).stream(REQUEST))) as LlmError;
    expect(failure).toBeInstanceOf(LlmError);
    expect(failure.code).toBe('LLM_FAILED');
    expect(failure.message).not.toContain('PROHIBITED_CONTENT');
  });

  it('turns a reply a safety filter stopped before any text into LLM_FAILED, but keeps text that was already sent', async () => {
    const stopped = { candidates: [{ finishReason: 'SAFETY' }] } as unknown as GenerateContentResponse;
    const empty = new FakeClient([[stopped]]);
    expect(((await failureOf(provider(empty).stream(REQUEST))) as LlmError).code).toBe('LLM_FAILED');

    const partial = new FakeClient([[chunk('Some of it'), stopped]]);
    expect(await collect(provider(partial).stream(REQUEST))).toBe('Some of it');
  });
});

describe('GeminiLlmProvider: quota, retries and errors', () => {
  it('retries a 429 and a 503 with backoff, then streams', async () => {
    const client = new FakeClient([
      apiError(429, { status: 'RESOURCE_EXHAUSTED', message: 'slow down' }),
      apiError(503, { status: 'UNAVAILABLE', message: 'busy' }),
      [chunk('there')],
    ]);
    expect(await collect(provider(client).stream(REQUEST))).toBe('there');
    expect(client.requests).toHaveLength(3);
  });

  it('waits the delay a 429 names (RetryInfo) instead of its own backoff', async () => {
    const waits: number[] = [];
    const client = new FakeClient([
      apiError(429, {
        status: 'RESOURCE_EXHAUSTED',
        details: [{ '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '7s' }],
      }),
      [chunk('ok')],
    ]);
    const patient = new GeminiLlmProvider({
      apiKey: KEY,
      model: 'gemini-3.5-flash-lite',
      auxModel: '',
      client,
      retry: {
        sleep: (ms) => {
          waits.push(ms);
          return Promise.resolve();
        },
        random: () => 0,
      },
    });
    expect(await collect(patient.stream(REQUEST))).toBe('ok');
    expect(waits).toEqual([7000]);
  });

  it('answers a used-up DAILY quota with RATE_LIMITED and the detail "daily quota reached", without retrying', async () => {
    const client = new FakeClient([
      apiError(429, {
        status: 'RESOURCE_EXHAUSTED',
        message: 'You exceeded your current quota',
        details: [
          {
            '@type': 'type.googleapis.com/google.rpc.QuotaFailure',
            violations: [{ quotaId: 'GenerateRequestsPerDayPerProjectPerModel-FreeTier' }],
          },
        ],
      }),
    ]);
    const failure = (await failureOf(provider(client).stream(REQUEST))) as LlmError;
    expect(failure.code).toBe('RATE_LIMITED');
    expect(failure.detail).toBe('daily quota reached');
    expect(client.requests).toHaveLength(1);
  });

  it('gives up on a 429 that keeps coming, as RATE_LIMITED', async () => {
    const client = new FakeClient([apiError(429, { status: 'RESOURCE_EXHAUSTED', message: 'slow down' })]);
    const failure = (await failureOf(provider(client).stream(REQUEST))) as LlmError;
    expect(failure.code).toBe('RATE_LIMITED');
    expect(client.requests).toHaveLength(4);
  });

  it('maps a bad key, an unknown model and an outage to LLM_UNAVAILABLE and never echoes the key or the raw body', async () => {
    for (const [status, body] of [
      [403, { status: 'PERMISSION_DENIED', message: `API key not valid: ${KEY}` }],
      [404, { status: 'NOT_FOUND', message: `models/${KEY} is not found` }],
    ] as const) {
      const client = new FakeClient([apiError(status, body)]);
      const failure = (await failureOf(provider(client).stream(REQUEST))) as LlmError;
      expect(failure.code).toBe('LLM_UNAVAILABLE');
      expect(failure.message).not.toContain(KEY);
      expect(failure.detail ?? '').not.toContain(KEY);
    }
    const down = new FakeClient([new TypeError('fetch failed')]);
    expect(((await failureOf(provider(down).stream(REQUEST))) as LlmError).code).toBe('LLM_UNAVAILABLE');
  });

  it('maps a malformed request to LLM_FAILED without retrying it', async () => {
    const client = new FakeClient([apiError(400, { status: 'INVALID_ARGUMENT', message: 'bad field' })]);
    const failure = (await failureOf(provider(client).stream(REQUEST))) as LlmError;
    expect(failure.code).toBe('LLM_FAILED');
    expect(client.requests).toHaveLength(1);
  });

  it('does not retry once text has been delivered: a failure mid-stream is an error', async () => {
    const client = {
      requests: 0,
      models: {
        generateContentStream: (): Promise<AsyncIterable<GenerateContentResponse>> => {
          client.requests += 1;
          return Promise.resolve(
            (async function* () {
              await Promise.resolve();
              yield chunk('half');
              throw apiError(503, { status: 'UNAVAILABLE', message: 'gone' });
            })(),
          );
        },
      },
    };
    const mid = new GeminiLlmProvider({ apiKey: KEY, model: 'm', auxModel: '', client, retry: fast });
    const received: string[] = [];
    let failure: unknown;
    try {
      for await (const piece of mid.stream(REQUEST)) received.push(piece);
    } catch (error) {
      failure = error;
    }
    expect(received).toEqual(['half']);
    expect((failure as LlmError).code).toBe('LLM_UNAVAILABLE');
    expect(client.requests).toBe(1);
  });
});

describe('GeminiLlmProvider: cancellation and pacing', () => {
  it('rejects with an AbortError when the request is aborted, and does not retry', async () => {
    const controller = new AbortController();
    const client = new FakeClient([apiError(503, { status: 'UNAVAILABLE', message: 'busy' })]);
    controller.abort();
    const failure = await failureOf(provider(client).stream({ ...REQUEST, signal: controller.signal }));
    expect((failure as Error).name).toBe('AbortError');
    expect(client.requests.length).toBeLessThanOrEqual(1);
  });

  it('waits for the pacer before every attempt', async () => {
    let now = 0;
    const slept: number[] = [];
    const pacer = new GeminiPacer({
      maxPerMinute: 2,
      now: () => now,
      sleep: (ms) => {
        slept.push(ms);
        now += ms;
        return Promise.resolve();
      },
    });
    const client = new FakeClient([[chunk('a')]]);
    const paced = provider(client, { pacer });
    for (let call = 0; call < 3; call += 1) await collect(paced.stream(REQUEST));
    // two requests fit in the window; the third waits for the first to age out
    expect(slept).toEqual([60_000]);
    expect(client.requests).toHaveLength(3);
  });
});

describe('createLlmProvider for Gemini', () => {
  it('builds the Gemini provider from the configuration', () => {
    const config = testConfig({ GEMINI_API_KEY: KEY });
    const llm = createLlmProvider(config);
    expect(llm).toBeInstanceOf(GeminiLlmProvider);
    expect(llm).toMatchObject({ name: 'gemini', model: 'gemini-3.5-flash-lite' });
    expect(llm.isConfigured()).toBe(true);
  });
});

// --- fix round 2 ---------------------------------------------------------------------------------------------------------

/**
 * A 429 as the SDK builds it for a STREAMING call: the service answers with content-type text/event-stream, so the SDK wraps the
 * body once more and the quota facts sit in the message of the outer layer, as a string (review NB-5; recorded live).
 */
const streamingError = (inner: object, status = 429): ApiError =>
  new ApiError({
    status,
    message: JSON.stringify({
      error: {
        message: JSON.stringify({ error: inner }, null, 2),
        code: status,
        status: 'Too Many Requests',
      },
    }),
  });

const DAILY_INNER = {
  code: 429,
  message:
    'You exceeded your current quota, please check your plan and billing details. Please retry in 25382.1s.',
  status: 'RESOURCE_EXHAUSTED',
  details: [
    {
      '@type': 'type.googleapis.com/google.rpc.QuotaFailure',
      violations: [
        {
          quotaMetric: 'generativelanguage.googleapis.com/generate_content_free_tier_requests',
          quotaId: 'GenerateRequestsPerDayPerProjectPerModel-FreeTier',
          quotaValue: '500',
        },
      ],
    },
    { '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '25382s' },
  ],
};

describe('a streaming 429 keeps its quota facts (NB-5)', () => {
  it('reads the daily quota of a wrapped body: one request, RATE_LIMITED, "daily quota reached"', async () => {
    const client = new FakeClient([streamingError(DAILY_INNER)]);
    const failure = (await failureOf(provider(client).stream(REQUEST))) as LlmError;
    expect(failure.code).toBe('RATE_LIMITED');
    expect(failure.detail).toBe('daily quota reached');
    expect(client.requests).toHaveLength(1);
    expect(parseGeminiError(streamingError(DAILY_INNER))).toMatchObject({
      status: 429,
      apiStatus: 'RESOURCE_EXHAUSTED',
      dailyQuota: true,
      retryDelayMs: 25_382_000,
    });
  });

  it('honours the RetryInfo of a wrapped per-minute 429 instead of its own backoff', async () => {
    const waits: number[] = [];
    const client = new FakeClient([
      streamingError({
        code: 429,
        message: 'Resource has been exhausted (e.g. check quota).',
        status: 'RESOURCE_EXHAUSTED',
        details: [{ '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '7s' }],
      }),
      [chunk('ok')],
    ]);
    const patient = new GeminiLlmProvider({
      apiKey: KEY,
      model: 'gemini-3.5-flash-lite',
      auxModel: '',
      client,
      retry: {
        sleep: (ms) => {
          waits.push(ms);
          return Promise.resolve();
        },
        random: () => 0,
      },
    });
    expect(await collect(patient.stream(REQUEST))).toBe('ok');
    expect(waits).toEqual([7000]);
  });

  it('reads a wrapped zero quota, a "got status" message and a "retry in" sentence of the inner message', () => {
    const noQuota = streamingError({
      code: 429,
      message: 'Quota exceeded for metric: generate_content_free_tier_requests, limit: 0',
      status: 'RESOURCE_EXHAUSTED',
    });
    expect(parseGeminiError(noQuota)).toMatchObject({ noQuota: true, dailyQuota: false });
    expect(mapGeminiError(noQuota).detail).toBe(
      'this model has no quota on your Gemini plan \u2014 pick another model',
    );
    const got = new ApiError({
      status: 429,
      message: `got status: 429 Too Many Requests. ${JSON.stringify({ error: DAILY_INNER })}`,
    });
    expect(parseGeminiError(got)).toMatchObject({ dailyQuota: true, apiStatus: 'RESOURCE_EXHAUSTED' });
    const sentence = streamingError({
      code: 429,
      message: 'Please retry in 1.5s.',
      status: 'RESOURCE_EXHAUSTED',
    });
    expect(parseGeminiError(sentence).retryDelayMs).toBe(1500);
  });

  it('reads an inner body that is a JSON array (m-7), and the daily quota in it', () => {
    const inner = JSON.stringify([{ error: DAILY_INNER }]);
    const wrapped = new ApiError({
      status: 429,
      message: JSON.stringify({ error: { message: inner, code: 429, status: 'Too Many Requests' } }),
    });
    expect(parseGeminiError(wrapped)).toMatchObject({
      apiStatus: 'RESOURCE_EXHAUSTED',
      dailyQuota: true,
      retryDelayMs: 25_382_000,
    });
    expect(mapGeminiError(wrapped).detail).toBe('daily quota reached');
  });

  it('still reads the plain (non-streaming) shape, and a body that is not JSON at all', () => {
    expect(
      parseGeminiError(apiError(429, { status: 'RESOURCE_EXHAUSTED', details: DAILY_INNER.details }))
        .dailyQuota,
    ).toBe(true);
    expect(parseGeminiError(new ApiError({ status: 503, message: 'upstream connect error' }))).toMatchObject({
      status: 503,
      apiStatus: null,
      dailyQuota: false,
    });
  });
});

describe('a small call has one deadline, and its backoff is inside it (NB-12)', () => {
  it('gives up at the deadline in the middle of a backoff, instead of re-arming it for every attempt', async () => {
    const client = new FakeClient([apiError(503, { status: 'UNAVAILABLE', message: 'busy' })]);
    const slow = new GeminiLlmProvider({
      apiKey: KEY,
      model: 'gemini-3.5-flash-lite',
      auxModel: 'gemini-3.1-flash-lite',
      client,
      retry: { baseDelayMs: 200, random: () => 0.5 },
    });
    const started = Date.now();
    const failure = (await failureOf(
      slow.stream({ ...REQUEST, tier: 'auxiliary', timeoutMs: 300 }),
    )) as LlmError;
    const elapsed = Date.now() - started;
    expect(failure).toMatchObject({ code: 'LLM_UNAVAILABLE', detail: 'timeout' });
    // attempt 1 at 0 ms, attempt 2 at 200 ms, and the deadline (300 ms) ends the wait before the third: it used to take 600 ms and 3 requests
    expect(client.requests).toHaveLength(2);
    expect(elapsed).toBeLessThan(500);
  });
});

describe('the OCR window and the answer window are one when the model is one (NB-13)', () => {
  it('draws on the process-wide default window when the answer model is the OCR model, and on its own otherwise', async () => {
    const model = 'gemini-test-shared-quota';
    const client = new FakeClient([[chunk('ok')]]);
    const shared = new GeminiLlmProvider({
      apiKey: KEY,
      model,
      auxModel: '',
      client,
      maxRpm: 1,
      ocrModel: model,
    });
    await collect(shared.stream(REQUEST));
    // the one slot of the minute of the default window (OCR's) is taken
    expect(getGeminiPacer({ geminiMaxRpm: 1 }).tryAcquire()).toBeGreaterThan(0);
    // another model has a window of its own, which this call did not touch
    expect(getGeminiPacer({ geminiMaxRpm: 1 }, 'gemini-test-other-model').tryAcquire()).toBe(0);
  });
});

describe('stopping early stops the request (NB-15)', () => {
  it('aborts the HTTP request when the consumer stops reading before the end', async () => {
    const client = new FakeClient([[chunk('Yes'), chunk(', the excerpts contain it'), chunk(' and more')]]);
    for await (const piece of provider(client).stream({ ...REQUEST, tier: 'auxiliary' })) {
      expect(piece).not.toBe('');
      break; // "the first word is all that is read"
    }
    expect(client.requests[0]?.config?.abortSignal?.aborted).toBe(true);
  });

  it('does not abort a reply that was read to the end (nothing is left to cancel)', async () => {
    const client = new FakeClient([[chunk('ok')]]);
    await collect(provider(client).stream(REQUEST));
    expect(client.requests[0]?.config?.abortSignal?.aborted).toBe(false);
  });
});

describe('how a Gemini reply ended: the leftovers (NB-16)', () => {
  const finishOf = async (reason: string | undefined, extra: Partial<GenerateContentResponse> = {}) => {
    const ends: { reason: string | null; truncated: boolean }[] = [];
    const client = new FakeClient([
      [
        {
          candidates: [
            {
              content: { parts: [{ text: 'half an ans' }] },
              ...(reason === undefined ? {} : { finishReason: reason }),
            },
          ],
          ...extra,
        } as unknown as GenerateContentResponse,
      ],
    ]);
    await collect(provider(client).stream({ ...REQUEST, onFinish: (info) => ends.push(info) }));
    return ends[0];
  };

  it('counts CONTINUATION as cut off, like MAX_TOKENS', async () => {
    expect(await finishOf('CONTINUATION')).toEqual({ reason: 'CONTINUATION', truncated: true });
    expect(await finishOf('MAX_TOKENS')).toEqual({ reason: 'MAX_TOKENS', truncated: true });
    expect(await finishOf('STOP')).toEqual({ reason: 'STOP', truncated: false });
  });

  it('does not take an unspecified block reason for a block, in the stream or in a whole response', async () => {
    const ends = await finishOf('STOP', {
      promptFeedback: { blockReason: BlockedReason.BLOCKED_REASON_UNSPECIFIED },
    });
    expect(ends).toEqual({ reason: 'STOP', truncated: false });
  });
});
