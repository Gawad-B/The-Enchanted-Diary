import type { PDFDocumentProxy } from 'pdfjs-dist';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../src/api/client';
import { createPageSourceRegistry, type PageTextureSource } from '../../src/book/pageSource';
import type { PageImageRenderer } from '../../src/pdf/pageImageService';
import { PdfPageSource } from '../../src/pdf/PdfPageSource';
import { startPdfBook, type PdfBookDeps } from '../../src/pdf/pdfBook';
import { createDocumentStore } from '../../src/state/documentStore';
import { createExperienceStore, initialExperienceState, type Phase } from '../../src/state/experience';
import { createReaderStore } from '../../src/state/readerStore';
import { DOCUMENT_ID, makeDocument } from '../fixtures';
import { settle } from './helpers';

const parchment: PageTextureSource = {
  id: 'parchment',
  getTexture: () => null,
  isReady: () => true,
  request: () => undefined,
  subscribe: () => () => undefined,
  dispose: () => undefined,
};

interface Harness {
  documents: ReturnType<typeof createDocumentStore>;
  experience: ReturnType<typeof createExperienceStore>;
  reader: ReturnType<typeof createReaderStore>;
  registry: ReturnType<typeof createPageSourceRegistry>;
  open: ReturnType<typeof vi.fn>;
  fetchStored: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  setDocument: ReturnType<typeof vi.fn>;
  stop(): void;
}

function fileOf(bytes: number[]): File {
  const buffer = new Uint8Array(bytes).buffer;
  return { name: 'm.pdf', arrayBuffer: () => Promise.resolve(buffer) } as unknown as File;
}

function setup(phase: Phase, overrides: Partial<PdfBookDeps> = {}): Harness {
  const documents = createDocumentStore();
  const experience = createExperienceStore({ ...initialExperienceState, phase, sessionChecked: true });
  const reader = createReaderStore();
  const registry = createPageSourceRegistry();
  registry.set(parchment);
  const open = vi.fn(() => Promise.resolve({ numPages: 5 } as unknown as PDFDocumentProxy));
  const fetchStored = vi.fn((_url: string) => Promise.resolve(new Uint8Array([37, 80, 68, 70]).buffer));
  const close = vi.fn(() => Promise.resolve());
  const setDocument = vi.fn();
  const renderer: PageImageRenderer = {
    enqueue: () => ({
      promise: new Promise(() => undefined),
      setPriority: () => undefined,
      cancel: () => undefined,
    }),
  };
  const stop = startPdfBook({
    documents,
    experience,
    reader,
    registry,
    parchment: { current: () => parchment, subscribe: () => () => undefined },
    service: { ...renderer, setDocument },
    settings: { getState: () => ({ resolvedQuality: 'medium' }) as never, subscribe: () => () => undefined },
    open,
    fetchStored,
    close,
    limits: () => ({ width: 1200, cache: 10 }),
    ...overrides,
  });
  return { documents, experience, reader, registry, open, fetchStored, close, setDocument, stop };
}

let harness: Harness;
afterEach(() => {
  harness.stop();
  vi.restoreAllMocks();
});

