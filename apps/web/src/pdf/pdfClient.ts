import type { PDFDocumentProxy } from 'pdfjs-dist';
import type * as PdfJs from 'pdfjs-dist';

/*
 * The browser's door to pdf.js. The library (about 400 kB) and its worker load lazily, on the first document, so the
 * first screen never pays for them. Every document is opened the same way: the worker URL comes from Vite (`?url`, a
 * hashed asset of our own origin: the CSP allows `worker-src 'self'`), `isEvalSupported` is off (font programs are never
 * compiled with `new Function`; pdfjs-dist 6 has no eval path left and ignores the option, which stays so that an older
 * build cannot be swapped in without it), and the data directories (CMaps for CJK and Arabic encodings, the standard
 * fonts for PDFs that do not embed theirs, the wasm image decoders, the ICC profiles) are served from our own origin under
 * /pdfjs/ by the Vite plugin (connect-src is 'self').
 */

/** Where the Vite plugin serves pdf.js's data directories (see vite.config.ts). */
const DATA_ROOT = `${import.meta.env.BASE_URL}pdfjs/`;

/** The pdf.js `getDocument` options every document is opened with (exported so a test can pin them). */
export const PDF_OPEN_OPTIONS = {
  isEvalSupported: false,
  // A broken page does not fail the rest of the document; only errors are logged.
  stopAtErrors: false,
  verbosity: 0,
  // Images above this many pixels are skipped instead of decoded (decompression bombs).
  maxImageSize: 64e6,
  cMapUrl: `${DATA_ROOT}cmaps/`,
  cMapPacked: true,
  standardFontDataUrl: `${DATA_ROOT}standard_fonts/`,
  wasmUrl: `${DATA_ROOT}wasm/`,
  iccUrl: `${DATA_ROOT}iccs/`,
} as const;

export type PdfSource = ArrayBuffer | URL;

export interface OpenPdfOptions {
  /** Aborting stops the load and releases what pdf.js started; the promise rejects with an AbortError. */
  signal?: AbortSignal;
  /**
   * Copy the bytes before handing them to pdf.js (the default), which detaches the array it is given. A caller whose buffer
   * is its own (a fresh `File.arrayBuffer()`) turns the copy off and does not keep it.
   */
  copy?: boolean;
}

let library: Promise<typeof PdfJs> | null = null;

/** Starts loading pdf.js and its worker without opening anything (the upload calls it as soon as a file is chosen). */
export function preloadPdfLibrary(): void {
  loadLibrary().catch(() => undefined); // a failed preload is forgotten: opening a document tries again
}

/** Loads pdf.js once and points it at its worker. A failed load is forgotten so a later try can succeed. */
function loadLibrary(): Promise<typeof PdfJs> {
  library ??= (async () => {
    const [pdfjs, worker] = await Promise.all([
      import('pdfjs-dist'),
      import('pdfjs-dist/build/pdf.worker.min.mjs?url'),
    ]);
    pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
    return pdfjs;
  })().catch((error: unknown) => {
    library = null;
    throw error;
  });
  return library;
}

function abortError(): DOMException {
  return new DOMException('The PDF was not opened: the request was cancelled', 'AbortError');
}

/**
 * Opens a PDF. Bytes are copied first: pdf.js hands the array to its worker and detaches it, and the caller (the reader's
 * File, a cached buffer) keeps its own. A URL is fetched by pdf.js with the page's cookies (same origin). Rejects with
 * pdf.js's own errors (PasswordException, InvalidPDFException, MissingPDFException, ...) or an AbortError.
 */
export async function openPdf(source: PdfSource, options: OpenPdfOptions = {}): Promise<PDFDocumentProxy> {
  const { signal } = options;
  if (signal?.aborted) throw abortError();
  const pdfjs = await loadLibrary();
  if (signal?.aborted) throw abortError();
  const origin =
    source instanceof URL
      ? // The stored file is one read of the server's budget (a Blob store counts every open): pdf.js streams it once,
        // never as a series of range requests that would each count.
        { url: source.href, disableRange: true, disableAutoFetch: true }
      : { data: new Uint8Array(options.copy === false ? source : source.slice(0)) };
  const task = pdfjs.getDocument({ ...PDF_OPEN_OPTIONS, ...origin });
  const cancel = (): void => {
    void task.destroy();
  };
  signal?.addEventListener('abort', cancel, { once: true });
  try {
    const pdf = await task.promise;
    if (signal?.aborted) {
      await task.destroy();
      throw abortError();
    }
    return pdf;
  } catch (error) {
    if (signal?.aborted) throw abortError();
    throw error;
  } finally {
    signal?.removeEventListener('abort', cancel);
  }
}

/** Releases the document and its worker-side resources. Safe to call twice. */
export async function closePdf(pdf: PDFDocumentProxy): Promise<void> {
  await pdf.loadingTask.destroy();
}
