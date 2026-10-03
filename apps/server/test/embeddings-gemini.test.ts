import { ApiError, type EmbedContentParameters, type EmbedContentResponse } from '@google/genai';
import { describe, expect, it } from 'vitest';
import {
  GEMINI_EMBEDDING_MAX_INPUT_TOKENS,
  GeminiEmbeddings,
  passageText,
  queryText,
  type GeminiEmbedClientLike,
} from '../src/embeddings/gemini.js';
import { createEmbeddingProvider } from '../src/embeddings/index.js';
import { EmbeddingError } from '../src/embeddings/provider.js';
import { GeminiPacer } from '../src/gemini/index.js';
import { testConfig } from './helpers.js';

/*
 * gemini-embedding-2 through a stand-in for the SDK client. The stand-in embeds like the real service in the two ways
 * that matter here: one vector per Content, and ONE aggregated vector when it is handed a plain string array or one
 * Content with several parts (the documented gotcha).
 */

const KEY = 'AIzaSy-embedding-key-do-not-leak';
const DIMENSIONS = 8;

/** A short vector that is NOT of length 1 (the real service shortens, so the provider must normalise). */
const vectorOf = (seed: number): number[] => Array.from({ length: DIMENSIONS }, (_, index) => seed + index);

class FakeEmbedClient implements GeminiEmbedClientLike {
  readonly requests: EmbedContentParameters[] = [];

  constructor(private readonly failures: Error[] = []) {}

  readonly models = {
    embedContent: (params: EmbedContentParameters): Promise<EmbedContentResponse> => {
      this.requests.push(params);
      const failure = this.failures.shift();
      if (failure !== undefined) return Promise.reject(failure);
      const contents = params.contents;
      // The gotcha: a string, a string array, or Content(s) whose parts are not one-per-Content: ONE vector.
      const perContent =
        Array.isArray(contents) &&
        contents.every((content) => typeof content === 'object' && 'parts' in content);
      const count = perContent ? (contents as unknown[]).length : 1;
      return Promise.resolve({
        embeddings: Array.from({ length: count }, (_, index) => ({ values: vectorOf(index + 1) })),
      } as EmbedContentResponse);
    },
  };
}

const apiError = (status: number, body: object): ApiError =>
  new ApiError({ status, message: JSON.stringify({ error: { code: status, ...body } }) });

const fast = { sleep: () => Promise.resolve(), random: () => 0.5 };
const unpaced = new GeminiPacer({ maxPerMinute: 0 });

function embeddings(
  client: GeminiEmbedClientLike,
  options: { batchSize?: number; pacer?: GeminiPacer } = {},
): GeminiEmbeddings {
  return new GeminiEmbeddings({
    apiKey: KEY,
    model: 'gemini-embedding-2',
    dimensions: DIMENSIONS,
    batchSize: options.batchSize ?? 16,
    client,
    retry: fast,
    pacer: options.pacer ?? unpaced,
  });
}

describe('GeminiEmbeddings: the request', () => {
  it('sends every text as its OWN Content, so one vector comes back per text (a string array would give one in all)', async () => {
    const client = new FakeEmbedClient();
    const vectors = await embeddings(client).embedPassages(['one', 'two', 'three']);
    expect(vectors).toHaveLength(3);
    const [request] = client.requests;
    expect(client.requests).toHaveLength(1);
    expect(request?.contents).toEqual([
      { parts: [{ text: 'title: none | text: one' }] },
      { parts: [{ text: 'title: none | text: two' }] },
      { parts: [{ text: 'title: none | text: three' }] },
    ]);
    // never plain strings, and never several parts in one Content
    for (const content of request?.contents as { parts: unknown[] }[]) {
      expect(typeof content).toBe('object');
      expect(content.parts).toHaveLength(1);
    }
  });

  it('uses no taskType (gemini-embedding-2 has none) and asks for the configured number of dimensions', async () => {
    const client = new FakeEmbedClient();
    await embeddings(client).embedPassages(['a']);
    await embeddings(client).embedQuery('a');
    for (const request of client.requests) {
      expect(request.model).toBe('gemini-embedding-2');
      expect(request.config?.outputDimensionality).toBe(DIMENSIONS);
      expect(request.config).not.toHaveProperty('taskType');
    }
  });

  it('writes the documented prefixes: title and text for a passage, task and query for a question', async () => {
    const client = new FakeEmbedClient();
    const model = embeddings(client);
    await model.embedPassages(['The market opens on Thursdays.', 'Second.'], undefined, {
      titles: ['Chapter 1: Trade', null],
    });
    await model.embedQuery('When does the market open?');
    expect(client.requests[0]?.contents).toEqual([
      { parts: [{ text: 'title: Chapter 1: Trade | text: The market opens on Thursdays.' }] },
      { parts: [{ text: 'title: none | text: Second.' }] },
    ]);
    expect(client.requests[1]?.contents).toEqual([
      { parts: [{ text: 'task: search result | query: When does the market open?' }] },
    ]);
    expect(passageText('x', '  A   title ')).toBe('title: A title | text: x');
    expect(passageText('x', '')).toBe('title: none | text: x');
    expect(queryText('q')).toBe('task: search result | query: q');
  });

  it('returns unit vectors, in order', async () => {
    const vectors = await embeddings(new FakeEmbedClient()).embedPassages(['a', 'b']);
    for (const vector of vectors) {
      expect(vector).toHaveLength(DIMENSIONS);
      expect(Math.hypot(...vector)).toBeCloseTo(1, 10);
    }
    expect(vectors[0]).not.toEqual(vectors[1]);
    const query = await embeddings(new FakeEmbedClient()).embedQuery('q');
    expect(Math.hypot(...query)).toBeCloseTo(1, 10);
  });

  it('splits texts into batches of at most batchSize (and never more than 100 a request)', async () => {
    const client = new FakeEmbedClient();
    const texts = Array.from({ length: 40 }, (_, index) => `chunk ${String(index)}`);
    const vectors = await embeddings(client, { batchSize: 16 }).embedPassages(texts);
    expect(vectors).toHaveLength(40);
    expect(client.requests.map((request) => (request.contents as unknown[]).length)).toEqual([16, 16, 8]);

    const big = new FakeEmbedClient();
    await embeddings(big, { batchSize: 500 }).embedPassages(Array.from({ length: 150 }, () => 'x'));
    expect(big.requests.map((request) => (request.contents as unknown[]).length)).toEqual([100, 50]);
  });

  it('is an error, never a silent shift, when the number of vectors differs from the number of texts', async () => {
    const aggregating: GeminiEmbedClientLike = {
      models: {
        embedContent: () => Promise.resolve({ embeddings: [{ values: [1, 2, 3] }] } as EmbedContentResponse),
      },
    };
    await expect(embeddings(aggregating).embedPassages(['a', 'b'])).rejects.toThrow(/1 vectors for 2 texts/u);
  });

  it('knows its window: 8,192 tokens', () => {
    expect(embeddings(new FakeEmbedClient()).maxInputTokens).toBe(GEMINI_EMBEDDING_MAX_INPUT_TOKENS);
    expect(GEMINI_EMBEDDING_MAX_INPUT_TOKENS).toBe(8192);
  });
});

