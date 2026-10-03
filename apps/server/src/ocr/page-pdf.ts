import { PDFDocument } from 'pdf-lib';
import type { OcrPdfPage } from './types.js';

/*
 * Pages of a PDF as a PDF of their own: what a model that reads documents is given instead of a rendering. Copying
 * moves the page's content and its resources (fonts, images) as they are, so nothing is decoded here and the text and
 * scripts of the original stay exact (Arabic shaping, vector outlines, scans alike).
 */

/** pdf-lib's own limit for what it will parse is memory: it runs in the ingestion worker thread, with the others. */
export async function loadSourceDocument(bytes: Uint8Array): Promise<PDFDocument> {
  return PDFDocument.load(bytes, {
    ignoreEncryption: true,
    updateMetadata: false,
    throwOnInvalidObject: false,
  });
}

/** The size in points of page `pageNumber` (1-based) as it displays (a page turned a quarter has its sides swapped). */
export function displayedSize(source: PDFDocument, pageNumber: number): { width: number; height: number } {
  const page = source.getPage(pageNumber - 1);
  const { width, height } = page.getSize();
  const turned = Math.abs(page.getRotation().angle) % 180 === 90;
  return turned ? { width: height, height: width } : { width, height };
}

export interface PagesPdf {
  /** The pages, in the order given, as one PDF: its page 1 is the first of `pageNumbers`. */
  pdf: Uint8Array;
  /** Each page's displayed size, in the same order. */
  sizes: { width: number; height: number }[];
}

/** Pages `pageNumbers` (1-based) of `source` as one PDF. */
export async function pagesPdf(source: PDFDocument, pageNumbers: readonly number[]): Promise<PagesPdf> {
  const target = await PDFDocument.create();
  const copied = await target.copyPages(
    source,
    pageNumbers.map((pageNumber) => pageNumber - 1),
  );
  for (const page of copied) target.addPage(page);
  return {
    pdf: await target.save({ useObjectStreams: true }),
    sizes: pageNumbers.map((pageNumber) => displayedSize(source, pageNumber)),
  };
}

/** Page `pageNumber` (1-based) of `source` as its own PDF, with its size in points as the page displays it. */
export async function singlePagePdf(source: PDFDocument, pageNumber: number): Promise<OcrPdfPage> {
  const { pdf, sizes } = await pagesPdf(source, [pageNumber]);
  const [size] = sizes;
  if (size === undefined) throw new Error(`The document has no page ${String(pageNumber)}`);
  return { pdf, ...size };
}

/** One page as it was drawn: its JPEG and the size of the page it renders, in points. */
export interface RenderedPage {
  jpeg: Uint8Array;
  width: number;
  height: number;
}

/**
 * A PDF with one page for each rendering, each page as large as the page it stands for and the image filling it. What a
 * model that reads documents is given for pages that cannot be cut out of the original: an encrypted document (only an
 * owner password, so pdf.js opens it, but pdf-lib would copy its streams still encrypted), or one that pdf-lib cannot
 * copy. JPEGs are embedded as they are, so nothing is decoded or encoded here.
 */
export async function pdfOfRenderings(pages: readonly RenderedPage[]): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  for (const rendered of pages) {
    const image = await doc.embedJpg(rendered.jpeg);
    const page = doc.addPage([rendered.width, rendered.height]);
    page.drawImage(image, { x: 0, y: 0, width: rendered.width, height: rendered.height });
  }
  return doc.save({ useObjectStreams: true });
}

/** Whether the document is encrypted (pdf-lib was asked to ignore it, which only makes it readable as a structure). */
export const isEncrypted = (source: PDFDocument): boolean => source.isEncrypted;

let quiet = 0;
let original: typeof console.warn | null = null;

/**
 * Runs `run` with pdf-lib's complaints about the files it is given ("Trying to parse invalid object", "Invalid object
 * ref") swallowed: it writes them with console.warn, and nothing a worker thread does may print (the server's log is
 * pino's). What the file's faults cost is seen in the pages that come out.
 */
export async function withoutPdfLibWarnings<T>(run: () => Promise<T>): Promise<T> {
  if (quiet === 0) {
    original = console.warn;
    console.warn = (): void => undefined;
  }
  quiet += 1;
  try {
    return await run();
  } finally {
    quiet -= 1;
    if (quiet === 0 && original !== null) {
      console.warn = original;
      original = null;
    }
  }
}