describe('startPdfBook: when the document becomes the book', () => {
  it('opens ONE document from a copy of the bytes of the file the reader offered, and switches the book to the PDF source', async () => {
    harness = setup('unveiling');
    const file = fileOf([37, 80, 68, 70]);
    harness.documents.getState().setFile(file);
    harness.documents.getState().setDocument(makeDocument({ pageCount: 8 }));
    await settle();
    expect(harness.open).toHaveBeenCalledOnce();
    const [bytes] = harness.open.mock.calls[0] as [ArrayBuffer];
    expect(bytes).toBeInstanceOf(ArrayBuffer);
    expect([...new Uint8Array(bytes)]).toEqual([37, 80, 68, 70]);
    const source = harness.registry.get();
    expect(source).toBeInstanceOf(PdfPageSource);
    expect(harness.documents.getState().pdf).toEqual({ numPages: 5 });
    expect(harness.setDocument).toHaveBeenCalledWith({ numPages: 5 });
    // later changes to the document object do not open it again
    harness.documents.getState().setDocument(makeDocument({ pageCount: 8, chunkCount: 99 }));
    await settle();
    expect(harness.open).toHaveBeenCalledOnce();
  });

  it('does not open a restored document until the reader opens the diary (the stored file is a counted read)', async () => {
    harness = setup('discovery');
    harness.documents.getState().setFile(null, null);
    harness.documents.getState().setDocument(makeDocument());
    await settle();
    expect(harness.open).not.toHaveBeenCalled();
    expect(harness.registry.get()).toBe(parchment);
    harness.experience.setState({ phase: 'unveiling', epoch: 1 });
    await settle();
    expect(harness.open).toHaveBeenCalledOnce();
    // the stored file is read ONCE through the API layer, and pdf.js gets the bytes (not a URL to read for itself)
    expect(harness.fetchStored).toHaveBeenCalledExactlyOnceWith(`/api/documents/${DOCUMENT_ID}/file`);
    const [bytes] = harness.open.mock.calls[0] as [ArrayBuffer];
    expect([...new Uint8Array(bytes)]).toEqual([37, 80, 68, 70]);
  });

  it('opens the file URL the document store holds after a restore', async () => {
    harness = setup('manuscript');
    harness.documents.getState().setFile(null, '/api/documents/zzz/file');
    harness.documents.getState().setDocument(makeDocument());
    await settle();
    expect(harness.fetchStored).toHaveBeenCalledExactlyOnceWith('/api/documents/zzz/file');
  });

  it('falls back to the stored file when the local one cannot be read', async () => {
    harness = setup('unveiling');
    harness.documents
      .getState()
      .setFile({ arrayBuffer: () => Promise.reject(new Error('NotReadableError')) } as unknown as File);
    harness.documents.getState().setDocument(makeDocument());
    await settle();
    expect(harness.fetchStored).toHaveBeenCalledOnce();
    expect(harness.open.mock.calls[0]?.[0]).toBeInstanceOf(ArrayBuffer);
  });

  it('opens nothing for a document that is still processing or has no pages', async () => {
    harness = setup('unveiling');
    harness.documents.getState().setDocument(makeDocument({ status: 'processing', stage: 'parsing' }));
    harness.documents.getState().setDocument(makeDocument({ pageCount: 0 }));
    await settle();
    expect(harness.open).not.toHaveBeenCalled();
  });

  it('opens the document when the phase changes to one that shows the book, not before', async () => {
    harness = setup('reading');
    harness.documents.getState().setFile(fileOf([1]));
    harness.documents.getState().setDocument(makeDocument());
    await settle();
    expect(harness.open).not.toHaveBeenCalled();
    harness.experience.setState({ phase: 'unveiling', epoch: 5 });
    await settle();
    expect(harness.open).toHaveBeenCalledOnce();
  });
});

describe('startPdfBook: when the document goes away', () => {
  it('gives the book back to the parchment, disposes the source, destroys the proxy and clears the store', async () => {
    harness = setup('manuscript');
    harness.documents.getState().setFile(fileOf([1]));
    harness.documents.getState().setDocument(makeDocument());
    await settle();
    const source = harness.registry.get() as PdfPageSource;
    const dispose = vi.spyOn(source, 'dispose');
    harness.documents.getState().reset();
    expect(harness.registry.get()).toBe(parchment);
    expect(dispose).toHaveBeenCalled();
    expect(harness.close).toHaveBeenCalledWith({ numPages: 5 });
    expect(harness.documents.getState().pdf).toBeNull();
    expect(harness.setDocument).toHaveBeenLastCalledWith(null);
  });

  it('abandons an open that is still under way, and destroys the document that arrives late', async () => {
    let finish: (pdf: PDFDocumentProxy) => void = () => undefined;
    let signal: AbortSignal | undefined;
    const open = vi.fn((_source: unknown, s: AbortSignal) => {
      signal = s;
      return new Promise<PDFDocumentProxy>((resolve) => {
        finish = resolve;
      });
    });
    harness = setup('manuscript', { open });
    harness.documents.getState().setFile(fileOf([1]));
    harness.documents.getState().setDocument(makeDocument());
    await settle();
    harness.documents.getState().setDocument(null);
    expect(signal?.aborted).toBe(true);
    finish({ numPages: 2 } as unknown as PDFDocumentProxy);
    await settle();
    expect(harness.close).toHaveBeenCalledWith({ numPages: 2 });
    expect(harness.documents.getState().pdf).toBeNull();
    expect(harness.registry.get()).toBe(parchment);
  });

  it('opens the next document when another one replaces it', async () => {
    harness = setup('manuscript');
    harness.documents.getState().setFile(fileOf([1]));
    harness.documents.getState().setDocument(makeDocument());
    await settle();
    harness.documents.getState().setDocument(makeDocument({ id: '11111111-1111-4111-8111-111111111111' }));
    await settle();
    expect(harness.open).toHaveBeenCalledTimes(2);
    expect(harness.close).toHaveBeenCalledTimes(1);
  });
});

