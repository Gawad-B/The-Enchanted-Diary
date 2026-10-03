import { CONTROL_CHARS, UNMAPPED_GLYPH, stripInvisibleAndMarks } from '../text/normalize.js';
import { imageCoverage } from './image-coverage.js';
import { vectorFillCount } from './vector-paths.js';
import {
  layoutPage,
  isListMarkerLine,
  HEADING_ADVANCE_RATIO,
  HEADING_MAX_CHARS,
  HEADING_MAX_LINES,
} from './layout.js';
import type { PDFPageProxy } from './load.js';
import { takeRemovedImages } from './warnings.js';
import { IMAGE_PAGE_MAX_CHARS, computeQuality } from './quality.js';
import type { ExtractedPage, PositionedItem, TextBlock } from './types.js';

const BOLD_FONT_NAME = /bold|black|heavy|semibold|demibold|extrabold|ultrabold/iu;
/** Defaults when pdf.js does not know a font's metrics (the 14 standard fonts), as fractions of the font size. */
const DEFAULT_ASCENT = 0.9;
const DEFAULT_DESCENT = -0.2;
/** Fonts report extreme metrics (Arabic faces with tall marks); boxes are clamped so highlights stay line-sized. */
const ASCENT_RANGE: [number, number] = [0.7, 1];
const DESCENT_RANGE: [number, number] = [-0.35, -0.1];
/** Pages with fewer characters than this, and a mostly-symbol text, get their font names looked up for quality. */
const SYMBOL_RATIO_FOR_FONT_LOOKUP = 0.2;
const MIN_CHARS_FOR_FONT_LOOKUP = 20;

interface TextStyle {
  ascent?: number | null;
  descent?: number | null;
}

interface RawTextItem {
  str: string;
  width: number;
  transform: number[];
  fontName: string;
}

const clamp = (value: number, [low, high]: [number, number]): number => Math.min(high, Math.max(low, value));
const finiteOr = (value: number | null | undefined, fallback: number): number =>
  typeof value === 'number' && Number.isFinite(value) ? value : fallback;

function isTextItem(item: unknown): item is RawTextItem {
  return typeof item === 'object' && item !== null && 'str' in item && 'transform' in item;
}

type Matrix = [number, number, number, number, number, number];

const toMatrix = (values: readonly number[]): Matrix => [
  values[0] ?? 1,
  values[1] ?? 0,
  values[2] ?? 0,
  values[3] ?? 1,
  values[4] ?? 0,
  values[5] ?? 0,
];

/** `m` then `n`, as pdf.js's Util.transform does: the transform that applies `n` first and then `m`. */
const multiply = (m: Matrix, n: Matrix): Matrix => [
  m[0] * n[0] + m[2] * n[1],
  m[1] * n[0] + m[3] * n[1],
  m[0] * n[2] + m[2] * n[3],
  m[1] * n[2] + m[3] * n[3],
  m[0] * n[4] + m[2] * n[5] + m[4],
  m[1] * n[4] + m[3] * n[5] + m[5],
];

/**
 * Places one text item on the displayed page. `viewport.transform` maps PDF user space to the viewport (it
 * applies /Rotate and flips y); combined with `item.transform` it maps the item's own space, in which the em box
 * is [0, width/size] x [descent, ascent], so the four corners of that box give the item's rectangle however the
 * page is rotated.
 */
function positionItem(
  item: RawTextItem,
  style: TextStyle | undefined,
  viewportTransform: Matrix,
  text: string,
): PositionedItem | null {
  const own = toMatrix(item.transform);
  const tx = multiply(viewportTransform, own);
  const fontSize = Math.hypot(tx[2], tx[3]);
  const advance = Math.hypot(own[0], own[1]);
  if (!Number.isFinite(fontSize) || fontSize <= 0 || !Number.isFinite(item.width)) return null;
  const widthInEm = advance > 0 ? item.width / advance : 0;
  const ascent = clamp(finiteOr(style?.ascent, DEFAULT_ASCENT), ASCENT_RANGE);
  const descent = clamp(finiteOr(style?.descent, DEFAULT_DESCENT), DESCENT_RANGE);
  const corners: [number, number][] = [
    [0, descent],
    [widthInEm, descent],
    [0, ascent],
    [widthInEm, ascent],
  ];
  const xs = corners.map(([x, y]) => tx[0] * x + tx[2] * y + tx[4]);
  const ys = corners.map(([x, y]) => tx[1] * x + tx[3] * y + tx[5]);
  const horizontal = Math.abs(tx[1]) <= 0.3 * Math.abs(tx[0]) && tx[0] > 0;
  return {
    text,
    x0: Math.min(...xs),
    x1: Math.max(...xs),
    top: Math.min(...ys),
    bottom: Math.max(...ys),
    baseline: tx[5],
    fontSize,
    fontName: item.fontName,
    bold: false,
    horizontal,
  };
}

/** Real font names of the page (pdf.js only knows them once the page's operator list has been built). */
function lookUpFontNames(page: PDFPageProxy, fontIds: readonly string[]): Map<string, string> {
  const names = new Map<string, string>();
  for (const id of fontIds) {
    if (!page.commonObjs.has(id)) continue;
    const font = page.commonObjs.get(id) as { name?: unknown } | undefined;
    if (typeof font?.name === 'string') names.set(id, font.name);
  }
  return names;
}

