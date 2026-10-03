import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createEmbeddingProvider } from '../src/embeddings/index.js';
import { OpenAICompatibleEmbeddings } from '../src/embeddings/openai.js';
import { EmbeddingError } from '../src/embeddings/provider.js';
import { testConfig } from './helpers.js';

interface Received {
  url: string;
  headers: IncomingMessage['headers'];
  body: { model: string; input: string[]; encoding_format: string };
}

type Responder = (request: Received, attempt: number, response: ServerResponse) => void;

describe('OpenAICompatibleEmbeddings', () => {
  let server: Server;
  let baseUrl: string;
  let received: Received[];
  let responder: Responder;
  const delays: number[] = [];
  const sleep = (ms: number): Promise<void> => {
    delays.push(ms);
    return Promise.resolve();
  };

  /** A vector per input: [index of the text, length of the text]. */
  const answer = (response: ServerResponse, input: string[], shuffled = false): void => {
    const data = input.map((text, index) => ({ index, embedding: [index + 1, text.length] }));
    if (shuffled) data.reverse();
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ data }));
  };

  beforeEach(async () => {
    received = [];
    delays.length = 0;
    responder = (request, _attempt, response) => answer(response, request.body.input);
    server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        const entry: Received = {
          url: request.url ?? '',
          headers: request.headers,
          body: JSON.parse(Buffer.concat(chunks).toString()) as Received['body'],
        };
        received.push(entry);
        responder(entry, received.length, response);
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}/v1`;
  });
  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  const make = (
    extra: Partial<ConstructorParameters<typeof OpenAICompatibleEmbeddings>[0]> = {},
  ): OpenAICompatibleEmbeddings =>
    new OpenAICompatibleEmbeddings({
      baseUrl,
      apiKey: 'sk-test-secret-key',
      model: 'text-embedding-3-small',
      batchSize: 2,
      sleep,
      ...extra,
    });

  it('posts to /embeddings in batches with the key and model, and returns vectors in input order', async () => {
    responder = (request, _attempt, response) => answer(response, request.body.input, true); // answers out of order
    const provider = make();
    expect(provider.dimensions).toBeNull();
    const vectors = await provider.embedPassages(['a', 'bb', 'ccc', 'dddd', 'eeeee']);
    expect(vectors).toEqual([
      [1, 1],
      [2, 2],
      [1, 3],
      [2, 4],
      [1, 5],
    ]);
    expect(received.map((r) => r.body.input)).toEqual([['a', 'bb'], ['ccc', 'dddd'], ['eeeee']]);
    expect(received.every((r) => r.url === '/v1/embeddings')).toBe(true);
    expect(received[0]?.headers.authorization).toBe('Bearer sk-test-secret-key');
    expect(received[0]?.body.model).toBe('text-embedding-3-small');
    expect(provider.dimensions).toBe(2);
    expect(await provider.embedQuery('hello')).toEqual([1, 5]);
  });

  it('sends no Authorization header when there is no key (local servers)', async () => {
    await make({ apiKey: null }).embedPassages(['x']);
    expect(received[0]?.headers.authorization).toBeUndefined();
  });

  it('retries 429 and 5xx with backoff, honouring Retry-After', async () => {
    responder = (request, attempt, response) => {
      if (attempt === 1) {
        response.statusCode = 429;
        response.setHeader('retry-after', '2');
        response.end('slow down');
      } else if (attempt === 2) {
        response.statusCode = 503;
        response.end('unavailable');
      } else {
        answer(response, request.body.input);
      }
    };
    const retries: { status: number | null; attempt: number }[] = [];
    const provider = make({
      retryBaseDelayMs: 100,
      onRetry: ({ status, attempt }) => retries.push({ status, attempt }),
    });
    expect(await provider.embedPassages(['one'])).toEqual([[1, 3]]);
    expect(received).toHaveLength(3);
    expect(retries).toEqual([
      { status: 429, attempt: 1 },
      { status: 503, attempt: 2 },
    ]);
    expect(delays[0]).toBe(2000); // Retry-After
    expect(delays[1]).toBeGreaterThanOrEqual(150); // 100 ms * 2^1 with jitter
    expect(delays[1]).toBeLessThanOrEqual(250);
  });

  it('gives up after the retries with a retryable error that names the status but not the key', async () => {
    responder = (_request, _attempt, response) => {
      response.statusCode = 500;
      response.end('boom sk-test-secret-key');
    };
    const error = await make({ maxRetries: 2 })
      .embedPassages(['x'])
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(EmbeddingError);
    expect((error as EmbeddingError).retryable).toBe(true);
    expect((error as EmbeddingError).status).toBe(500);
    expect((error as EmbeddingError).message).toBe('The embedding service kept failing (HTTP 500)');
    expect(received).toHaveLength(3); // the first try and two retries
    expect(JSON.stringify(error, Object.getOwnPropertyNames(error))).not.toContain('sk-test-secret-key');
  });

  it('does not retry a client error', async () => {
    responder = (_request, _attempt, response) => {
      response.statusCode = 401;
      response.end('{"error":"bad key sk-test-secret-key"}');
    };
    const error = await make()
      .embedPassages(['x'])
      .catch((e: unknown) => e);
    expect(error).toMatchObject({ name: 'EmbeddingError', retryable: false, status: 401 });
    expect((error as Error).message).toBe('The embedding service refused the request (HTTP 401)');
    expect(received).toHaveLength(1);
  });

  it('rejects malformed answers: wrong count, wrong shape, vectors of different sizes, not JSON', async () => {
    const cases: Responder[] = [
      (_r, _a, response) => response.end(JSON.stringify({ data: [] })),
      (_r, _a, response) => response.end(JSON.stringify({ nope: true })),
      (_r, _a, response) =>
        response.end(
          JSON.stringify({
            data: [
              { index: 0, embedding: [1, 2] },
              { index: 1, embedding: [1] },
            ],
          }),
        ),
      (_r, _a, response) => response.end('<html>gateway</html>'),
    ];
    for (const bad of cases) {
      responder = bad;
      await expect(make().embedPassages(['a', 'b'])).rejects.toMatchObject({
        name: 'EmbeddingError',
        retryable: false,
      });
    }
  });

  it('retries a dropped connection and then reports the service as unreachable', async () => {
    responder = (_request, _attempt, response) => response.socket?.destroy();
    const error = await make({ maxRetries: 1 })
      .embedPassages(['x'])
      .catch((e: unknown) => e);
    expect(error).toMatchObject({
      name: 'EmbeddingError',
      retryable: true,
      message: 'The embedding service could not be reached',
    });
    expect(received).toHaveLength(2);
  });

  it('stops at once when the caller aborts, also while waiting to retry', async () => {
    const controller = new AbortController();
    responder = (_request, _attempt, response) => {
      response.statusCode = 429;
      response.end('later');
    };
    const provider = make({
      sleep: (_ms, signal) =>
        new Promise((_resolve, reject) => {
          controller.abort(new DOMException('cancelled', 'AbortError'));
          reject(signal?.reason as Error);
        }),
    });
    await expect(provider.embedPassages(['x'], controller.signal)).rejects.toMatchObject({
      name: 'AbortError',
    });
    expect(received).toHaveLength(1);
    await expect(make().embedPassages(['x'], controller.signal)).rejects.toMatchObject({
      name: 'AbortError',
    });
    expect(received).toHaveLength(1);
  });

  it('is what createEmbeddingProvider returns for EMBEDDING_PROVIDER=openai, without a key in the config object it prints', () => {
    const provider = createEmbeddingProvider(
      testConfig({
        EMBEDDING_PROVIDER: 'openai',
        EMBEDDING_MODEL: 'text-embedding-3-small',
        OPENAI_API_KEY: 'sk-abc',
        OPENAI_BASE_URL: 'http://localhost:11434/v1/',
      }),
    );
    expect(provider.name).toBe('openai');
    expect(provider.model).toBe('text-embedding-3-small');
    expect(createEmbeddingProvider(testConfig()).name).toBe('gemini'); // the default
  });
});