describe('startPdfBook: when the pages cannot be shown', () => {
  it('records why, makes the faces parchment (so the unveiling does not wait) and keeps the diary', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const open = vi.fn(() =>
      Promise.reject(Object.assign(new Error('Invalid PDF structure'), { name: 'InvalidPDFException' })),
    );
    harness = setup('unveiling', { open });
    harness.documents.getState().setFile(fileOf([1]));
    harness.documents.getState().setDocument(makeDocument());
    await settle();
    expect(harness.documents.getState().pdfError?.message).toContain('Invalid PDF structure');
    expect(harness.documents.getState().pdf).toBeNull();
    const source = harness.registry.get() as PdfPageSource;
    expect(source.isReady(1)).toBe(true);
    expect(harness.experience.getState().phase).toBe('unveiling'); // not lost
    expect(warn).toHaveBeenCalled();
  });

  it('a stored file that is gone (404) means the diary lost the document', async () => {
    const open = vi.fn(() =>
      Promise.reject(Object.assign(new Error('Missing PDF'), { name: 'MissingPDFException' })),
    );
    harness = setup('unveiling', { open });
    harness.documents.getState().setFile(null, null);
    harness.documents.getState().setDocument(makeDocument());
    await settle();
    expect(harness.experience.getState().phase).toBe('closing');
    expect(harness.experience.getState().error?.code).toBe('DOCUMENT_NOT_FOUND');
  });

  it('an API error with status 404 means the same', async () => {
    const open = vi.fn(() => Promise.reject(new ApiError('DOCUMENT_NOT_FOUND', 'gone', 404)));
    harness = setup('manuscript', { open });
    harness.documents.getState().setDocument(makeDocument());
    await settle();
    expect(harness.experience.getState().phase).toBe('closing');
  });
});

describe('startPdfBook: highlights', () => {
  const rects = [{ x: 0.1, y: 0.1, w: 0.3, h: 0.04 }];

  async function withBook(): Promise<PdfPageSource> {
    harness = setup('manuscript');
    harness.documents.getState().setFile(fileOf([1]));
    harness.documents.getState().setDocument(makeDocument({ pageCount: 40 }));
    await settle();
    harness.reader.getState().setDocument(40, 'ltr');
    return harness.registry.get() as PdfPageSource;
  }

  it("passes the reader's highlight to the source and removes it when the reader clears it", async () => {
    const source = await withBook();
    const set = vi.spyOn(source, 'setHighlight');
    const clear = vi.spyOn(source, 'clearHighlight');
    harness.reader.getState().goToSpread(2);
    harness.reader.getState().setHighlight(3, rects);
    expect(set).toHaveBeenCalledWith(3, rects);
    harness.reader.getState().clearHighlight();
    expect(clear).toHaveBeenCalled();
  });

  it('clears the highlight when the reader turns away from its spread, and keeps it on the same spread', async () => {
    await withBook();
    harness.reader.getState().goToSpread(2);
    harness.reader.getState().setHighlight(3, rects); // page 3 is on spread 2
    harness.reader.getState().goToSpread(2);
    expect(harness.reader.getState().highlight).not.toBeNull();
    harness.reader.getState().goToSpread(3);
    expect(harness.reader.getState().highlight).toBeNull();
  });

  it('keeps a highlight made just before the turn that brings its page into view', async () => {
    await withBook();
    harness.reader.getState().setHighlight(7, rects); // spread 4, while the reader is on spread 0 or 1
    harness.reader.getState().goToPage(7);
    expect(harness.reader.getState().highlight?.page).toBe(7);
  });

  it('applies a highlight that exists when the source is created (the page is drawn with the glow)', async () => {
    const enqueue = vi.fn(() => ({
      promise: new Promise<never>(() => undefined),
      setPriority: () => undefined,
      cancel: () => undefined,
    }));
    harness = setup('manuscript', { service: { enqueue, setDocument: vi.fn() } });
    harness.reader.getState().setDocument(40, 'ltr');
    harness.reader.getState().setHighlight(5, rects);
    harness.documents.getState().setDocument(makeDocument({ pageCount: 40 }));
    await settle();
    (harness.registry.get() as PdfPageSource).request([5]);
    expect(enqueue).toHaveBeenCalledWith(expect.objectContaining({ page: 5, highlight: rects }));
  });
});

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

