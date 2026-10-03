import { dominantDirection, type Direction, type NormalizedRect } from '@enchanted/shared';
import { joinLines, normalizeLine } from '../text/normalize.js';
import { assembleLine, baseDirectionOf, directionalCounts, edgeDirection } from './assemble-line.js';
import type { FontStats, PositionedItem, TextBlock, TextLine } from './types.js';

/*
 * From positioned text items to lines, blocks and headings. Pure functions over the items: the pdf.js part is
 * in extract-page.ts.
 */

/** Lines on the same baseline within this share of the smaller font size belong together. */
const BASELINE_TOLERANCE = 0.5;
/** A line further below the previous one than this many times the page's leading starts a new block... */
export const PARAGRAPH_ADVANCE_RATIO = 1.4;
/** ...and, for a bold line to count as a heading, this many (review item I9: "gap above >= 1.5 line heights"). */
export const HEADING_ADVANCE_RATIO = 1.5;
/** A change of the font size by more than this ratio starts a new block. */
const FONT_SIZE_CHANGE_RATIO = 1.15;
export const HEADING_FONT_RATIO = 1.2;
export const HEADING_MAX_LINES = 2;
export const HEADING_MAX_CHARS = 120;
const HEADING_SHORT_LINE_RATIO = 0.6;
/** Items further apart than this many font sizes make the line a table row, which is never a heading. */
const TABULAR_GAP_EM = 3;
const DEFAULT_LEADING_EM = 1.2;
const MIN_LEADING_EM = 0.9;
/**
 * The page's normal line spacing is a LOW quantile of the distances between consecutive lines, not the median:
 * in a text with many short paragraphs half of the distances include paragraph spacing.
 */
const LEADING_QUANTILE = 0.25;

/**
 * "Chapter 3", "الفصل الأول", "مقدمة": a line that starts like this is a heading even in body-size type. `\b`
 * does not work for Arabic (its letters are not word characters in JavaScript), so the boundary is spelled out.
 */
export const HEADING_PATTERN =
  /^(?:chapter|part|section|appendix|الفصل|الباب|المبحث|مقدمة|خاتمة)(?![\p{L}\p{N}_])/iu;
/** "1. ", "2) ", "(3) ", "• ", "- ", with Arabic-Indic and Persian digits too. */
export const LIST_MARKER = /^(?:\(?[0-9٠-٩۰-۹]+[.)]\s|[•●▪◦*\-–—]\s)/u;

const median = (values: number[]): number => {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? (sorted[mid] ?? 0) : ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
};

function quantile(values: number[], q: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(q * (sorted.length - 1))] ?? 0;
}

/** Fractions of the page, origin top-left, clamped so that x+w and y+h stay within 1. */
export function toNormalizedRect(
  x0: number,
  top: number,
  x1: number,
  bottom: number,
  width: number,
  height: number,
): NormalizedRect {
  const clamp = (value: number): number => Math.min(1, Math.max(0, value));
  const x = clamp(x0 / width);
  const y = clamp(top / height);
  return {
    x,
    y,
    w: Math.min(clamp(x1 / width) - x, 1 - x),
    h: Math.min(clamp(bottom / height) - y, 1 - y),
  };
}

interface GeometricLine {
  items: PositionedItem[];
  baseline: number;
  fontSize: number;
  x0: number;
  x1: number;
  top: number;
  bottom: number;
  horizontal: boolean;
  chars: number;
}

function dominantFontSize(items: readonly PositionedItem[]): number {
  const bySize = new Map<number, number>();
  for (const item of items) {
    const key = Math.round(item.fontSize * 10) / 10;
    bySize.set(key, (bySize.get(key) ?? 0) + item.text.length);
  }
  let best = items[0]?.fontSize ?? 0;
  let bestChars = -1;
  for (const [size, chars] of bySize) {
    if (chars > bestChars) {
      best = size;
      bestChars = chars;
    }
  }
  return best;
}

