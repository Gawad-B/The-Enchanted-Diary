import type { NormalizedRect } from '@enchanted/shared';
import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist';
import { PAGE_ASPECT } from '../book/pageAspect';
import type { Side } from '../book/bookLayout';
import { drawParchment } from '../book/paperTexture';

/*
 * One PDF page as a texture for a leaf. The leaf has a fixed aspect (PAGE_ASPECT, 21 cm over 15 cm), so a page of any
 * other shape is LETTERBOXED inside it (fitted whole, centred, never stretched) and the rest is the diary's parchment.
 * The page is multiplied onto the parchment (white paper takes the parchment's colour; black ink stays black), which is
 * how it looks as if it were printed on the diary's own paper. A binding margin keeps the text out of the curve of the gutter.
 */

/** What of pdf.js the renderer uses (a document and a page), so tests need no real PDF. */
export type PdfDocumentLike = Pick<PDFDocumentProxy, 'numPages' | 'getPage'>;
export type PdfPageLike = Pick<PDFPageProxy, 'getViewport' | 'render' | 'cleanup'>;

/** Margin round the fitted page, as a share of the texture's width: outer edges and the binding edge. */
export const OUTER_MARGIN = 0.03;
export const BINDING_MARGIN = 0.055;

/** How strongly the second multiply pass (the ink's dot gain) is laid over the first. */
export const INK_DENSITY_PASS = 0.55;