describe('startPdfBook: the stored file is fetched at most once per document per page load (section S.15)', () => {
  /** A restored session: no local file, a ready document, the book shown. */
  function restored(overrides: Partial<PdfBookDeps> = {}): void {
    harness = setup('manuscript', overrides);
    harness.documents.getState().setFile(null, null);
  }

  it('the diary shown again (the document leaves the store and comes back) reads the bytes it kept, not the server', async () => {
    restored();
    harness.documents.getState().setDocument(makeDocument());
    await settle();
    expect(harness.fetchStored).toHaveBeenCalledOnce();
    // the bytes were kept as a File in the document store (where an uploaded file is kept too)
    expect(harness.documents.getState().file).toBeInstanceOf(File);
    harness.documents.getState().setDocument(null); // the book lets go (the proxy is destroyed)
    await settle();
    harness.documents.getState().setDocument(makeDocument());
    await settle();
    expect(harness.open).toHaveBeenCalledTimes(2);
    expect(harness.fetchStored).toHaveBeenCalledOnce(); // still ONE read
    const [bytes] = harness.open.mock.calls[1] as [ArrayBuffer];
    expect([...new Uint8Array(bytes)]).toEqual([37, 80, 68, 70]);
  });

  it('a scene that is remounted (the engine started again over the same store) reuses them too', async () => {
    restored();
    harness.documents.getState().setDocument(makeDocument());
    await settle();
    const { documents, fetchStored } = harness;
    harness.stop();
    const again = vi.fn(() => Promise.resolve({ numPages: 5 } as unknown as PDFDocumentProxy));
    const stop = startPdfBook({
      documents,
      experience: createExperienceStore({
        ...initialExperienceState,
        phase: 'manuscript',
        sessionChecked: true,
      }),
      reader: createReaderStore(),
      registry: createPageSourceRegistry(),
      parchment: { current: () => parchment, subscribe: () => () => undefined },
      service: { enqueue: harness.setDocument as never, setDocument: harness.setDocument } as never,
      settings: {
        getState: () => ({ resolvedQuality: 'medium' }) as never,
        subscribe: () => () => undefined,
      },
      open: again,
      fetchStored: fetchStored as never,
      close: harness.close as never,
      limits: () => ({ width: 1200, cache: 10 }),
    });
    await settle();
    expect(again).toHaveBeenCalledOnce();
    expect(fetchStored).toHaveBeenCalledOnce();
    stop();
  });

  it('two opens that overlap share the one read in flight', async () => {
    let arrive: (bytes: ArrayBuffer) => void = () => undefined;
    const fetchStored = vi.fn(
      () =>
        new Promise<ArrayBuffer>((resolve) => {
          arrive = resolve;
        }),
    );
    restored({ fetchStored });
    harness.documents.getState().setDocument(makeDocument());
    await settle();
    harness.documents.getState().setDocument(null);
    harness.documents.getState().setDocument(makeDocument());
    await settle();
    expect(fetchStored).toHaveBeenCalledOnce();
    arrive(new Uint8Array([37, 80, 68, 70]).buffer);
    await settle();
    expect(fetchStored).toHaveBeenCalledOnce();
    expect(harness.open).toHaveBeenCalled();
  });

  it('every open gets its OWN copy of the bytes (pdf.js moves what it is given to its worker)', async () => {
    restored();
    harness.documents.getState().setDocument(makeDocument());
    await settle();
    harness.documents.getState().setDocument(null);
    await settle();
    harness.documents.getState().setDocument(makeDocument());
    await settle();
    const first = harness.open.mock.calls[0]?.[0] as ArrayBuffer;
    const second = harness.open.mock.calls[1]?.[0] as ArrayBuffer;
    expect(first).not.toBe(second);
  });

  it('a read the archive refused ("full for today", 429) is told as that, is not a lost document, and costs nothing to try again', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const full = new ApiError(
      'RATE_LIMITED',
      'The archive is full for today. Try again tomorrow.',
      429,
      'the archive has used its budget for today',
    );
    const fetchStored = vi
      .fn()
      .mockRejectedValueOnce(full)
      .mockResolvedValue(new Uint8Array([37, 80, 68, 70]).buffer);
    restored({ fetchStored });
    harness.documents.getState().setDocument(makeDocument());
    await settle();
    expect(harness.documents.getState().pdfError).toMatchObject({
      code: 'RATE_LIMITED',
      detail: 'the archive has used its budget for today',
    });
    expect(harness.experience.getState().phase).toBe('manuscript'); // the diary keeps the manuscript: it can still answer
    expect(harness.open).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalled();
    // a later open tries again (a failed read is not remembered)
    harness.documents.getState().setDocument(null);
    harness.documents.getState().setDocument(makeDocument());
    await settle();
    expect(fetchStored).toHaveBeenCalledTimes(2);
    expect(harness.open).toHaveBeenCalledOnce();
    expect(harness.documents.getState().pdfError).toBeNull();
  });

  it('a stored file that is gone (404 on the read) is a lost document', async () => {
    restored({ fetchStored: vi.fn().mockRejectedValue(new ApiError('DOCUMENT_NOT_FOUND', 'gone', 404)) });
    harness.documents.getState().setDocument(makeDocument());
    await settle();
    expect(harness.experience.getState().phase).toBe('closing');
    expect(harness.experience.getState().error?.code).toBe('DOCUMENT_NOT_FOUND');
  });

  it('a file the reader uploaded is never read back from the server at all', async () => {
    harness = setup('unveiling');
    harness.documents.getState().setFile(fileOf([37, 80, 68, 70]));
    harness.documents.getState().setDocument(makeDocument());
    await settle();
    expect(harness.fetchStored).not.toHaveBeenCalled();
  });
});