function makeLine(items: PositionedItem[], horizontal: boolean): GeometricLine {
  return {
    items,
    baseline: median(items.map((item) => item.baseline)),
    fontSize: dominantFontSize(items),
    x0: Math.min(...items.map((item) => item.x0)),
    x1: Math.max(...items.map((item) => item.x1)),
    top: Math.min(...items.map((item) => item.top)),
    bottom: Math.max(...items.map((item) => item.bottom)),
    horizontal,
    chars: items.reduce((sum, item) => sum + item.text.length, 0),
  };
}

/** Groups items into visual lines by baseline. Items of rotated text are a line each, after the horizontal ones. */
export function groupLines(items: readonly PositionedItem[]): GeometricLine[] {
  const horizontal = items
    .filter((item) => item.horizontal)
    .sort((a, b) => a.baseline - b.baseline || a.x0 - b.x0);
  const groups: { baseline: number; fontSize: number; items: PositionedItem[] }[] = [];
  for (const item of horizontal) {
    let target: (typeof groups)[number] | undefined;
    // Sorted by baseline: only the most recent groups can still be within tolerance.
    for (let i = groups.length - 1; i >= 0; i -= 1) {
      const group = groups[i];
      if (group === undefined) continue;
      const tolerance = BASELINE_TOLERANCE * Math.min(group.fontSize, item.fontSize);
      if (Math.abs(group.baseline - item.baseline) <= tolerance) {
        target = group;
        break;
      }
      if (item.baseline - group.baseline > 2 * Math.max(group.fontSize, item.fontSize)) break;
    }
    if (target === undefined) {
      groups.push({ baseline: item.baseline, fontSize: item.fontSize, items: [item] });
    } else {
      target.items.push(item);
    }
  }
  const lines = groups.map((group) => makeLine(group.items, true)).sort((a, b) => a.baseline - b.baseline);
  const rotated = items
    .filter((item) => !item.horizontal)
    .sort((a, b) => a.x0 - b.x0 || a.top - b.top)
    .map((item) => makeLine([item], false));
  return [...lines, ...rotated];
}

/** The size of the body text: the font size with the most characters. */
export function fontStatsOf(lines: readonly GeometricLine[], fontNames: readonly string[]): FontStats {
  const bySize = new Map<number, number>();
  for (const line of lines) {
    const key = Math.round(line.fontSize * 10) / 10;
    bySize.set(key, (bySize.get(key) ?? 0) + line.chars);
  }
  const sizes = [...bySize.entries()]
    .map(([size, chars]) => ({ size, chars }))
    .sort((a, b) => b.chars - a.chars);
  const bodyFontSize = sizes[0]?.size ?? 0;
  const horizontal = lines.filter((line) => line.horizontal);
  const advances: number[] = [];
  for (let i = 1; i < horizontal.length; i += 1) {
    const advance = (horizontal[i]?.baseline ?? 0) - (horizontal[i - 1]?.baseline ?? 0);
    if (advance > 0.2 * bodyFontSize) advances.push(advance);
  }
  const leading =
    advances.length >= 2
      ? Math.max(quantile(advances, LEADING_QUANTILE), MIN_LEADING_EM * bodyFontSize)
      : bodyFontSize * DEFAULT_LEADING_EM;
  return { bodyFontSize, medianLeading: leading, sizes, fontNames: [...fontNames] };
}

/** Indices of the lines where a new provisional block starts (geometry only: no text is needed). */
function geometricBreaks(lines: readonly GeometricLine[], leading: number): Set<number> {
  const breaks = new Set<number>([0]);
  for (let i = 1; i < lines.length; i += 1) {
    const previous = lines[i - 1];
    const current = lines[i];
    if (previous === undefined || current === undefined) continue;
    if (!current.horizontal || !previous.horizontal) {
      breaks.add(i);
      continue;
    }
    const advance = current.baseline - previous.baseline;
    const sizeRatio =
      Math.max(current.fontSize, previous.fontSize) /
      Math.max(1e-6, Math.min(current.fontSize, previous.fontSize));
    if (advance > PARAGRAPH_ADVANCE_RATIO * leading || sizeRatio > FONT_SIZE_CHANGE_RATIO) breaks.add(i);
  }
  return breaks;
}

