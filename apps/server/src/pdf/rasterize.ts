import type { PDFDocumentProxy } from './load.js';

/*
 * Renders one page of a PDF to a PNG for OCR. pdf.js draws into a @napi-rs/canvas (its Node canvas factory), the
 * canvas is encoded and then released at once: a page is 4 to 15 million pixels of RGBA, and a job renders dozens.
 */

/** The longest side of the rendered image: Tesseract gains nothing from more and its memory grows with the area. */
export const MAX_RASTER_SIDE = 3000;
const POINTS_PER_INCH = 72;

/** Scale from PDF points to pixels: `dpi` / 72, reduced so that the longest side stays within `maxSide`. */
export function rasterScale(
  pageWidth: number,
  pageHeight: number,
  dpi: number,
  maxSide: number = MAX_RASTER_SIDE,
): number {
  const wanted = dpi / POINTS_PER_INCH;
  const longest = Math.max(pageWidth, pageHeight);
  return longest * wanted > maxSide ? maxSide / longest : wanted;
}

export interface RasterOptions {
  /** OCR_DPI. */
  dpi: number;
  maxSide?: number;
  /** The encoding: `png` (the default, lossless, what Tesseract reads) or `jpeg` (a tenth of the size, for a model that reads documents). */
  format?: 'png' | 'jpeg';
  /** JPEG quality, 1 to 100. Default 85. */
  quality?: number;
}

const DEFAULT_JPEG_QUALITY = 85;

export interface RasterizedPage {
  /** The encoded image: a PNG, or a JPEG when `options.format` asked for one (the name is the one of the first use). */
  png: Buffer;
  format: 'png' | 'jpeg';
  /** Pixels. */
  width: number;
  height: number;
  /** The displayed page in points (what extraction reports), for turning pixel boxes into fractions of the page. */
  pageWidth: number;
  pageHeight: number;
}

/** The part of pdf.js's `canvasFactory` that is used (the typings only say `Object`). */
interface CanvasFactory {
  create(width: number, height: number): { canvas: EncodableCanvas; context: CanvasContext };
  destroy(target: { canvas: EncodableCanvas; context: CanvasContext }): void;
}

interface EncodableCanvas {
  width: number;
  height: number;
  encode(format: 'png'): Promise<Buffer>;
  encode(format: 'jpeg', quality?: number): Promise<Buffer>;
}

interface CanvasContext {
  fillStyle: string;
  fillRect(x: number, y: number, width: number, height: number): void;
}

function canvasFactoryOf(doc: PDFDocumentProxy): CanvasFactory {
  return doc.canvasFactory as CanvasFactory;
}

/**
 * Renders page `pageNumber` (the way it is displayed: /Rotate applied) on a white background and returns it as a PNG.
 * Images the page draws are decoded up to the document's `maxImageSize` (64 million pixels for a plain `loadPdf`).
 */
export async function rasterizePage(
  doc: PDFDocumentProxy,
  pageNumber: number,
  options: RasterOptions,
): Promise<RasterizedPage> {
  const page = await doc.getPage(pageNumber);
  const factory = canvasFactoryOf(doc);
  try {
    const base = page.getViewport({ scale: 1 });
    const viewport = page.getViewport({
      scale: rasterScale(base.width, base.height, options.dpi, options.maxSide),
    });
    const target = factory.create(Math.ceil(viewport.width), Math.ceil(viewport.height));
    try {
      // pdf.js leaves untouched pixels transparent, which a PNG encoder turns into black under some decoders.
      target.context.fillStyle = '#ffffff';
      target.context.fillRect(0, 0, target.canvas.width, target.canvas.height);
      // pdf.js types its canvas as the DOM's; the server has no DOM typings, and the napi canvas is what it expects.
      const parameters = {
        canvas: target.canvas,
        canvasContext: target.context,
        viewport,
        background: '#ffffff',
      };
      await page.render(parameters).promise;
      const width = target.canvas.width;
      const height = target.canvas.height;
      const format = options.format ?? 'png';
      return {
        png:
          format === 'jpeg'
            ? await target.canvas.encode('jpeg', options.quality ?? DEFAULT_JPEG_QUALITY)
            : await target.canvas.encode('png'),
        format,
        width,
        height,
        pageWidth: base.width,
        pageHeight: base.height,
      };
    } finally {
      factory.destroy(target);
    }
  } finally {
    page.cleanup();
  }
}
