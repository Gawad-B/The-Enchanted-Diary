import type { Direction, DocumentDetail, ProgressEvent } from '@enchanted/shared';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { createStore, useStore, type StoreApi } from 'zustand';
import type { UiError } from '../api/client';

/**
 * The document the diary currently holds. This store only keeps data (the PDF engine, upload and ingestion
 * effects fill it in later); behaviour does not belong here.
 */
export interface DocumentState {
  document: DocumentDetail | null;
  /** The file the reader offered (kept so the PDF can be rendered without downloading it again). */
  file: File | null;
  /** Where the PDF can be fetched when there is no local file (a restored session). */
  fileUrl: string | null;
  /** The single PDFDocumentProxy shared by every page consumer, opened once from a copy of the bytes. */
  pdf: PDFDocumentProxy | null;
  /** Why the pages cannot be shown in this browser (the diary may still hold and answer from the manuscript). */
  pdfError: UiError | null;
  /** The latest real ingestion progress event, or null. */
  ingestProgress: ProgressEvent | null;
  /**
   * The reading direction the analysis reported. Only one progress event carries it and every later event
   * replaces that one, so it is kept here until the document goes away, a new file is chosen or progress is cleared.
   */
  reportedDirection: Direction | null;
  /** Bytes sent so far while uploading, or null when no upload is running. */
  uploadProgress: { loaded: number; total: number } | null;
  /**
   * What the ingestion is doing besides working: `parked` (the daily quota of the model service is used up; it resumes at
   * `retryAt`, epoch ms) or `waiting` (the line is full or a rate limit holds it; the next tick comes at `retryAt`).
   * Null while it just runs.
   */
  ingestPause: { kind: 'parked' | 'waiting'; retryAt: number; detail?: string } | null;

  setDocument(document: DocumentDetail | null): void;
  setFile(file: File | null, fileUrl?: string | null): void;
  setPdf(pdf: PDFDocumentProxy | null): void;
  setPdfError(error: UiError | null): void;
  setIngestProgress(progress: ProgressEvent | null): void;
  setUploadProgress(progress: { loaded: number; total: number } | null): void;
  setIngestPause(pause: DocumentState['ingestPause']): void;
  reset(): void;
}

const emptyDocumentState = {
  document: null,
  file: null,
  fileUrl: null,
  pdf: null,
  pdfError: null,
  ingestProgress: null,
  reportedDirection: null,
  uploadProgress: null,
  ingestPause: null,
} satisfies Partial<DocumentState>;

export type DocumentStore = StoreApi<DocumentState>;

export function createDocumentStore(): DocumentStore {
  return createStore<DocumentState>()((set) => ({
    ...emptyDocumentState,
    setDocument: (document) => {
      // A removed document takes what was learnt about it along.
      set(document ? { document } : { document, reportedDirection: null });
    },
    setFile: (file, fileUrl = null) => {
      // A new file starts a new analysis; a restored session (no file, only a URL) keeps what it knows.
      set(file ? { file, fileUrl, reportedDirection: null } : { file, fileUrl });
    },
    setPdf: (pdf) => {
      set({ pdf });
    },
    setPdfError: (pdfError) => {
      set({ pdfError });
    },
    setIngestProgress: (ingestProgress) => {
      set((state) => ({
        ingestProgress,
        reportedDirection:
          ingestProgress === null ? null : (ingestProgress.direction ?? state.reportedDirection),
      }));
    },
    setUploadProgress: (uploadProgress) => {
      set({ uploadProgress });
    },
    setIngestPause: (ingestPause) => {
      set({ ingestPause });
    },
    reset: () => {
      set(emptyDocumentState);
    },
  }));
}

export const documentStore = createDocumentStore();

export function useDocumentStore<T>(selector: (state: DocumentState) => T): T {
  return useStore(documentStore, selector);
}
