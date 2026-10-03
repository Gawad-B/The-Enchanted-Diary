import { dominantDirection, type Direction } from '@enchanted/shared';
import { toNormalizedRect } from '../pdf/layout.js';
import { computeQuality } from '../pdf/quality.js';
import type { FontStats, PageQuality, TextBlock, TextLine } from '../pdf/types.js';
import { joinLines, normalizeLine } from '../text/normalize.js';
import type { OcrLine, OcrResult } from './types.js';

/*
 * From the lines Tesseract found to what the rest of the pipeline expects of a page: blocks (paragraphs) of lines
 * with normalised rectangles and offsets into the page text. The render covers the whole page, so a pixel box divided
 * by the image size is already a fraction of the page.
 */

/** A line Tesseract itself is less than this sure of is a speck or a stain, not text. */
export const MIN_LINE_CONFIDENCE = 15;
/** Line spacing is a low quantile of the distances between consecutive lines (paragraph gaps are above it). */
const LEADING_QUANTILE = 0.25;
/** A gap above this many times the page's line spacing starts a paragraph (the factor of the text layout). */
const PARAGRAPH_ADVANCE_RATIO = 1.4;
const MIN_LEADING_OVER_HEIGHT = 0.9;
/** A line box runs from ascender to descender, about 1.2 times the font size. */
const BOX_OVER_FONT_SIZE = 1.2;
const BASELINE_FROM_BOTTOM = 0.2;

export interface OcrPageGeometry {
  /** The displayed page in points (what extraction reports). */
  pageWidth: number;
  pageHeight: number;
  /** The rendered image in pixels. */
  imageWidth: number;
  imageHeight: number;
}

/** The parts of an extracted page that OCR text replaces. */
export interface OcrPageText {
  /**
   * Mean confidence of the lines that were kept, weighted by their characters (0 for a page without text). The page
   * confidence of the engine also counts the specks and stains that were dropped. Null when the engine reports none
   * (Gemini).
   */
  confidence: number | null;
  text: string;
  blocks: TextBlock[];
  /** Non-whitespace characters of `text`. */
  charCount: number;
  fontStats: FontStats;
  quality: PageQuality;
}

interface Kept {
  text: string;
  source: OcrLine;
  centre: number;
  height: number;
}

const HAS_CONTENT = /[\p{L}\p{N}]/u;

const median = (values: number[]): number => {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? (sorted[mid] ?? 0) : ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
};

const quantile = (values: number[], q: number): number =>
  [...values].sort((a, b) => a - b)[Math.floor(q * (values.length - 1))] ?? 0;

/** The usable lines, cleaned, in the order Tesseract reads the page (it already orders columns). */
function usableLines(lines: readonly OcrLine[]): Kept[] {
  const kept: Kept[] = [];
  for (const source of lines) {
    const text = normalizeLine(source.text);
    if (!HAS_CONTENT.test(text) || source.confidence < MIN_LINE_CONFIDENCE) continue;
    kept.push({
      text,
      source,
      centre: (source.bbox.y0 + source.bbox.y1) / 2,
      height: Math.max(1, source.bbox.y1 - source.bbox.y0),
    });
  }
  return kept;
}

/** The mean confidence of the lines, each weighted by its non-space characters. */
function weightedConfidence(lines: readonly Kept[]): number {
  let weight = 0;
  let sum = 0;
  for (const line of lines) {
    const chars = line.text.replace(/\s/gu, '').length;
    weight += chars;
    sum += chars * line.source.confidence;
  }
  return weight === 0 ? 0 : Math.min(100, Math.max(0, sum / weight));
}

const overlapsHorizontally = (a: OcrLine, b: OcrLine): boolean =>
  Math.min(a.bbox.x1, b.bbox.x1) > Math.max(a.bbox.x0, b.bbox.x0);

function groupIntoBlocks(lines: readonly Kept[]): { groups: Kept[][]; leading: number; bodyHeight: number } {
  const heights = lines.map((l) => l.height);
  const bodyHeight = median(heights);
  const advances: number[] = [];
  for (let i = 1; i < lines.length; i += 1) {
    const advance = (lines[i]?.centre ?? 0) - (lines[i - 1]?.centre ?? 0);
    if (advance > 0.2 * bodyHeight) advances.push(advance);
  }
  const leading =
    advances.length >= 2
      ? Math.max(quantile(advances, LEADING_QUANTILE), MIN_LEADING_OVER_HEIGHT * bodyHeight)
      : bodyHeight * 1.2;

  const groups: Kept[][] = [];
  lines.forEach((current, index) => {
    const previous = lines[index - 1];
    const startsBlock =
      previous === undefined ||
      current.centre - previous.centre <= 0 || // back up the page: the next column or region
      current.centre - previous.centre > PARAGRAPH_ADVANCE_RATIO * leading ||
      !overlapsHorizontally(current.source, previous.source);
    if (startsBlock) groups.push([current]);
    else groups.at(-1)?.push(current);
  });
  return { groups, leading, bodyHeight };
}

