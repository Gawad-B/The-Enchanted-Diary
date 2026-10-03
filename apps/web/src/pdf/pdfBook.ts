import type { PDFDocumentProxy } from 'pdfjs-dist';
import { spreadForPage } from '../book/bookLayout';
import { pageSourceRegistry, parchmentSourceSlot, type PageSourceRegistry } from '../book/pageSource';
import { ApiError, type UiError } from '../api/client';
import { fetchDocumentFile } from '../api/documents';
import { QUALITY_TIERS } from '../scene/quality';
import { documentStore, type DocumentStore } from '../state/documentStore';
import { experienceStore, type ExperienceStore, type Phase } from '../state/experience';
import { readerStore, type ReaderStore } from '../state/readerStore';
import { settingsStore, type SettingsStore } from '../state/settingsStore';
import { pageImageService, type PageImageRenderer, type PageImageService } from './pageImageService';
import { isAborted, releaseParchmentCache } from './pageRenderer';
import { closePdf, openPdf, preloadPdfLibrary, type PdfSource } from './pdfClient';
import type { PdfPageSource, PageSourceLimits, ParchmentLink } from './PdfPageSource';
import { renderGate, type RenderGate } from './renderGate';
import { textureAnisotropy, uploadTexture } from './textureUpload';

/*
 * The document becomes the book. When the diary holds a ready manuscript and the book is about to be shown, ONE
 * PDFDocumentProxy is opened (from a copy of the bytes of the file the reader offered, or from the stored file after a
 * restore), kept in the document store for every consumer (the book's textures, the page-jump thumbnails, the flat
 * fallback), and the registry's source is switched to a PdfPageSource over it. When the document goes away the proxy is
 * destroyed, every texture disposed, and the registry goes back to the parchment.
 *
 * A restored session opens the file only when the reader opens the diary: the stored file is a read of the server's
 * budget (a Blob store counts every open, and the global read budget is small: section S.15), and a page that is only loaded
 * and left must not spend it. And it is fetched AT MOST ONCE per document per page load: the bytes are kept (as a File in
 * the document store, which is also what the upload keeps) and every later open of the same document (the diary shown
 * again, the scene remounted, the replace confirmation cancelled) reads them from there.
 */

/** Phases in which the book shows (or is closing over) its pages. */
const SHOWING: ReadonlySet<Phase> = new Set(['unveiling', 'manuscript', 'revealing', 'memory', 'closing']);

export interface PdfBookDeps {
  documents?: Pick<DocumentStore, 'getState' | 'subscribe'>;
  experience?: Pick<ExperienceStore, 'getState' | 'subscribe'>;
  reader?: Pick<ReaderStore, 'getState' | 'subscribe'>;
  settings?: Pick<SettingsStore, 'getState' | 'subscribe'>;
  registry?: Pick<PageSourceRegistry, 'get' | 'set'>;
  parchment?: ParchmentLink;
  service?: Pick<PageImageService, 'setDocument'> & PageImageRenderer;
  open?: (source: PdfSource, signal: AbortSignal) => Promise<PDFDocumentProxy>;
  /** Fetches the stored file of a document (replaceable in tests). */
  fetchStored?: (url: string) => Promise<ArrayBuffer>;
  close?: (pdf: PDFDocumentProxy) => Promise<void>;
  limits?: () => PageSourceLimits;
  gate?: Pick<RenderGate, 'busy' | 'subscribe'>;
}

interface Active {
  id: string;
  pageCount: number;
  direction: 'ltr' | 'rtl';
  controller: AbortController;
  /** Null while the module that holds it loads (it brings three.js, which the first screen must not pay for). */
  source: PdfPageSource | null;
  pdf: PDFDocumentProxy | null;
}

/**
 * Loads the PDF engine's code (pdf.js, its worker and the page source) ahead of the document that needs it: the upload
 * calls it as soon as a file is chosen, so the first pages are not waiting for a download when the diary unveils.
 */
export function preloadPdfEngine(): void {
  void import('./PdfPageSource');
  preloadPdfLibrary();
}

function missing(error: unknown): boolean {
  if (error instanceof ApiError) return error.status === 404;
  const named = error as { name?: unknown; status?: unknown } | null;
  return named?.name === 'MissingPDFException' || named?.status === 404;
}

function toUiError(error: unknown): UiError {
  if (error instanceof ApiError) return error.toUiError();
  const message = error instanceof Error ? error.message : 'The pages could not be opened';
  const name = error instanceof Error ? error.name : '';
  return { code: 'PDF_UNREADABLE', message: name === '' ? message : `${name}: ${message}` };
}