/** A sentence end: such a block is a paragraph, not a heading, whatever its font. */
const SENTENCE_END = /[.!?\u061F\u2026]["'\u201D\u2019)\]\u00BB]*$/u;

/**
 * A short, non-heading block standing well apart from the text above whose font could decide that it is a heading:
 * only those justify building the operator list for the font names. A block that ends a sentence, a table row
 * and a list entry are decided by the text alone (they are never headings), and so is everything else on the page.
 */
function mightBeBoldHeading(
  block: TextBlock,
  previous: TextBlock | undefined,
  bodyFontSize: number,
  leading: number,
): boolean {
  if (block.isHeading || block.lines.length > HEADING_MAX_LINES || block.text.length > HEADING_MAX_CHARS)
    return false;
  if (block.fontSize < 0.95 * bodyFontSize || /^[\d\s\p{P}]*$/u.test(block.text)) return false;
  if (
    SENTENCE_END.test(block.text.trimEnd()) ||
    block.lines.some((line) => line.tabular) ||
    isListMarkerLine(block.text)
  ) {
    return false;
  }
  const first = block.lines[0];
  const rect = first?.rect;
  if (rect === undefined || rect.y > 0.92 || rect.y + rect.h < 0.06) return false; // page numbers, running heads
  const above = previous?.lines.at(-1);
  return above === undefined || (first?.baseline ?? 0) - above.baseline >= HEADING_ADVANCE_RATIO * leading;
}

const symbolRatio = (text: string): number => {
  const nonSpace = text.replace(/\s/gu, '');
  if (nonSpace === '') return 0;
  return (nonSpace.match(/[^\p{L}\p{N}]/gu)?.length ?? 0) / nonSpace.length;
};

/**
 * Extracts one page: positioned items, lines in reading order with logical text (RTL aware), blocks with
 * rectangles and character offsets, headings, quality evidence and, for pages with little text, how much of the
 * page is image. The page's pdf.js resources are released before returning.
 */
export async function extractPage(
  doc: { getPage(pageNumber: number): Promise<PDFPageProxy> },
  pageNumber: number,
): Promise<ExtractedPage> {
  const page = await doc.getPage(pageNumber);
  try {
    const viewport = page.getViewport({ scale: 1 });
    const content = await page.getTextContent();

    let rawChars = 0;
    let unmappedChars = 0;
    let controlChars = 0;
    const items: PositionedItem[] = [];
    for (const raw of content.items) {
      if (!isTextItem(raw)) continue;
      rawChars += raw.str.length;
      unmappedChars += raw.str.match(UNMAPPED_GLYPH)?.length ?? 0;
      controlChars += raw.str.match(CONTROL_CHARS)?.length ?? 0;
      const text = stripInvisibleAndMarks(raw.str);
      if (text === '') continue;
      const positioned = positionItem(raw, content.styles[raw.fontName], toMatrix(viewport.transform), text);
      if (positioned !== null) items.push(positioned);
    }

    const layoutOptions = { pageWidth: viewport.width, pageHeight: viewport.height };
    let layout = layoutPage(items, layoutOptions);

    // The operator list is built at most once per page, and only when something needs it: font names (bold
    // headings, Arabic-font quality check) or the image coverage of a page with little text.
    let operators: Awaited<ReturnType<PDFPageProxy['getOperatorList']>> | null | undefined;
    let removedImages = 0;
    const operatorList = async (): Promise<typeof operators> => {
      if (operators === undefined) {
        takeRemovedImages();
        try {
          operators = await page.getOperatorList();
        } catch {
          operators = null;
        }
        removedImages = takeRemovedImages();
      }
      return operators;
    };

    const fontIds = [...new Set(items.map((item) => item.fontName))];
    let fontNames: string[] = [];
    const stats = layout.fontStats;
    const text0 = layout.text;
    const wantsBoldLookup = layout.blocks.some((block, index) =>
      mightBeBoldHeading(block, layout.blocks[index - 1], stats.bodyFontSize, stats.medianLeading),
    );
    const letters = text0.replace(/\s/gu, '').length;
    const wantsQualityLookup =
      letters >= MIN_CHARS_FOR_FONT_LOOKUP && symbolRatio(text0) > SYMBOL_RATIO_FOR_FONT_LOOKUP;
    if (wantsBoldLookup || wantsQualityLookup) {
      if ((await operatorList()) !== null) {
        const byId = lookUpFontNames(page, fontIds);
        fontNames = [...new Set(byId.values())];
        if (wantsBoldLookup) {
          for (const item of items) item.bold = BOLD_FONT_NAME.test(byId.get(item.fontName) ?? '');
          layout = layoutPage(items, { ...layoutOptions, fontNames });
        }
      }
    }

    const charCount = layout.text.replace(/\s/gu, '').length;
    let coverage = 0;
    let vectorPaths = 0;
    if (charCount < IMAGE_PAGE_MAX_CHARS) {
      const ops = await operatorList();
      if (ops !== null && ops !== undefined) {
        coverage = imageCoverage(ops.fnArray, ops.argsArray, viewport.width, viewport.height);
        vectorPaths = vectorFillCount(ops.fnArray, ops.argsArray);
      }
      // An image above the extraction limit (4000 x 4000 pixels or more) was refused, so it is not in the operator
      // list: it is a scan, and it is taken to fill the page.
      if (removedImages > 0) coverage = 1;
    }

    return {
      pageNumber,
      width: viewport.width,
      height: viewport.height,
      rotation: viewport.rotation,
      items,
      lines: layout.lines,
      blocks: layout.blocks,
      text: layout.text,
      charCount,
      imageCoverage: coverage,
      vectorPaths,
      removedImages,
      fontStats: { ...layout.fontStats, fontNames },
      quality: computeQuality(
        layout.text,
        { chars: rawChars, unmapped: unmappedChars, controls: controlChars },
        fontNames,
      ),
    };
  } finally {
    page.cleanup();
  }
}
