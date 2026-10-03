import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import type * as ClientModule from '../../src/pdf/pdfClient';

/*
 * The pdf.js boundary is a test double (the real library needs a worker and a canvas): what is pinned here is HOW the
 * app opens a document, not what pdf.js does with it.
 */

const getDocument = vi.fn();
const GlobalWorkerOptions = { workerSrc: '' };

vi.mock('pdfjs-dist', () => ({
  getDocument: (...args: unknown[]) => getDocument(...args) as unknown,
  GlobalWorkerOptions,
}));
vi.mock('pdfjs-dist/build/pdf.worker.min.mjs?url', () => ({ default: '/assets/pdf.worker-abc123.mjs' }));

interface Task {
  promise: Promise<unknown>;
  destroy: Mock<() => Promise<void>>;
}

function task(result: Promise<unknown>): Task {
  return { promise: result, destroy: vi.fn(() => Promise.resolve()) };
}

let client: typeof ClientModule;

beforeEach(async () => {
  vi.resetModules();
  getDocument.mockReset();
  GlobalWorkerOptions.workerSrc = '';
  client = await import('../../src/pdf/pdfClient');
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('openPdf', () => {
  it('points pdf.js at the bundled worker of our own origin and never allows eval', async () => {
    const proxy = { numPages: 3 };
    getDocument.mockReturnValue(task(Promise.resolve(proxy)));
    await expect(client.openPdf(new ArrayBuffer(8))).resolves.toBe(proxy);
    expect(GlobalWorkerOptions.workerSrc).toBe('/assets/pdf.worker-abc123.mjs');
    const options = getDocument.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(options.isEvalSupported).toBe(false);
    expect(options.stopAtErrors).toBe(false);
    expect(options.maxImageSize).toBe(64e6);
    // the data directories are our own (the CSP's connect-src is 'self')
    for (const key of ['cMapUrl', 'standardFontDataUrl', 'wasmUrl', 'iccUrl']) {
      expect(String(options[key]), key).toMatch(/^\/pdfjs\//);
    }
    expect(options.cMapPacked).toBe(true);
  });

  it('opens from a COPY of the bytes: the caller keeps its buffer (pdf.js detaches the one it is given)', async () => {
    getDocument.mockReturnValue(task(Promise.resolve({})));
    const buffer = new Uint8Array([37, 80, 68, 70, 45]).buffer;
    await client.openPdf(buffer);
    const { data } = getDocument.mock.calls[0]?.[0] as { data: Uint8Array };
    expect(data).toBeInstanceOf(Uint8Array);
    expect(data.buffer).not.toBe(buffer);
    expect([...data]).toEqual([37, 80, 68, 70, 45]);
    expect(buffer.byteLength).toBe(5); // untouched
  });

  it('does not copy bytes the caller owns (a fresh File.arrayBuffer) when told so', async () => {
    getDocument.mockReturnValue(task(Promise.resolve({})));
    const buffer = new Uint8Array([1, 2, 3]).buffer;
    await client.openPdf(buffer, { copy: false });
    const { data } = getDocument.mock.calls[0]?.[0] as { data: Uint8Array };
    expect(data.buffer).toBe(buffer);
  });

  it('opens a URL by its href, with no bytes', async () => {
    getDocument.mockReturnValue(task(Promise.resolve({})));
    await client.openPdf(new URL('http://localhost/api/documents/abc/file'));
    const options = getDocument.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(options.url).toBe('http://localhost/api/documents/abc/file');
    expect(options.data).toBeUndefined();
    // one streamed GET: a range request per chunk would each count against the server's reads of the stored file
    expect(options.disableRange).toBe(true);
    expect(options.disableAutoFetch).toBe(true);
  });

  it('is cancellable: aborting destroys the loading task and rejects with an AbortError', async () => {
    let fail: (error: unknown) => void = () => undefined;
    const pending = task(
      new Promise((_resolve, reject) => {
        fail = reject;
      }),
    );
    pending.destroy.mockImplementation(() => {
      fail(new Error('Loading aborted'));
      return Promise.resolve();
    });
    getDocument.mockReturnValue(pending);
    const controller = new AbortController();
    const opening = client.openPdf(new ArrayBuffer(8), { signal: controller.signal });
    await vi.waitFor(() => {
      expect(getDocument).toHaveBeenCalled();
    });
    controller.abort();
    await expect(opening).rejects.toMatchObject({ name: 'AbortError' });
    expect(pending.destroy).toHaveBeenCalled();
  });

  it('does nothing when it is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(client.openPdf(new ArrayBuffer(8), { signal: controller.signal })).rejects.toMatchObject({
      name: 'AbortError',
    });
    expect(getDocument).not.toHaveBeenCalled();
  });

  it('destroys a document that finished loading just after the abort, rather than returning it', async () => {
    let finish: (value: unknown) => void = () => undefined;
    const pending = task(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    getDocument.mockReturnValue(pending);
    const controller = new AbortController();
    const opening = client.openPdf(new ArrayBuffer(8), { signal: controller.signal });
    await vi.waitFor(() => {
      expect(getDocument).toHaveBeenCalled();
    });
    controller.abort();
    finish({ numPages: 1 });
    await expect(opening).rejects.toMatchObject({ name: 'AbortError' });
    expect(pending.destroy).toHaveBeenCalled();
  });

  it("passes pdf.js's own errors through (a password-protected or damaged file)", async () => {
    getDocument.mockReturnValue(
      task(Promise.reject(Object.assign(new Error('No password given'), { name: 'PasswordException' }))),
    );
    await expect(client.openPdf(new ArrayBuffer(8))).rejects.toMatchObject({ name: 'PasswordException' });
  });

  it('closePdf destroys the loading task', async () => {
    const destroy = vi.fn(() => Promise.resolve());
    await client.closePdf({ loadingTask: { destroy } } as never);
    expect(destroy).toHaveBeenCalledOnce();
  });
});