export function startPdfBook(deps: PdfBookDeps = {}): () => void {
  const documents = deps.documents ?? documentStore;
  const experience = deps.experience ?? experienceStore;
  const reader = deps.reader ?? readerStore;
  const settings = deps.settings ?? settingsStore;
  const registry = deps.registry ?? pageSourceRegistry;
  const parchment: ParchmentLink = deps.parchment ?? {
    current: () => parchmentSourceSlot.get(),
    subscribe: (listener) => parchmentSourceSlot.subscribe(listener),
  };
  const service = deps.service ?? pageImageService;
  // The bytes of a File read by `arrayBuffer()` are already a copy of their own: pdf.js may take them.
  const open = deps.open ?? ((source, signal) => openPdf(source, { signal, copy: false }));
  const gate = deps.gate ?? renderGate;
  const close = deps.close ?? closePdf;
  const fetchStored = deps.fetchStored ?? ((url) => fetchDocumentFile(url));
  const limits =
    deps.limits ??
    ((): PageSourceLimits => {
      const spec = QUALITY_TIERS[settings.getState().resolvedQuality ?? 'medium'];
      return { width: spec.pageTextureWidth, cache: spec.pageTextureCache };
    });

  let active: Active | null = null;

  const applyHighlight = (): void => {
    if (!active?.source) return;
    const { highlight } = reader.getState();
    if (highlight) active.source.setHighlight(highlight.page, highlight.rects);
    else active.source.clearHighlight();
  };

  /** Fetches in flight, by document: two opens that overlap (the diary closed and shown again at once) share one read. */
  const fetching = new Map<string, Promise<ArrayBuffer>>();

  /**
   * The stored file's bytes: ONE read per document per page load. The bytes go into the document store as a File (the same
   * place an uploaded file is kept, so the memory is the browser's blob storage, not the script heap), and the next open
   * reads them from there. A read that failed (the archive is full for today, no connection) is not kept: the next open
   * tries again, and a refused read costs the server nothing.
   */
  async function storedBytes(id: string): Promise<ArrayBuffer> {
    const url = documents.getState().fileUrl ?? `/api/documents/${id}/file`;
    let pending = fetching.get(id);
    if (!pending) {
      pending = fetchStored(url).finally(() => {
        fetching.delete(id);
      });
      fetching.set(id, pending);
    }
    const bytes = await pending;
    const current = documents.getState();
    if (current.document?.id === id && !current.file) {
      current.setFile(
        new File([bytes], current.document.filename || 'manuscript.pdf', { type: 'application/pdf' }),
        current.fileUrl,
      );
    }
    // pdf.js takes the buffer it is given (it is moved to its worker): a reader of the shared read gets its own copy.
    return bytes.slice(0);
  }

  async function sourceBytes(id: string): Promise<PdfSource> {
    const { file } = documents.getState();
    if (file) {
      try {
        return await file.arrayBuffer();
      } catch {
        // an unreadable local file (permissions, a removed file): the stored copy will do
      }
    }
    return storedBytes(id);
  }

  async function begin(current: Active): Promise<void> {
    const { controller, id } = current;
    try {
      const [{ PdfPageSource: Source }, bytes] = await Promise.all([
        import('./PdfPageSource'),
        sourceBytes(id),
      ]);
      if (isAborted(controller.signal)) return;
      const source = new Source({
        parchment,
        renderer: service,
        pageCount: current.pageCount,
        direction: current.direction,
        limits,
        anisotropy: textureAnisotropy,
        upload: uploadTexture,
        gate,
      });
      current.source = source;
      documents.getState().setPdfError(null);
      // The book reads the pages from now on; a page that is not drawn yet is plain parchment until it is.
      registry.set(source);
      applyHighlight();
      try {
        const pdf = await open(bytes, controller.signal);
        if (isAborted(controller.signal)) {
          void close(pdf).catch(() => undefined);
          return;
        }
        current.pdf = pdf;
        documents.getState().setPdf(pdf);
        service.setDocument(pdf);
        source.setAvailability('ready');
      } catch (error) {
        if (isAborted(controller.signal)) return;
        source.setAvailability('failed');
        throw error;
      }
    } catch (error) {
      if (isAborted(controller.signal)) return;
      documents.getState().setPdfError(toUiError(error));
      if (missing(error)) {
        // The stored file is gone: the diary no longer holds this manuscript.
        experience.getState().dispatch({
          type: 'DOCUMENT_LOST',
          error: { code: 'DOCUMENT_NOT_FOUND', message: 'The stored file of this document is gone.' },
        });
      } else {
        console.warn('[pdf] the manuscript could not be opened for display', error);
      }
    }
  }

  function start(id: string, pageCount: number, direction: 'ltr' | 'rtl'): void {
    const current: Active = {
      id,
      pageCount,
      direction,
      controller: new AbortController(),
      source: null,
      pdf: null,
    };
    active = current;
    void begin(current);
  }

  function stop(): void {
    const current = active;
    if (!current) return;
    active = null;
    current.controller.abort();
    if (current.source) {
      // Back to the parchment first, so nothing reads a source that is about to be disposed.
      registry.set(parchment.current());
      current.source.dispose();
    }
    service.setDocument(null);
    releaseParchmentCache();
    documents.getState().setPdf(null);
    documents.getState().setPdfError(null);
    if (current.pdf) void close(current.pdf).catch(() => undefined);
  }

  const sync = (): void => {
    const { document } = documents.getState();
    const ready = document?.status === 'ready' && document.pageCount > 0 ? document : null;
    if (active && active.id !== ready?.id) stop();
    if (!active && ready && SHOWING.has(experience.getState().phase)) {
      start(ready.id, ready.pageCount, ready.direction);
    }
  };

  sync();
  const stopDocuments = documents.subscribe((state, previous) => {
    if (state.document !== previous.document) sync();
  });
  const stopExperience = experience.subscribe((state, previous) => {
    if (state.phase !== previous.phase) sync();
  });
  // The simple view (a lost WebGL context, a scene that failed) has no use for the textures: they are let go, and come back
  // by themselves if the immersive view returns and asks for its pages.
  const stopSettings = settings.subscribe((state, previous) => {
    if (state.forcedSimple !== null && previous.forcedSimple === null) active?.source?.release();
  });
  const stopReader = reader.subscribe((state, previous) => {
    if (state.highlight !== previous.highlight) applyHighlight();
    // A highlight belongs to the spread it was made for: turning away from it takes it off.
    if (
      state.spread !== previous.spread &&
      state.highlight &&
      spreadForPage(state.highlight.page) !== state.spread
    ) {
      state.clearHighlight();
    }
  });
  return () => {
    stopDocuments();
    stopExperience();
    stopReader();
    stopSettings();
    stop();
  };
}