export interface LayoutResult {
  lines: TextLine[];
  blocks: TextBlock[];
  text: string;
  fontStats: FontStats;
}

export interface LayoutOptions {
  pageWidth: number;
  pageHeight: number;
  fontNames?: readonly string[];
}

/** True when the line has a wide internal gap: a table row, never a heading. */
export function isTabular(
  items: readonly { text: string; x0: number; x1: number; fontSize: number }[],
): boolean {
  const sorted = [...items].filter((item) => item.text.trim() !== '').sort((a, b) => a.x0 - b.x0);
  for (let i = 1; i < sorted.length; i += 1) {
    const previous = sorted[i - 1];
    const current = sorted[i];
    if (previous === undefined || current === undefined) continue;
    if (current.x0 - previous.x1 > TABULAR_GAP_EM * Math.max(previous.fontSize, current.fontSize))
      return true;
  }
  return false;
}

interface DraftLine {
  geometric: GeometricLine;
  text: string;
  direction: Direction;
  bold: boolean;
  tabular: boolean;
}

/**
 * Lays out the items of one page: visual lines, logical line text (with the paragraph direction decided per
 * block, so an English paragraph with a long Arabic phrase is still read left to right), blocks, headings and
 * the page text with offsets.
 */
export function layoutPage(items: readonly PositionedItem[], options: LayoutOptions): LayoutResult {
  const geometric = groupLines(items);
  const fontStats = fontStatsOf(geometric, options.fontNames ?? []);
  const leading = fontStats.medianLeading;
  const breaks = geometricBreaks(geometric, leading);
  const pageBase = baseDirectionOf(geometric.flatMap((line) => line.items)) ?? 'ltr';

  // Pass 1: assemble the text of every line with its provisional block's direction.
  const drafts: DraftLine[] = [];
  let blockStart = 0;
  for (let i = 0; i <= geometric.length; i += 1) {
    if (i < geometric.length && !(breaks.has(i) && i > blockStart)) continue;
    const group = geometric.slice(blockStart, i);
    const blockDirection = baseDirectionOf(group.flatMap((line) => line.items)) ?? pageBase;
    for (const line of group) {
      // A line whose two ends agree is a paragraph in that direction; otherwise the block decides.
      const direction = edgeDirection(line.items) ?? blockDirection;
      const text = normalizeLine(assembleLine(line.items, direction));
      if (text === '') continue;
      const boldChars = line.items.reduce((sum, item) => sum + (item.bold ? item.text.length : 0), 0);
      drafts.push({
        geometric: line,
        text,
        direction,
        bold: line.chars > 0 && boldChars / line.chars >= 0.8,
        tabular: isTabular(line.items),
      });
    }
    blockStart = i;
  }

  const widths = drafts.map((draft) => draft.geometric.x1 - draft.geometric.x0).sort((a, b) => a - b);
  const bodyWidth = widths[Math.floor(0.75 * (widths.length - 1))] ?? 0;

  // Pass 2: blocks by geometry, bold change and heading-looking lines (which stand alone).
  const groups: DraftLine[][] = [];
  for (let i = 0; i < drafts.length; i += 1) {
    const draft = drafts[i];
    if (draft === undefined) continue;
    const previous = drafts[i - 1];
    let startsBlock = i === 0 || previous === undefined;
    if (!startsBlock && previous !== undefined) {
      startsBlock =
        !draft.geometric.horizontal ||
        !previous.geometric.horizontal ||
        draft.geometric.baseline - previous.geometric.baseline > PARAGRAPH_ADVANCE_RATIO * leading ||
        Math.max(draft.geometric.fontSize, previous.geometric.fontSize) /
          Math.max(1e-6, Math.min(draft.geometric.fontSize, previous.geometric.fontSize)) >
          FONT_SIZE_CHANGE_RATIO ||
        draft.bold !== previous.bold ||
        standsAlone(previous, bodyWidth) ||
        standsAlone(draft, bodyWidth);
    }
    if (startsBlock) groups.push([draft]);
    else groups[groups.length - 1]?.push(draft);
  }

  const lines: TextLine[] = [];
  const blocks: TextBlock[] = [];
  let pageText = '';
  groups.forEach((group, index) => {
    const joined = joinLines(group.map((draft) => draft.text));
    const blockStartOffset = pageText.length === 0 ? 0 : pageText.length + 2;
    if (pageText.length > 0) pageText += '\n\n';
    pageText += joined.text;
    const blockLines: TextLine[] = group.map((draft, lineIndex) => {
      const range = joined.ranges[lineIndex] ?? { start: 0, end: 0 };
      const g = draft.geometric;
      return {
        text: draft.text,
        direction: draft.direction,
        baseline: g.baseline,
        fontSize: g.fontSize,
        bold: draft.bold,
        x0: g.x0,
        x1: g.x1,
        top: g.top,
        bottom: g.bottom,
        rect: toNormalizedRect(g.x0, g.top, g.x1, g.bottom, options.pageWidth, options.pageHeight),
        charStart: blockStartOffset + range.start,
        charEnd: blockStartOffset + range.end,
        tabular: draft.tabular,
      };
    });
    lines.push(...blockLines);
    const first = group[0];
    blocks.push({
      index,
      text: joined.text,
      charStart: blockStartOffset,
      charEnd: blockStartOffset + joined.text.length,
      lines: blockLines,
      isHeading: false,
      fontSize: first?.geometric.fontSize ?? 0,
      bold: group.every((draft) => draft.bold),
      direction: dominantDirection(joined.text),
      rects: blockLines.map((line) => line.rect),
    });
  });

  markHeadings(blocks, groups, fontStats);
  return { lines, blocks, text: pageText, fontStats };
}