describe('GeminiEmbeddings: quota and errors', () => {
  it('counts every text against the per-minute quota: each text takes a slot of the pacer', async () => {
    let now = 0;
    const slept: number[] = [];
    const pacer = new GeminiPacer({
      maxPerMinute: 4,
      now: () => now,
      sleep: (ms) => {
        slept.push(ms);
        now += ms;
        return Promise.resolve();
      },
    });
    const client = new FakeEmbedClient();
    await embeddings(client, { pacer, batchSize: 3 }).embedPassages(['a', 'b', 'c', 'd', 'e', 'f']);
    // 6 texts, 4 a minute: the fifth text has to wait for the window to move on
    expect(slept).toEqual([60_000]);
    expect(client.requests).toHaveLength(2);
  });

  it('retries a 429 and a 503, then succeeds', async () => {
    const client = new FakeEmbedClient([
      apiError(429, { status: 'RESOURCE_EXHAUSTED', message: 'slow' }),
      apiError(503, { status: 'UNAVAILABLE', message: 'busy' }),
    ]);
    expect(await embeddings(client).embedPassages(['a'])).toHaveLength(1);
    expect(client.requests).toHaveLength(3);
  });

  it('reports a used-up daily quota as a rate limit that waiting will not fix', async () => {
    const client = new FakeEmbedClient([
      apiError(429, {
        status: 'RESOURCE_EXHAUSTED',
        details: [
          {
            '@type': 'type.googleapis.com/google.rpc.QuotaFailure',
            violations: [{ quotaId: 'EmbedContentRequestsPerDayPerUserPerProjectPerModel-FreeTier' }],
          },
        ],
      }),
    ]);
    const failure = await embeddings(client)
      .embedPassages(['a'])
      .then(
        () => null,
        (error: unknown) => error,
      );
    expect(failure).toBeInstanceOf(EmbeddingError);
    const error = failure as EmbeddingError;
    expect(error.rateLimited).toBe(true);
    expect(error.dailyQuota).toBe(true);
    expect(error.retryable).toBe(false);
    expect(error.message).toContain('daily quota reached');
    expect(client.requests).toHaveLength(1);
  });

  it('marks a service that is only busy as retryable, and never puts the key in a message', async () => {
    const client = new FakeEmbedClient(
      Array.from({ length: 4 }, () => apiError(503, { status: 'UNAVAILABLE', message: `down ${KEY}` })),
    );
    const failure = (await embeddings(client)
      .embedPassages(['a'])
      .then(
        () => null,
        (error: unknown) => error,
      )) as EmbeddingError;
    expect(failure).toBeInstanceOf(EmbeddingError);
    expect(failure.retryable).toBe(true);
    expect(failure.rateLimited).toBe(false);
    expect(failure.message).not.toContain(KEY);
  });

  it('without a key (and no stand-in client) it fails with an EmbeddingError of its own', async () => {
    const keyless = new GeminiEmbeddings({
      apiKey: null,
      model: 'gemini-embedding-2',
      dimensions: DIMENSIONS,
      batchSize: 16,
    });
    await expect(keyless.embedQuery('q')).rejects.toBeInstanceOf(EmbeddingError);
  });

  it('a cancelled request is an AbortError, not an embedding failure', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(embeddings(new FakeEmbedClient()).embedQuery('q', controller.signal)).rejects.toMatchObject({
      name: 'AbortError',
    });
  });
});

describe('createEmbeddingProvider for Gemini', () => {
  it('builds gemini-embedding-2 at 768 dimensions from the defaults', () => {
    const provider = createEmbeddingProvider(testConfig({ GEMINI_API_KEY: KEY }));
    expect(provider).toBeInstanceOf(GeminiEmbeddings);
    expect(provider).toMatchObject({ name: 'gemini', model: 'gemini-embedding-2', dimensions: 768 });
  });
});
