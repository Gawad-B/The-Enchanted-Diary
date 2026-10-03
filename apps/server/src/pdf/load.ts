import path from 'node:path';
import { createRequire } from 'node:module';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import type { PDFDocumentProxy } from 'pdfjs-dist/legacy/build/pdf.mjs';

export type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist/legacy/build/pdf.mjs';
export { pdfjs };

const require = createRequire(import.meta.url);
const PDFJS_ROOT = path.dirname(require.resolve('pdfjs-dist/package.json'));

/**
 * Options for every pdf.js document the server opens (global section L). The legacy build is the one that
 * runs in Node. Data directories come from the installed package so CJK/Arabic CMaps and the standard fonts
 * work without network access.
 *  - `isEvalSupported: false`: font programs are never compiled with `new Function` (CVE-2024-4367 class).
 *    pdfjs-dist 6.3.289 has no eval path left and ignores the option; it stays so that an older build cannot
 *    be swapped in without it.
 *  - `disableFontFace`: fonts are not turned into FontFace objects (there is no DOM here).
 *  - `maxImageSize`: images above this many pixels are skipped instead of decoded (decompression bombs). 64 million
 *    is the ceiling; the extraction pass of the ingestion workers uses the much lower
 *    {@link EXTRACTION_MAX_IMAGE_SIZE}, because decoded images live outside the heap limit of a worker.
 *  - `stopAtErrors: false`: a broken page does not fail the rest of the document.
 */
const SECURE_OPTIONS = {
  isEvalSupported: false,
  disableFontFace: true,
  useSystemFonts: false,
  maxImageSize: 64e6,
  stopAtErrors: false,
  verbosity: 0,
  isOffscreenCanvasSupported: false,
  standardFontDataUrl: `${path.join(PDFJS_ROOT, 'standard_fonts')}/`,
  cMapUrl: `${path.join(PDFJS_ROOT, 'cmaps')}/`,
  cMapPacked: true,
  wasmUrl: `${path.join(PDFJS_ROOT, 'wasm')}/`,
  iccUrl: `${path.join(PDFJS_ROOT, 'iccs')}/`,
} as const;

/** The pdf.js `getDocument` options used by the server, exported so a test can pin them. */
export const PDF_DOCUMENT_OPTIONS = SECURE_OPTIONS;

/**
 * Largest image, in pixels, the extraction pass decodes (16 million: a 4000 x 4000 scan). Text extraction needs
 * no image at all; only the page-coverage check reads the operator list, and a bigger image is treated as
 * "this page is an image" (see `removedImages`) instead of being decoded into 250 MB of RGBA.
 */
export const EXTRACTION_MAX_IMAGE_SIZE = 16e6;

export interface LoadOptions {
  /**
   * Open the document the way the ingestion workers read it: images above EXTRACTION_MAX_IMAGE_SIZE are skipped, and
   * pdf.js warnings are enabled so a skipped image can be noticed (the worker installs a sink that swallows them,
   * see `warnings.ts`; without it they would be printed).
   */
  extraction?: boolean;
}

/**
 * Opens a PDF held in memory. pdf.js takes ownership of the array it is given (it detaches it), so the bytes
 * are copied: the caller keeps its own. Rejects with pdf.js's own errors (PasswordException,
 * InvalidPDFException, ...); see {@link classifyPdfError}.
 */
export async function loadPdf(bytes: Uint8Array, options: LoadOptions = {}): Promise<PDFDocumentProxy> {
  // A plain Uint8Array is required: a Buffer is rejected.
  const data = new Uint8Array(bytes.byteLength);
  data.set(bytes);
  const extraction =
    options.extraction === true ? { maxImageSize: EXTRACTION_MAX_IMAGE_SIZE, verbosity: 1 } : {};
  return pdfjs.getDocument({ ...SECURE_OPTIONS, ...extraction, data }).promise;
}

/** Releases everything pdf.js holds for the document. */
export async function closePdf(doc: PDFDocumentProxy): Promise<void> {
  await doc.loadingTask.destroy();
}

export interface PdfFailure {
  code: 'PDF_ENCRYPTED' | 'PDF_MALFORMED';
  message: string;
}

/** Maps what pdf.js throws while opening a document to an API error code. */
export function classifyPdfError(error: unknown): PdfFailure {
  const name = error instanceof Error ? error.name : '';
  if (name === 'PasswordException') {
    return { code: 'PDF_ENCRYPTED', message: 'The PDF is password protected.' };
  }
  // pdf.js's own verdicts on a bad file are safe to show; any other exception text could name a path or a
  // library internals, so it is replaced (the caller logs the original).
  const reason =
    error instanceof Error && PDFJS_PARSE_ERRORS.has(name) && error.message !== ''
      ? error.message
      : 'unreadable structure';
  return { code: 'PDF_MALFORMED', message: `The PDF structure could not be read (${reason}).` };
}

const PDFJS_PARSE_ERRORS = new Set([
  'InvalidPDFException',
  'MissingPDFException',
  'FormatError',
  'XRefParseException',
]);
