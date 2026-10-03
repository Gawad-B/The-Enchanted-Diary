import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../src/api/client';
import {
  BUSY_WAIT_MS,
  CREATE_RETRIES,
  FILENAME_MAX_CHARS,
  MAX_CREATES_PER_TICKET,
  TICKET_REUSE_MS,
  clampFilename,
  forgetBlobOffer,
  uploadDocument,
} from '../../src/api/uploads';
import { apiError, installFetch, json } from '../helpers/network';

/*
 * Blob mode keeps the PUT and the CREATE apart. The put costs one of the store's few writes a day (and a ticket of the
 * session's hourly few); the create can be repeated. These tests pin that a create that fails for a reason that passes is
 * repeated with the SAME ticket and never costs a second write (reviewer U-I1, global hand-off #3).
 */

const SUMMARY = {
  id: '0a1b2c3d-1111-4222-8333-444455556666',
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
const ticketOf = (n: number) => ({
  mode: 'blob',
  maxBytes: 20_000_000,
  pathname: `0a1b2c3d-1111-4222-8333-44445555666${String(n)}.pdf`,
  clientPayload: `signed.ticket.${String(n)}`,
  handleUploadUrl: '/api/uploads/blob',
});
const file = (name = 'manuscript.pdf', size = 1000) =>
  new File([new Uint8Array(size)], name, { type: 'application/pdf', lastModified: 1 });

const upload = vi.fn();
vi.mock('@vercel/blob/client', () => ({ upload: (...args: unknown[]) => upload(...args) as unknown }));

const busy = () =>
  new Response(
    JSON.stringify({
      error: {
        code: 'RATE_LIMITED',
        message: 'The archive is busy.',
        detail: 'too many documents are waiting to be read',
      },
    }),
    { status: 429, headers: { 'Content-Type': 'application/json', 'Retry-After': '7' } },
  );

let waits: number[];
let clock: number;
const options = (extra: Record<string, unknown> = {}) => ({
  wait: (ms: number) => {
    waits.push(ms);
    clock += ms;
    return Promise.resolve();
  },
  now: () => clock,
  ...extra,
});

beforeEach(() => {
  upload.mockReset();
  upload.mockResolvedValue({});
  forgetBlobOffer();
  waits = [];
  clock = 1_000_000;
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Blob mode: the create is repeated with the same ticket', () => {
  it('a busy archive (429 + Retry-After) then success: ONE put, two creates, the SAME ticket, the wait the server asked for', async () => {
    let creates = 0;
    const { calls } = installFetch({
      'POST /api/uploads/ticket': () => json(200, ticketOf(1)),
      'POST /api/documents': () => (++creates === 1 ? busy() : json(202, { document: SUMMARY })),
    });
    const waiting: (number | null)[] = [];
    const document = await uploadDocument(
      file(),
      options({ onWaiting: (at: number | null) => waiting.push(at) }),
    );
    expect(document.id).toBe(SUMMARY.id);
    expect(upload).toHaveBeenCalledTimes(1); // the global write budget is spent once
    expect(calls.filter((call) => call.path === '/api/uploads/ticket')).toHaveLength(1); // and so is the ticket
    const creating = calls.filter((call) => call.path === '/api/documents');
    expect(creating).toHaveLength(2);
    expect(creating[0]?.body).toEqual(creating[1]?.body);
    expect(creating[1]?.body).toMatchObject({ ticket: 'signed.ticket.1' });
    expect(waits).toEqual([7000]); // Retry-After: 7
    expect(waiting).toEqual([clock, null]); // "the archive asks for a moment" while it waits, then gone
  });

  it('a busy archive that says nothing is waited for 10 s; one that stays busy gets 3 creates in all (2 retries), then it is told', async () => {
    let creates = 0;
    installFetch({
      'POST /api/uploads/ticket': () => json(200, ticketOf(1)),
      'POST /api/documents': () =>
        ++creates === 1
          ? json(429, {
              error: {
                code: 'RATE_LIMITED',
                message: 'busy',
                detail: 'too many documents are waiting to be read',
              },
            })
          : json(202, { document: SUMMARY }),
    });
    await uploadDocument(file(), options());
    expect(waits).toEqual([BUSY_WAIT_MS]);

    forgetBlobOffer();
    waits = [];
    creates = 0;
    const { calls } = installFetch({
      'POST /api/uploads/ticket': () => json(200, ticketOf(2)),
      'POST /api/documents': () => busy(),
    });
    await expect(uploadDocument(file('b.pdf'), options())).rejects.toMatchObject({ code: 'RATE_LIMITED' });
    // the server reads the store three times for a ticket: three creates, never more (coordinator ruling: at most 2 retries)
    expect(calls.filter((call) => call.path === '/api/documents')).toHaveLength(MAX_CREATES_PER_TICKET);
    expect(MAX_CREATES_PER_TICKET).toBe(3);
    expect(CREATE_RETRIES).toBe(2);
    expect(waits).toEqual([7000, 7000]);
    expect(upload).toHaveBeenCalledTimes(2); // one put for each of the two files, none for the retries
  });

  it('a Retry-After that is longer than the diary will wait is told to the reader at once', async () => {
    const { calls } = installFetch({
      'POST /api/uploads/ticket': () => json(200, ticketOf(1)),
      'POST /api/documents': () =>
        new Response(
          JSON.stringify({
            error: {
              code: 'RATE_LIMITED',
              message: 'busy',
              detail: 'too many documents are waiting to be read',
            },
          }),
          { status: 429, headers: { 'Content-Type': 'application/json', 'Retry-After': '900' } },
        ),
    });
    await expect(uploadDocument(file(), options())).rejects.toMatchObject({ code: 'RATE_LIMITED' });
    expect(waits).toEqual([]);
    expect(calls.filter((call) => call.path === '/api/documents')).toHaveLength(1);
  });

  it('no answer at all (the connection dropped) is repeated 1 s, then 2 s later, with the same ticket: 3 creates in all, then it says so', async () => {
    let creates = 0;
    const { calls } = installFetch({
      'POST /api/uploads/ticket': () => json(200, ticketOf(1)),
      'POST /api/documents': () => {
        creates += 1;
        return Promise.reject(new TypeError('Failed to fetch'));
      },
    });
    await expect(uploadDocument(file(), options())).rejects.toMatchObject({ code: 'NETWORK' });
    expect(waits).toEqual([1000, 2000]);
    expect(creates).toBe(CREATE_RETRIES + 1);
    expect(upload).toHaveBeenCalledTimes(1);
    const bodies = calls.filter((call) => call.path === '/api/documents').map((call) => call.body);
    expect(new Set(bodies.map((body) => JSON.stringify(body))).size).toBe(1); // the SAME ticket and pathname every time
  });

  it('a 5xx or a 504 on the create is NOT repeated (it may have read the store): the reader is told, the ticket and the blob are kept', async () => {
    for (const status of [500, 502, 503, 504]) {
      forgetBlobOffer();
      waits = [];
      const { calls } = installFetch({
        'POST /api/uploads/ticket': () => json(200, ticketOf(1)),
        'POST /api/documents': () => apiError(status, 'INTERNAL', 'Gateway'),
      });
      await expect(uploadDocument(file(), options())).rejects.toMatchObject({ status });
      expect(waits).toEqual([]);
      expect(calls.filter((call) => call.path === '/api/documents')).toHaveLength(1);
    }
  });

  it('after one failed create, the same file offered again goes straight to the create: the ticket and the blob are kept (no second write)', async () => {
    let failing = true;
    const { calls } = installFetch({
      'POST /api/uploads/ticket': () => json(200, ticketOf(1)),
      'POST /api/documents': () =>
        failing ? apiError(503, 'INTERNAL', 'Unavailable') : json(202, { document: SUMMARY }),
    });
    await expect(uploadDocument(file(), options())).rejects.toMatchObject({ status: 503 });
    failing = false;
    await expect(uploadDocument(file(), options())).resolves.toMatchObject({ id: SUMMARY.id });
    expect(upload).toHaveBeenCalledTimes(1);
    expect(calls.filter((call) => call.path === '/api/uploads/ticket')).toHaveLength(1);
  });

  it('a ticket whose three creates are used up is worn out (the server would refuse it as tried too often): the next offer gets a new ticket and a new put', async () => {
    const { calls } = installFetch({
      'POST /api/uploads/ticket': vi
        .fn()
        .mockImplementationOnce(() => json(200, ticketOf(1)))
        .mockImplementationOnce(() => json(200, ticketOf(2))),
      'POST /api/documents': vi
        .fn()
        .mockImplementationOnce(() => busy())
        .mockImplementationOnce(() => busy())
        .mockImplementationOnce(() => busy())
        .mockImplementation(() => json(202, { document: SUMMARY })),
    });
    await expect(uploadDocument(file(), options())).rejects.toMatchObject({ code: 'RATE_LIMITED' });
    await expect(uploadDocument(file(), options())).resolves.toMatchObject({ id: SUMMARY.id });
    expect(calls.filter((call) => call.path === '/api/uploads/ticket')).toHaveLength(2);
    expect(upload).toHaveBeenCalledTimes(2);
  });

  it("a different file does not borrow another file's ticket", async () => {
    installFetch({
      'POST /api/uploads/ticket': vi
        .fn()
        .mockImplementationOnce(() => json(200, ticketOf(1)))
        .mockImplementationOnce(() => json(200, ticketOf(2))),
      'POST /api/documents': () => apiError(503, 'INTERNAL', 'Unavailable'),
    });
    await expect(uploadDocument(file('a.pdf'), options())).rejects.toBeInstanceOf(ApiError);
    await expect(uploadDocument(file('b.pdf'), options())).rejects.toBeInstanceOf(ApiError);
    expect(upload).toHaveBeenCalledTimes(2);
    expect((upload.mock.calls[1] as [string])[0]).toBe(ticketOf(2).pathname);
  });

  it('S.5/S.15: the day\'s budget (429 "full for today") is a verdict, not a wait: no repeat; the ticket and the blob are KEPT for a later try', async () => {
    let full = true;
    const { calls } = installFetch({
      'POST /api/uploads/ticket': () => json(200, ticketOf(1)),
      'POST /api/documents': () =>
        full
          ? apiError(
              429,
              'RATE_LIMITED',
              'The archive is full for today.',
              'the archive has used its budget for today',
            )
          : json(202, { document: SUMMARY }),
    });
    const error = await uploadDocument(file(), options()).catch((caught: unknown) => caught);
    expect(error).toMatchObject({
      code: 'RATE_LIMITED',
      detail: 'the archive has used its budget for today',
    });
    expect(waits).toEqual([]);
    full = false; // tomorrow
    await expect(uploadDocument(file(), options())).resolves.toMatchObject({ id: SUMMARY.id });
    expect(calls.filter((call) => call.path === '/api/uploads/ticket')).toHaveLength(1); // the same ticket
    expect(upload).toHaveBeenCalledTimes(1); // and no second write
  });

  it('a verdict about the file (not a PDF) is not repeated either, and the ticket is forgotten (the server spent it)', async () => {
    const { calls } = installFetch({
      'POST /api/uploads/ticket': vi
        .fn()
        .mockImplementationOnce(() => json(200, ticketOf(1)))
        .mockImplementationOnce(() => json(200, ticketOf(2))),
      'POST /api/documents': () => apiError(400, 'FILE_NOT_PDF', 'The file is not a PDF.'),
    });
    await expect(uploadDocument(file(), options())).rejects.toMatchObject({ code: 'FILE_NOT_PDF' });
    expect(waits).toEqual([]);
    await expect(uploadDocument(file(), options())).rejects.toMatchObject({ code: 'FILE_NOT_PDF' });
    expect(calls.filter((call) => call.path === '/api/uploads/ticket')).toHaveLength(2);
  });

  it('leaving while it waits ends the wait and the upload (an abort, not an error)', async () => {
    installFetch({
      'POST /api/uploads/ticket': () => json(200, ticketOf(1)),
      'POST /api/documents': () => busy(),
    });
    const controller = new AbortController();
    const promise = uploadDocument(file(), {
      signal: controller.signal,
      wait: (_ms: number, signal: AbortSignal | undefined) =>
        new Promise<void>((resolve) => {
          signal?.addEventListener('abort', () => resolve());
          controller.abort();
        }),
    });
    await expect(promise).rejects.toMatchObject({ name: 'AbortError' });
  });
});

describe('Blob mode: a put that failed may have landed', () => {
  it('a put whose answer was lost (the SDK\'s retry was refused as "already exists") is followed by a create, which succeeds', async () => {
    upload.mockRejectedValue(new Error('Vercel Blob: This blob already exists'));
    const { calls } = installFetch({
      'POST /api/uploads/ticket': () => json(200, ticketOf(1)),
      'POST /api/documents': () => json(202, { document: SUMMARY }),
    });
    await expect(uploadDocument(file(), options())).resolves.toMatchObject({ id: SUMMARY.id });
    expect(upload).toHaveBeenCalledTimes(1);
    expect(calls.filter((call) => call.path === '/api/documents')).toHaveLength(1);
  });

  it("a put that failed while the store really has nothing: the put's failure is told, and a repeat offer puts again with the SAME ticket", async () => {
    upload.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    let created = 0;
    const { calls } = installFetch({
      'POST /api/uploads/ticket': () => json(200, ticketOf(1)),
      'POST /api/documents': () =>
        ++created === 1
          ? apiError(400, 'FILE_MISSING', 'The upload did not arrive', 'no such blob')
          : json(202, { document: SUMMARY }),
    });
    await expect(uploadDocument(file(), options())).rejects.toMatchObject({ code: 'NETWORK' });
    await expect(uploadDocument(file(), options())).resolves.toMatchObject({ id: SUMMARY.id });
    expect(upload).toHaveBeenCalledTimes(2); // the first put never landed
    expect(calls.filter((call) => call.path === '/api/uploads/ticket')).toHaveLength(1); // one ticket for both
    expect((upload.mock.calls[1] as [string])[0]).toBe(ticketOf(1).pathname);
  });

  it('a put that failed while the archive is busy: the blob is there, so the create is repeated (not the put)', async () => {
    upload.mockRejectedValue(new Error('Vercel Blob: Failed to fetch'));
    let created = 0;
    installFetch({
      'POST /api/uploads/ticket': () => json(200, ticketOf(1)),
      'POST /api/documents': () => (++created === 1 ? busy() : json(202, { document: SUMMARY })),
    });
    await expect(uploadDocument(file(), options())).resolves.toMatchObject({ id: SUMMARY.id });
    expect(upload).toHaveBeenCalledTimes(1);
    expect(created).toBe(2);
  });
});

describe('Blob mode: a ticket that is refused, used or worn out is replaced', () => {
  it('a create refused for its ticket is followed by a NEW ticket, a new put and a create', async () => {
    let created = 0;
    const { calls } = installFetch({
      'POST /api/uploads/ticket': vi
        .fn()
        .mockImplementationOnce(() => json(200, ticketOf(1)))
        .mockImplementationOnce(() => json(200, ticketOf(2))),
      'POST /api/documents': () =>
        ++created === 1
          ? apiError(
              400,
              'FILE_MISSING',
              'This upload was not started here; ask for a new upload ticket.',
              'the upload ticket is not valid for this session',
            )
          : json(202, { document: SUMMARY }),
    });
    await expect(uploadDocument(file(), options())).resolves.toMatchObject({ id: SUMMARY.id });
    expect(calls.filter((call) => call.path === '/api/uploads/ticket')).toHaveLength(2);
    expect(upload).toHaveBeenCalledTimes(2);
    const bodies = calls.filter((call) => call.path === '/api/documents').map((call) => call.body);
    expect(bodies[0]).toMatchObject({ ticket: 'signed.ticket.1' });
    expect(bodies[1]).toMatchObject({ ticket: 'signed.ticket.2' });
  });

  it("a ticket older than the server's half hour is not reused", async () => {
    installFetch({
      'POST /api/uploads/ticket': vi
        .fn()
        .mockImplementationOnce(() => json(200, ticketOf(1)))
        .mockImplementationOnce(() => json(200, ticketOf(2))),
      'POST /api/documents': vi
        .fn()
        .mockImplementationOnce(() => apiError(503, 'INTERNAL', 'Unavailable'))
        .mockImplementation(() => json(202, { document: SUMMARY })),
    });
    await expect(uploadDocument(file(), options())).rejects.toBeInstanceOf(ApiError);
    clock += TICKET_REUSE_MS + 1;
    await expect(uploadDocument(file(), options())).resolves.toMatchObject({ id: SUMMARY.id });
    expect(upload).toHaveBeenCalledTimes(2);
  });

  it('gives up after two new tickets (a loop is never the answer)', async () => {
    const { calls } = installFetch({
      'POST /api/uploads/ticket': vi.fn().mockImplementation(() => json(200, ticketOf(1))),
      'POST /api/documents': () =>
        apiError(400, 'FILE_MISSING', 'used', 'the upload ticket was used already'),
    });
    await expect(uploadDocument(file(), options())).rejects.toMatchObject({ code: 'FILE_MISSING' });
    expect(calls.filter((call) => call.path === '/api/uploads/ticket')).toHaveLength(3);
  });
});

describe('the withdrawal handle, the file name', () => {
  it("names the id the document will have once the create may have been sent (the blob's name without .pdf)", async () => {
    installFetch({
      'POST /api/uploads/ticket': () => json(200, ticketOf(1)),
      'POST /api/documents': () => json(202, { document: SUMMARY }),
    });
    const ids: string[] = [];
    await uploadDocument(file(), options({ onDocumentId: (id: string) => ids.push(id) }));
    expect(ids).toEqual([ticketOf(1).pathname.replace('.pdf', '')]);
  });

  it('clamps a name over 120 characters (the server refuses over 255 only AFTER the put), keeping the extension', async () => {
    const long = `${'ن'.repeat(300)}.pdf`;
    const clamped = clampFilename(long);
    expect(Array.from(clamped)).toHaveLength(FILENAME_MAX_CHARS);
    expect(clamped.endsWith('.pdf')).toBe(true);
    expect(clampFilename('short.pdf')).toBe('short.pdf');
    const { calls } = installFetch({
      'POST /api/uploads/ticket': () => json(200, ticketOf(1)),
      'POST /api/documents': () => json(202, { document: SUMMARY }),
    });
    await uploadDocument(file(long), options());
    const sent = (calls.find((call) => call.path === '/api/documents')?.body as { filename: string })
      .filename;
    expect(sent.length).toBeLessThanOrEqual(255);
  });
});

describe("the Blob put (the SDK's upload() with the server's handleUpload route)", () => {
  it('puts with upload(): private, a single put (never multipart), the ticket as clientPayload, the route of the ticket, real progress', async () => {
    installFetch({
      'POST /api/uploads/ticket': () => json(200, ticketOf(1)),
      'POST /api/documents': () => json(202, { document: SUMMARY }),
    });
    const progress: { loaded: number; total: number }[] = [];
    upload.mockImplementation(
      (
        _pathname: string,
        _body: File,
        opts: { onUploadProgress: (p: { loaded: number; total: number; percentage: number }) => void },
      ) => {
        opts.onUploadProgress({ loaded: 400, total: 1000, percentage: 40 });
        return Promise.resolve({});
      },
    );
    await uploadDocument(
      file(),
      options({ onProgress: (p: { loaded: number; total: number }) => progress.push(p) }),
    );
    expect(upload).toHaveBeenCalledOnce();
    const [pathname, body, opts] = upload.mock.calls[0] as [string, File, Record<string, unknown>];
    expect(pathname).toBe(ticketOf(1).pathname);
    expect(body.name).toBe('manuscript.pdf');
    expect(opts).toMatchObject({
      access: 'private',
      handleUploadUrl: '/api/uploads/blob',
      clientPayload: 'signed.ticket.1',
      multipart: false,
      contentType: 'application/pdf',
    });
    expect(progress).toEqual([{ loaded: 400, total: 1000 }]);
  });

  it("a token the server's route would not give (the ticket is spent or not this session's) means a NEW ticket, once more; nothing was put, so no create is tried", async () => {
    upload.mockRejectedValueOnce(new Error('Vercel Blob: Failed to retrieve the client token'));
    const { calls } = installFetch({
      'POST /api/uploads/ticket': vi
        .fn()
        .mockImplementationOnce(() => json(200, ticketOf(1)))
        .mockImplementationOnce(() => json(200, ticketOf(2))),
      'POST /api/documents': () => json(202, { document: SUMMARY }),
    });
    await expect(uploadDocument(file(), options())).resolves.toMatchObject({ id: SUMMARY.id });
    expect(calls.filter((call) => call.path === '/api/uploads/ticket')).toHaveLength(2);
    expect(calls.filter((call) => call.path === '/api/documents')).toHaveLength(1);
    expect((upload.mock.calls[1] as [string])[0]).toBe(ticketOf(2).pathname);
  });
});