export interface PageFit {
  /** The texture's size. */
  width: number;
  height: number;
  /** Where the PDF page goes on it. */
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Where a PDF page of `pageWidth` x `pageHeight` (any unit) goes on a leaf texture `width` wide whose binding edge is on
 * `bindingEdge` (the side of the texture the gutter is on): the largest size that fits the margins, centred between them.
 */
export function fitPage(width: number, pageWidth: number, pageHeight: number, bindingEdge: Side): PageFit {
  const height = Math.round(width * PAGE_ASPECT);
  const outer = width * OUTER_MARGIN;
  const binding = width * BINDING_MARGIN;
  const left = bindingEdge === 'left' ? binding : outer;
  const availableWidth = width - outer - binding;
  const availableHeight = height - 2 * outer;
  const scale = Math.min(availableWidth / pageWidth, availableHeight / pageHeight);
  const w = pageWidth * scale;
  const h = pageHeight * scale;
  return { width, height, x: left + (availableWidth - w) / 2, y: outer + (availableHeight - h) / 2, w, h };
}

export interface RenderOptions {
  /** The texture's side the gutter is on (an odd page of an LTR book is on the left of its spread, so its gutter is on its right). */
  bindingEdge?: Side;
  /** Passages to glow under the ink, in fractions of the PDF page (origin top-left). */
  highlight?: readonly NormalizedRect[];
  /**
   * Keep what pdf.js decoded for the page (its operator list, its images) after this render: the full-width pass of the same
   * page follows the cheap one, and a clean-up in between makes it fetch and decode everything again. The caller that sets
   * this owes the page a render without it (the last pass cleans up).
   */
  keepPage?: boolean;
  /** Canvas factory (tests). */
  createCanvas?: (width: number, height: number) => HTMLCanvasElement;
}

function defaultCreateCanvas(width: number, height: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

/** Frees a canvas's pixels at once instead of waiting for the garbage collector. */
export function zeroCanvas(canvas: HTMLCanvasElement): void {
  canvas.width = 0;
  canvas.height = 0;
}

/** `signal.aborted`, read fresh: after an `await` the compiler still believes what an earlier check said. */
export function isAborted(signal: AbortSignal): boolean {
  return signal.aborted;
}

function abortError(): DOMException {
  return new DOMException('The page was not rendered: the request was cancelled', 'AbortError');
}

/**
 * The diary's own parchment, drawn once per texture width and copied under every page (drawing it takes ~20 ms at 1200
 * px). Pages, previews and thumbnails use three widths at most, so three sheets are kept; the least recently used goes.
 */
const PARCHMENT_SHEETS = 3;
const parchmentCache = new Map<number, HTMLCanvasElement>();

function parchmentFor(
  width: number,
  height: number,
  create: (w: number, h: number) => HTMLCanvasElement,
): HTMLCanvasElement | null {
  const known = parchmentCache.get(width);
  if (known?.width === width) {
    parchmentCache.delete(width);
    parchmentCache.set(width, known); // most recently used last
    return known;
  }
  const canvas = create(width, height);
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  drawParchment(ctx, width, height, create, { seed: 31 });
  parchmentCache.set(width, canvas);
  while (parchmentCache.size > PARCHMENT_SHEETS) {
    const [oldest] = parchmentCache.keys();
    if (oldest === undefined) break;
    const sheet = parchmentCache.get(oldest);
    if (sheet) zeroCanvas(sheet);
    parchmentCache.delete(oldest);
  }
  return canvas;
}

/** Releases the cached parchment sheets (when the document goes away). */
export function releaseParchmentCache(): void {
  for (const sheet of parchmentCache.values()) zeroCanvas(sheet);
  parchmentCache.clear();
}

/**
 * Paints the parchment under a page. Pages alternate between the sheet and its mirror image, so a spread does not show
 * the same stain twice side by side.
 */
function paintParchment(
  ctx: CanvasRenderingContext2D,
  base: HTMLCanvasElement,
  width: number,
  height: number,
  mirror: boolean,
): void {
  ctx.save();
  if (mirror) {
    ctx.translate(width, 0);
    ctx.scale(-1, 1);
  }
  ctx.drawImage(base, 0, 0, width, height);
  ctx.restore();
}

/** A soft warm glow under the passages, drawn before the ink so the ink stays black on gold. */
function paintHighlight(ctx: CanvasRenderingContext2D, fit: PageFit, rects: readonly NormalizedRect[]): void {
  ctx.save();
  ctx.fillStyle = 'rgba(240, 188, 84, 0.62)';
  ctx.shadowColor = 'rgba(255, 190, 80, 0.95)';
  ctx.shadowBlur = fit.width * 0.014;
  const pad = fit.width * 0.004;
  for (const rect of rects) {
    ctx.fillRect(
      fit.x + rect.x * fit.w - pad,
      fit.y + rect.y * fit.h - pad,
      rect.w * fit.w + 2 * pad,
      rect.h * fit.h + 2 * pad,
    );
  }
  ctx.restore();
}

/**
 * Renders page `pageNumber` of `pdf` as a leaf texture `targetWidth` px wide (and PAGE_ASPECT times as high). The
 * caller owns the canvas it gets (and zeroes it with `zeroCanvas` when done). Rejects with an AbortError when
 * `signal` aborts (the pdf.js render is cancelled), and records `performance.measure('pdf-render:<page>')`.
 */
export async function renderPage(
  pdf: PdfDocumentLike,
  pageNumber: number,
  targetWidth: number,
  signal: AbortSignal,
  options: RenderOptions = {},
): Promise<HTMLCanvasElement> {
  const create = options.createCanvas ?? defaultCreateCanvas;
  const started = typeof performance === 'undefined' ? 0 : performance.now();
  if (signal.aborted) throw abortError();
  const page = await pdf.getPage(pageNumber);
  if (isAborted(signal)) {
    page.cleanup();
    throw abortError();
  }
  const natural = page.getViewport({ scale: 1 });
  const bindingEdge = options.bindingEdge ?? 'left';
  const fit = fitPage(Math.round(targetWidth), natural.width, natural.height, bindingEdge);
  const viewport = page.getViewport({ scale: fit.w / natural.width });
  const sheet = create(Math.ceil(viewport.width), Math.ceil(viewport.height));
  const sheetContext = sheet.getContext('2d');
  if (!sheetContext) {
    zeroCanvas(sheet);
    page.cleanup();
    throw new Error('This browser gave no 2D canvas to draw the page on');
  }
  const task = page.render({ canvas: sheet, canvasContext: sheetContext, viewport });
  const cancel = (): void => {
    task.cancel();
  };
  signal.addEventListener('abort', cancel, { once: true });
  let drawn = false;
  try {
    await task.promise;
    drawn = true;
  } catch (error) {
    zeroCanvas(sheet);
    if (isAborted(signal)) throw abortError();
    throw error;
  } finally {
    signal.removeEventListener('abort', cancel);
    if (!(drawn && options.keepPage === true)) page.cleanup();
  }
  if (isAborted(signal)) {
    zeroCanvas(sheet);
    throw abortError();
  }

  const leaf = create(fit.width, fit.height);
  const ctx = leaf.getContext('2d');
  const base = parchmentFor(fit.width, fit.height, create);
  if (!ctx || !base) {
    zeroCanvas(sheet);
    zeroCanvas(leaf);
    throw new Error('This browser gave no 2D canvas to draw the page on');
  }
  paintParchment(ctx, base, fit.width, fit.height, pageNumber % 2 === 0);
  if (options.highlight && options.highlight.length > 0) paintHighlight(ctx, fit, options.highlight);
  ctx.globalCompositeOperation = 'multiply';
  ctx.drawImage(sheet, fit.x, fit.y, fit.w, fit.h);
  // Ink spreads into paper (dot gain): a second, lighter pass darkens only the grey edges of the glyphs (white and black do
  // not change), so thin text stays legible when the leaf is seen at a third of its size.
  ctx.globalAlpha = INK_DENSITY_PASS;
  ctx.drawImage(sheet, fit.x, fit.y, fit.w, fit.h);
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = 'source-over';
  zeroCanvas(sheet);

  if (typeof performance !== 'undefined' && typeof performance.measure === 'function') {
    try {
      performance.measure(`pdf-render:${String(pageNumber)}`, {
        start: started,
        end: performance.now(),
        detail: { width: fit.width },
      });
    } catch {
      // a User Timing entry is a courtesy; never fail a page for it
    }
  }
  return leaf;
}
