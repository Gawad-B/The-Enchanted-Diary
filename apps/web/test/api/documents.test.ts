import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../src/api/client';
import {
  deleteDocument,
  forgetBlobOffer,
  fetchPublicConfig,
  progressDocument,
  requestUploadTicket,
  resetSession,
  tickDocument,
  uploadDocument,
  uploadViaBlob,
} from '../../src/api/documents';
import { apiError, FakeXhr, installFetch, json } from '../helpers/network';

const DOCUMENT_ID = '3b6f1f0e-8a52-4d6b-9d0c-6f1f6d0b7e11';
const SUMMARY = {
  id: DOCUMENT_ID,
  filename: 'manuscript.pdf',
  byteSize: 1000,
  pageCount: 3,
  status: 'processing',
  stage: 'queued',
  primaryLanguage: 'und',
  direction: 'ltr',
  createdAt: '2026-10-02T10:00:00.000Z',
  expiresAt: '2026-10-03T10:00:00.000Z',
};
const file = (size = 1000, name = 'manuscript.pdf') =>
  new File([new Uint8Array(size)], name, { type: 'application/pdf' });

const upload = vi.fn();
vi.mock('@vercel/blob/client', () => ({ upload: (...args: unknown[]) => upload(...args) as unknown }));

beforeEach(() => {
  FakeXhr.install();
  upload.mockReset();
  forgetBlobOffer();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('direct upload (development): multipart by XHR with real byte progress', () => {
  it('sends the file in the field "file", reports the bytes sent (never more than the file), and resolves with the 202 summary', async () => {
    installFetch({ 'POST /api/uploads/ticket': () => json(200, { mode: 'direct', maxBytes: 20_000_000 }) });
    const progress: { loaded: number; total: number }[] = [];
    const promise = uploadDocument(file(1000), { onProgress: (p) => progress.push(p) });
    await vi.waitFor(() => {
      expect(FakeXhr.instances).toHaveLength(1);
    });
    const xhr = FakeXhr.last();
    expect(xhr.method).toBe('POST');
    expect(xhr.url).toBe('/api/documents');
    const form = xhr.body as FormData;
    expect((form.get('file') as File).name).toBe('manuscript.pdf');
    xhr.progress(250, 1200); // the body is a little larger than the file
    xhr.progress(1200, 1200);
    xhr.respond(202, { document: SUMMARY });
    await expect(promise).resolves.toMatchObject({ id: DOCUMENT_ID, status: 'processing' });
    expect(progress).toEqual([
      { loaded: 250, total: 1000 },
      { loaded: 1000, total: 1000 },
    ]);
  });

  it("maps the server's error body to an ApiError with its code and detail (413 FILE_TOO_LARGE)", async () => {
    installFetch({ 'POST /api/uploads/ticket': () => json(200, { mode: 'direct', maxBytes: 20_000_000 }) });
    const promise = uploadDocument(file());
    await vi.waitFor(() => {
      expect(FakeXhr.instances).toHaveLength(1);
    });
    FakeXhr.last().respond(413, { error: { code: 'FILE_TOO_LARGE', message: 'too big', detail: 'limit' } });
    await expect(promise).rejects.toMatchObject({ code: 'FILE_TOO_LARGE', status: 413, detail: 'limit' });
  });

  it('a connection that fails is a NETWORK error', async () => {
    installFetch({ 'POST /api/uploads/ticket': () => json(200, { mode: 'direct', maxBytes: 20_000_000 }) });
    const promise = uploadDocument(file());
    await vi.waitFor(() => {
      expect(FakeXhr.instances).toHaveLength(1);
    });
    FakeXhr.last().fail();
    await expect(promise).rejects.toMatchObject({ code: 'NETWORK' });
  });

  it('aborts the XHR when the signal aborts, rejecting with an AbortError', async () => {
    installFetch({ 'POST /api/uploads/ticket': () => json(200, { mode: 'direct', maxBytes: 20_000_000 }) });
    const controller = new AbortController();
    const promise = uploadDocument(file(), { signal: controller.signal });
    await vi.waitFor(() => {
      expect(FakeXhr.instances).toHaveLength(1);
    });
    controller.abort();
    await expect(promise).rejects.toMatchObject({ name: 'AbortError' });
    expect(FakeXhr.last().aborted).toBe(true);
  });

  it('refuses a file over what the ticket allows before sending a byte', async () => {
    installFetch({ 'POST /api/uploads/ticket': () => json(200, { mode: 'direct', maxBytes: 500 }) });
    await expect(uploadDocument(file(1000))).rejects.toMatchObject({ code: 'FILE_TOO_LARGE' });
    expect(FakeXhr.instances).toHaveLength(0);
  });

  it('a 429 on the ticket (the archive is busy or the limit was reached) is RATE_LIMITED, nothing is sent', async () => {
    installFetch({
      'POST /api/uploads/ticket': () => apiError(429, 'RATE_LIMITED', 'The archive is full for today'),
    });
    await expect(uploadDocument(file())).rejects.toMatchObject({ code: 'RATE_LIMITED', status: 429 });
    expect(FakeXhr.instances).toHaveLength(0);
  });
});

describe('blob upload (production): a ticket, a private Blob put with real progress, then the document', () => {
  const ticket = {
    mode: 'blob',
    maxBytes: 20_000_000,
    pathname: '0a1b2c3d-1111-4222-8333-444455556666.pdf',
    clientPayload: 'signed.ticket.payload',
    handleUploadUrl: '/api/uploads/blob',
  } as const;

  it('calls upload() with the ticket (private, single put, its payload), then POSTs { blobPathname, filename, ticket } and resolves with the document', async () => {
    const { calls } = installFetch({
      'POST /api/uploads/ticket': () => json(200, ticket),
      'POST /api/documents': () => json(202, { document: SUMMARY }),
    });
    const progress: { loaded: number; total: number }[] = [];
    upload.mockImplementation(
      (
        _path: string,
        _body: File,
        options: { onUploadProgress: (p: { loaded: number; total: number; percentage: number }) => void },
      ) => {
        options.onUploadProgress({ loaded: 300, total: 1000, percentage: 30 });
        options.onUploadProgress({ loaded: 1000, total: 1000, percentage: 100 });
        return Promise.resolve({ pathname: ticket.pathname });
      },
    );
    const document = await uploadDocument(file(1000, 'تقرير.pdf'), { onProgress: (p) => progress.push(p) });
    expect(document.id).toBe(DOCUMENT_ID);
    expect(upload).toHaveBeenCalledOnce();
    const [pathname, body, options] = upload.mock.calls[0] as [string, File, Record<string, unknown>];
    expect(pathname).toBe(ticket.pathname);
    expect(body.name).toBe('تقرير.pdf');
    expect(options).toMatchObject({
      access: 'private',
      handleUploadUrl: '/api/uploads/blob',
      clientPayload: 'signed.ticket.payload',
      multipart: false,
    });
    expect(progress).toEqual([
      { loaded: 300, total: 1000 },
      { loaded: 1000, total: 1000 },
    ]);
    const create = calls.find((call) => call.path === '/api/documents');
    // the ticket travels with the create, exactly as the contract says
    expect(create?.body).toEqual({
      blobPathname: ticket.pathname,
      filename: 'تقرير.pdf',
      ticket: 'signed.ticket.payload',
    });
    expect(FakeXhr.instances).toHaveLength(0); // the browser did not send the file through the function
  });

  it("a failed put is a storage failure (or a network one): the create is tried ONCE (the put may have landed), then the put's own failure is the news", async () => {
    const { calls } = installFetch({
      'POST /api/uploads/ticket': () => json(200, ticket),
      'POST /api/documents': () => apiError(400, 'FILE_MISSING', 'The upload did not arrive', 'no such blob'),
    });
    upload.mockRejectedValue(new Error('Vercel Blob: Access denied'));
    await expect(uploadDocument(file())).rejects.toMatchObject({ code: 'STORAGE_FAILED' });
    expect(calls.filter((call) => call.path === '/api/documents')).toHaveLength(1);
    forgetBlobOffer();
    upload.mockRejectedValue(new TypeError('Failed to fetch'));
    await expect(uploadDocument(file())).rejects.toMatchObject({ code: 'NETWORK' });
  });

  it('cancelling aborts the put and rejects with an AbortError (the create is never made)', async () => {
    const { calls } = installFetch({ 'POST /api/uploads/ticket': () => json(200, ticket) });
    const controller = new AbortController();
    upload.mockImplementation(
      (_p: string, _b: File, options: { abortSignal: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          options.abortSignal.addEventListener('abort', () => {
            reject(new DOMException('aborted', 'AbortError'));
          });
        }),
    );
    const promise = uploadDocument(file(), { signal: controller.signal });
    await vi.waitFor(() => {
      expect(upload).toHaveBeenCalled();
    });
    controller.abort();
    await expect(promise).rejects.toMatchObject({ name: 'AbortError' });
    expect(calls.some((call) => call.path === '/api/documents')).toBe(false);
  });

  it('a ticket that was used already is answered, as the server really does, with a 400 FILE_MISSING and its detail', async () => {
    installFetch({
      'POST /api/documents': () =>
        apiError(
          400,
          'FILE_MISSING',
          'This upload ticket was used already; ask for a new upload ticket.',
          'the upload ticket was used already',
        ),
    });
    upload.mockResolvedValue({});
    const error = await uploadViaBlob(file(), ticket).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({
      code: 'FILE_MISSING',
      status: 400,
      detail: 'the upload ticket was used already',
    });
  });
});

describe('the rest of the document calls', () => {
  it('requests a ticket and parses it', async () => {
    const { calls } = installFetch({
      'POST /api/uploads/ticket': () => json(200, { mode: 'direct', maxBytes: 1234 }),
    });
    await expect(requestUploadTicket()).resolves.toEqual({ mode: 'direct', maxBytes: 1234 });
    // found in the first real run: a body-less POST that says it carries JSON is refused by the server ("Body cannot be empty")
    expect(calls[0]?.body).toBeNull();
    expect(calls[0]?.headers['content-type']).toBeUndefined();
  });

  it('a POST that carries a body says it is JSON (the create from a blob)', async () => {
    const { calls } = installFetch({ 'POST /api/documents': () => json(202, { document: SUMMARY }) });
    upload.mockResolvedValue({});
    await uploadViaBlob(file(), {
      mode: 'blob',
      maxBytes: 1000,
      pathname: '0a1b2c3d-1111-4222-8333-444455556666.pdf',
      clientPayload: 'p',
      handleUploadUrl: '/api/uploads/blob',
    });
    expect(calls[0]?.headers['content-type']).toBe('application/json');
  });

  it('tick: POSTs to the document and parses the real progress', async () => {
    const { calls } = installFetch({
      [`POST /api/documents/${DOCUMENT_ID}/tick`]: () =>
        json(200, {
          status: 'running',
          progress: { stage: 'parsing', completed: 12, total: 40, unit: 'pages' },
        }),
    });
    const answer = await tickDocument(DOCUMENT_ID);
    expect(answer.progress).toEqual({ stage: 'parsing', completed: 12, total: 40, unit: 'pages' });
    expect(calls[0]?.method).toBe('POST');
    expect(calls[0]?.headers['content-type']).toBeUndefined(); // no body, so no JSON claim
  });

  it('tick: an unreadable answer is an error, a 404 is DOCUMENT_NOT_FOUND', async () => {
    installFetch({ [`POST /api/documents/${DOCUMENT_ID}/tick`]: () => json(200, { status: 'nonsense' }) });
    await expect(tickDocument(DOCUMENT_ID)).rejects.toMatchObject({ code: 'INTERNAL' });
    installFetch({ [`POST /api/documents/${DOCUMENT_ID}/tick`]: () => apiError(404, 'DOCUMENT_NOT_FOUND') });
    await expect(tickDocument(DOCUMENT_ID)).rejects.toMatchObject({
      code: 'DOCUMENT_NOT_FOUND',
      status: 404,
    });
  });

  it('tick: a user abort stays an abort', async () => {
    installFetch({
      [`POST /api/documents/${DOCUMENT_ID}/tick`]: (call) =>
        new Promise<Response>((_resolve, reject) => {
          call.signal?.addEventListener('abort', () => {
            reject(new DOMException('aborted', 'AbortError'));
          });
        }),
    });
    const controller = new AbortController();
    const promise = tickDocument(DOCUMENT_ID, controller.signal);
    await Promise.resolve();
    controller.abort();
    await expect(promise).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('tick: a step that takes longer than the limit is a "tick again" (a NETWORK error), not an abort', async () => {
    vi.useFakeTimers();
    installFetch({
      [`POST /api/documents/${DOCUMENT_ID}/tick`]: (call) =>
        new Promise<Response>((_resolve, reject) => {
          call.signal?.addEventListener('abort', () => {
            reject(call.signal?.reason as Error);
          });
        }),
    });
    const promise = tickDocument(DOCUMENT_ID).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(311_000);
    const error = await promise;
    expect(error).toMatchObject({ code: 'NETWORK' });
    vi.useRealTimers();
  });

  it('progress: GET /documents/:id/progress only reads (a second tab, a poll) and parses like a tick', async () => {
    const { calls } = installFetch({
      [`GET /api/documents/${DOCUMENT_ID}/progress`]: () =>
        json(200, {
          status: 'running',
          progress: { stage: 'embedding', completed: 5, total: 9, unit: 'chunks' },
        }),
    });
    const answer = await progressDocument(DOCUMENT_ID);
    expect(answer.progress).toMatchObject({ stage: 'embedding', completed: 5 });
    expect(calls[0]).toMatchObject({ method: 'GET', path: `/api/documents/${DOCUMENT_ID}/progress` });
  });

  it('delete: 204 and 404 both mean gone; another status is an error', async () => {
    installFetch({ [`DELETE /api/documents/${DOCUMENT_ID}`]: () => new Response(null, { status: 204 }) });
    await expect(deleteDocument(DOCUMENT_ID)).resolves.toBeUndefined();
    installFetch({ [`DELETE /api/documents/${DOCUMENT_ID}`]: () => apiError(404, 'DOCUMENT_NOT_FOUND') });
    await expect(deleteDocument(DOCUMENT_ID)).resolves.toBeUndefined();
    installFetch({ [`DELETE /api/documents/${DOCUMENT_ID}`]: () => apiError(500, 'INTERNAL') });
    await expect(deleteDocument(DOCUMENT_ID)).rejects.toMatchObject({ code: 'INTERNAL' });
  });

  it('reset: POST /api/session/reset', async () => {
    const { calls } = installFetch({ 'POST /api/session/reset': () => new Response(null, { status: 204 }) });
    await resetSession();
    expect(calls[0]).toMatchObject({ method: 'POST', path: '/api/session/reset' });
  });

  it('config: parsed against the shared schema', async () => {
    installFetch({
      'GET /api/config': () =>
        json(200, {
          maxUploadBytes: 20971520,
          maxPages: 300,
          acceptedMimeTypes: ['application/pdf'],
          llm: { provider: 'gemini', model: 'm', available: true, profile: 'standard', freeTierNotice: true },
          embeddings: { provider: 'gemini', model: 'e' },
          ocr: { provider: 'gemini', available: true },
        }),
    });
    const config = await fetchPublicConfig();
    expect(config.llm.freeTierNotice).toBe(true);
  });
});