/**
 * Builds the page text, blocks and quality evidence from an OCR result. Lines without letters or digits and lines
 * Tesseract has almost no confidence in are dropped; paragraphs are found by vertical gaps; text is cleaned like
 * extracted text. Headings are not guessed: a scan has no font to tell them by, and the height of a line box (it
 * follows the ink: 36 to 50 pixels within one paragraph) says nothing about the size of its type.
 */
export function buildOcrPageText(result: OcrResult, geometry: OcrPageGeometry): OcrPageText {
  if (result.layout === 'page') return buildPlainPageText(result, geometry);
  const lines = usableLines(result.lines);
  const { groups, leading, bodyHeight } = groupIntoBlocks(lines);
  const toPointsX = geometry.pageWidth / geometry.imageWidth;
  const toPointsY = geometry.pageHeight / geometry.imageHeight;

  const blocks: TextBlock[] = [];
  let pageText = '';
  groups.forEach((group, index) => {
    const joined = joinLines(group.map((line) => line.text));
    const blockStart = pageText.length === 0 ? 0 : pageText.length + 2;
    if (pageText.length > 0) pageText += '\n\n';
    pageText += joined.text;
    const textLines: TextLine[] = group.map((line, lineIndex) => {
      const range = joined.ranges[lineIndex] ?? { start: 0, end: 0 };
      const { x0, y0, x1, y1 } = line.source.bbox;
      const top = y0 * toPointsY;
      const bottom = y1 * toPointsY;
      const direction: Direction = dominantDirection(line.text);
      return {
        text: line.text,
        direction,
        baseline: bottom - BASELINE_FROM_BOTTOM * (bottom - top),
        fontSize: (bottom - top) / BOX_OVER_FONT_SIZE,
        bold: false,
        x0: x0 * toPointsX,
        x1: x1 * toPointsX,
        top,
        bottom,
        rect: toNormalizedRect(x0, y0, x1, y1, geometry.imageWidth, geometry.imageHeight),
        charStart: blockStart + range.start,
        charEnd: blockStart + range.end,
        tabular: false,
      };
    });
    blocks.push({
      index,
      text: joined.text,
      charStart: blockStart,
      charEnd: blockStart + joined.text.length,
      lines: textLines,
      isHeading: false,
      fontSize: median(textLines.map((line) => line.fontSize)),
      bold: false,
      direction: dominantDirection(joined.text),
      rects: textLines.map((line) => line.rect),
    });
  });

  const bodyFontSize = (bodyHeight * toPointsY) / BOX_OVER_FONT_SIZE;
  const chars = pageText.replace(/\s/gu, '').length;
  return {
    confidence: weightedConfidence(lines),
    text: pageText,
    blocks,
    charCount: chars,
    fontStats: {
      bodyFontSize,
      medianLeading: leading * toPointsY,
      sizes: lines.length === 0 ? [] : [{ size: bodyFontSize, chars }],
      fontNames: [],
    },
    quality: computeQuality(pageText, { chars: pageText.length, unmapped: 0, controls: 0 }, []),
  };
}

/**
 * The page text of an engine that returns text only (Gemini): paragraphs are the blocks separated by blank lines, the
 * printed lines of a paragraph are its lines (so that line-break hyphenation is undone like everywhere else), and
 * every line's rectangle is the whole page: there are no boxes, so a highlight is the page. Text is cleaned like
 * extracted text; lines with no letter or digit (rules, ornaments) are dropped.
 */
function buildPlainPageText(result: OcrResult, geometry: OcrPageGeometry): OcrPageText {
  const blocks: TextBlock[] = [];
  let pageText = '';
  const fullPage = { x: 0, y: 0, w: 1, h: 1 };
  for (const paragraph of result.text.replace(/\r\n?/gu, '\n').split(/\n[^\S\n]*\n\s*/u)) {
    const texts = paragraph
      .split('\n')
      .map(normalizeLine)
      .filter((text) => HAS_CONTENT.test(text));
    if (texts.length === 0) continue;
    const joined = joinLines(texts);
    const blockStart = pageText.length === 0 ? 0 : pageText.length + 2;
    if (pageText.length > 0) pageText += '\n\n';
    pageText += joined.text;
    const lines: TextLine[] = texts.map((text, index) => {
      const range = joined.ranges[index] ?? { start: 0, end: 0 };
      return {
        text,
        direction: dominantDirection(text),
        baseline: geometry.pageHeight,
        fontSize: 0,
        bold: false,
        x0: 0,
        x1: geometry.pageWidth,
        top: 0,
        bottom: geometry.pageHeight,
        rect: { ...fullPage },
        charStart: blockStart + range.start,
        charEnd: blockStart + range.end,
        tabular: false,
      };
    });
    blocks.push({
      index: blocks.length,
      text: joined.text,
      charStart: blockStart,
      charEnd: blockStart + joined.text.length,
      lines,
      isHeading: false,
      fontSize: 0,
      bold: false,
      direction: dominantDirection(joined.text),
      rects: lines.map((line) => line.rect),
    });
  }
  const chars = pageText.replace(/\s/gu, '').length;
  return {
    confidence: null,
    text: pageText,
    blocks,
    charCount: chars,
    fontStats: { bodyFontSize: 0, medianLeading: 0, sizes: [], fontNames: [] },
    quality: computeQuality(pageText, { chars: pageText.length, unmapped: 0, controls: 0 }, []),
  };
}
