import { SessionDocumentResponseSchema } from '@enchanted/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ApiError,
  fetchApi,
  getJson,
  isAbortError,
  parseRetryAfter,
  readApiError,
} from '../../src/api/client';
import { makeDocument } from '../fixtures';

function json(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' }, ...init });
}

function stubFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    return Promise.resolve(handler(url, init));
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('getJson', () => {
  it('requests with same-origin credentials and a JSON accept header, then parses the body', async () => {
    const fetchMock = stubFetch(() => json({ document: makeDocument() }));
    const result = await getJson('/api/session/document', SessionDocumentResponseSchema);
    expect(result.document?.filename).toBe('manuscript.pdf');
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe('/api/session/document');
    expect(init).toMatchObject({
      method: 'GET',
      credentials: 'same-origin',
      headers: { Accept: 'application/json' },
    });
  });

  it('passes the abort signal on', async () => {
    const fetchMock = stubFetch(() => json({ document: null }));
    const controller = new AbortController();
    await getJson('/api/x', SessionDocumentResponseSchema, { signal: controller.signal });
    expect(fetchMock.mock.calls[0]?.[1]?.signal).toBe(controller.signal);
  });

  it('turns an ApiError body into an ApiError with the server code, message, detail and status', async () => {
    stubFetch(() =>
      json({ error: { code: 'DOCUMENT_NOT_FOUND', message: 'nope', detail: 'GET /api/x' } }, { status: 404 }),
    );
    const error = await getJson('/api/x', SessionDocumentResponseSchema).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({
      code: 'DOCUMENT_NOT_FOUND',
      message: 'nope',
      detail: 'GET /api/x',
      status: 404,
    });
  });

  it('maps a network failure to the NETWORK kind with no status', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new TypeError('Failed to fetch'))),
    );
    const error = await getJson('/api/x', SessionDocumentResponseSchema).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ code: 'NETWORK', status: null, message: 'Failed to fetch' });
  });

  it('lets an abort through unchanged', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new DOMException('The operation was aborted.', 'AbortError'))),
    );
    const error = await getJson('/api/x', SessionDocumentResponseSchema).catch((caught: unknown) => caught);
    expect(isAbortError(error)).toBe(true);
    expect(error).not.toBeInstanceOf(ApiError);
  });

  it('reports a response in an unexpected shape as INTERNAL with the first schema issue', async () => {
    stubFetch(() => json({ nope: true }));
    const error = await getJson('/api/x', SessionDocumentResponseSchema).catch((caught: unknown) => caught);
    expect(error).toMatchObject({
      code: 'INTERNAL',
      status: 200,
      message: expect.stringContaining('unexpected shape') as string,
    });
    expect((error as ApiError).detail).toBeTruthy();
  });

  it('reports a body that is not JSON as INTERNAL', async () => {
    stubFetch(() => new Response('<html>oops</html>', { status: 200 }));
    const error = await getJson('/api/x', SessionDocumentResponseSchema).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: 'INTERNAL', status: 200 });
  });
});

describe('readApiError', () => {
  it('keeps the HTTP status as the technical message for a proxy error page', async () => {
    const error = await readApiError(
      new Response('<h1>Bad gateway</h1>', { status: 502, statusText: 'Bad Gateway' }),
    );
    expect(error).toMatchObject({ code: 'INTERNAL', status: 502, message: 'HTTP 502 Bad Gateway' });
  });

  it('maps a bare 429 to RATE_LIMITED', async () => {
    const error = await readApiError(new Response('slow down', { status: 429 }));
    expect(error.code).toBe('RATE_LIMITED');
  });

  it('exposes a UiError without an undefined detail', () => {
    const error = new ApiError('NETWORK', 'Failed to fetch');
    expect(error.toUiError()).toEqual({ code: 'NETWORK', message: 'Failed to fetch' });
    expect(new ApiError('INTERNAL', 'x', 500, 'why').toUiError()).toEqual({
      code: 'INTERNAL',
      message: 'x',
      detail: 'why',
    });
  });
});

describe('fetchApi', () => {
  it('uses same-origin credentials unless told otherwise', async () => {
    const fetchMock = stubFetch(() => new Response('ok'));
    await fetchApi('/api/y', { method: 'DELETE' });
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ method: 'DELETE', credentials: 'same-origin' });
  });
});

describe('Retry-After', () => {
  it('seconds become milliseconds, a date is measured from now, nonsense is nothing, and a day is capped', () => {
    expect(parseRetryAfter('10')).toBe(10_000);
    expect(parseRetryAfter(' 0 ')).toBe(0);
    expect(parseRetryAfter(null)).toBeUndefined();
    expect(parseRetryAfter('')).toBeUndefined();
    expect(parseRetryAfter('soon')).toBeUndefined();
    const now = Date.parse('2026-10-03T10:00:00Z');
    expect(parseRetryAfter('Sat, 03 Oct 2026 10:00:30 GMT', now)).toBe(30_000);
    expect(parseRetryAfter('Sat, 03 Oct 2026 09:00:00 GMT', now)).toBe(0); // already past
    expect(parseRetryAfter('86400')).toBe(60 * 60 * 1000);
  });

  it('readApiError carries the header on the ApiError, with the server body or without one (a gateway page)', async () => {
    const withBody = await readApiError(
      json(
        {
          error: {
            code: 'RATE_LIMITED',
            message: 'busy',
            detail: 'too many documents are waiting to be read',
          },
        },
        {
          status: 429,
          headers: { 'content-type': 'application/json', 'retry-after': '10' },
        },
      ),
    );
    expect(withBody).toMatchObject({ code: 'RATE_LIMITED', status: 429, retryAfterMs: 10_000 });
    const gateway = await readApiError(
      new Response('<html>', { status: 429, headers: { 'retry-after': '3' } }),
    );
    expect(gateway).toMatchObject({ code: 'RATE_LIMITED', retryAfterMs: 3000 });
    const plain = await readApiError(json({ error: { code: 'INTERNAL', message: 'x' } }, { status: 500 }));
    expect(plain.retryAfterMs).toBeUndefined();
  });
});