/**
 * A SHORT line that opens with "Chapter", "الفصل", ... is cut out of the paragraph that follows it without a gap:
 * it is a heading, not text. Short means at most 60% of the usual line width: the first line of a paragraph that
 * merely starts with "Section 4 of the law ..." runs the full width and stays in its paragraph.
 */
function standsAlone(draft: DraftLine, bodyWidth: number): boolean {
  const width = draft.geometric.x1 - draft.geometric.x0;
  return (
    draft.text.length <= HEADING_MAX_CHARS &&
    HEADING_PATTERN.test(draft.text) &&
    width <= HEADING_SHORT_LINE_RATIO * bodyWidth
  );
}

/** The heading predicate of review item I9, per block. */
function markHeadings(blocks: TextBlock[], groups: DraftLine[][], stats: FontStats): void {
  const markerLine = (draft: DraftLine | undefined): boolean =>
    draft !== undefined && LIST_MARKER.test(draft.text);
  const flat = groups.flat();
  blocks.forEach((block, index) => {
    const group = groups[index] ?? [];
    const first = group[0];
    if (
      first === undefined ||
      block.lines.length > HEADING_MAX_LINES ||
      block.text.length > HEADING_MAX_CHARS
    )
      return;
    if (!/[\p{L}\p{N}]/u.test(block.text) || group.some((draft) => draft.tabular)) return;
    // Consecutive list-marker lines are a list, never a heading.
    const at = flat.indexOf(first);
    if (markerLine(first) && (markerLine(flat[at - 1]) || markerLine(flat[at + group.length]))) return;

    const previousBlockLine = groups[index - 1]?.at(-1);
    const advance =
      previousBlockLine === undefined
        ? Infinity
        : first.geometric.baseline - previousBlockLine.geometric.baseline;
    const bigFont = stats.bodyFontSize > 0 && block.fontSize >= HEADING_FONT_RATIO * stats.bodyFontSize;
    const boldWithGap = block.bold && advance >= HEADING_ADVANCE_RATIO * stats.medianLeading;
    const named = HEADING_PATTERN.test(block.text);
    block.isHeading = bigFont || boldWithGap || named;
  });
}

/** True when a line of the page is probably a numbered or bulleted list entry. */
export function isListMarkerLine(text: string): boolean {
  return LIST_MARKER.test(text);
}

/** How many characters of the text read right to left (used by quality checks and tests). */
export function rtlLetterCount(text: string): number {
  return directionalCounts(text).rtl;
}
