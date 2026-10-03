import {
  dominantDirection,
  normalizeForSearch,
  type Direction,
  type NormalizedRect,
} from '@enchanted/shared';
import { sentenceSpans, splitLongSpan, type Span } from './sentences.js';
import { estimateTokens } from './tokens.js';

/*
 * Page-aware semantic chunking. A chunk is a range of the text of ONE page (or, for a paragraph that runs on
 * to the next page, two ranges), so its page numbers, its character offsets and its highlight rectangles are
 * exact. Chunks are built from whole blocks (paragraphs, headings), split at sentence boundaries only when a
 * block alone is too long.
 */

export interface ChunkLineInput {
  charStart: number;
  charEnd: number;
  rect: NormalizedRect;
}

export interface ChunkBlockInput {
  text: string;
  /** Where the block sits in the page text. */
  charStart: number;
  charEnd: number;
  isHeading: boolean;
  /** The title to use for a heading (the PDF outline's), when it differs from the block text. */
  headingTitle?: string | undefined;
  /**
   * Starts a new section with this title although the block is ordinary text: an outline entry that points at
   * a page without a recognisable heading on it.
   */
  sectionStart?: string | undefined;
  language?: string | undefined;
  lines: readonly ChunkLineInput[];
}

export interface ChunkPageInput {
  pageNumber: number;
  /** The page text blocks refer to. */
  text: string;
  language: string;
  blocks: readonly ChunkBlockInput[];
}

export interface ChunkingOptions {
  targetChars: number;
  maxChars: number;
  minChars: number;
  /** Characters of whole trailing sentences of the previous chunk repeated at the start of the next; 0 disables. */
  overlapChars: number;
  /** Largest content, in tokens as `countTokens` counts them. Defaults to no limit. */
  maxTokens?: number;
  countTokens?: (text: string) => number;
}

export interface ChunkHighlight {
  page: number;
  rects: NormalizedRect[];
  /** The part of that page's text the chunk covers. */
  charStart: number;
  charEnd: number;
}

export interface Chunk {
  index: number;
  pageStart: number;
  pageEnd: number;
  sectionTitle: string | null;
  language: string;
  direction: Direction;
  /** Overlap (if any) followed by the chunk's own text: what is embedded and what a model reads. */
  content: string;
  /** Normalised own text for lexical search. */
  searchText: string;
  /** Own text only: offset in the text of `pageStart` where it starts, and in the text of `pageEnd` where it ends. */
  charStart: number;
  charEnd: number;
  /** Length of the overlap prefix of `content`; `content.slice(overlapChars)` is the own text. */
  overlapChars: number;
  tokenCount: number;
  highlights: ChunkHighlight[];
}

const SECTION_TITLE_MAX_CHARS = 160;
const TERMINAL_PUNCTUATION = /[.!?؟。！？…]["'”’)\]»]*$/u;
/** A line that is a page number and nothing else: `12`, `- 12 -`, `Page 12`, `12 / 40`, `صفحة ١٢`. */
const PAGE_NUMBER_LINE =
  /^[\s\p{P}\p{S}]*(?:(?:page|pg|p|صفحة|ص)[\s.:]*)?\p{Nd}{1,4}(?:\s*(?:\/|of|من)\s*\p{Nd}{1,4})?[\s\p{P}\p{S}]*$/iu;
/** A running footer or header with the page number at one end, set off by a separator: `The Blue Ledger | 12`, `14 — Saltmarsh`. */
const RUNNING_FOOTER_LINE = /^(?:.{0,40}[|—–·•/-]\s*\p{Nd}{1,4}|\p{Nd}{1,4}\s*[|—–·•/-].{0,40})$/u;
/** The longest line that can be page furniture. */
const PAGE_FURNITURE_MAX_CHARS = 48;

/**
 * Whether a block's text ends where a paragraph ends: with terminal punctuation, or with a short line of page furniture (a
 * page number, a running footer). OCR transcribes those, so a scanned page usually ends on a line with no punctuation, and
 * without this rule nearly every scanned page would be taken for a paragraph that goes on over the page break.
 */
function endsParagraph(text: string): boolean {
  const trimmed = text.trimEnd();
  if (TERMINAL_PUNCTUATION.test(trimmed)) return true;
  const lastLine = (trimmed.split('\n').at(-1) ?? '').trim();
  return (
    lastLine.length <= PAGE_FURNITURE_MAX_CHARS &&
    (PAGE_NUMBER_LINE.test(lastLine) || RUNNING_FOOTER_LINE.test(lastLine))
  );
}
/** A blank line separates blocks in the page text; chunks that span blocks keep it. */
const BLOCK_SEPARATOR = '\n\n';
const MAX_RECTS_PER_SPAN = 60;

interface Unit {
  page: ChunkPageInput;
  span: Span;
  isHeading: boolean;
  /** Section title this unit starts: a heading's text, or the block's `sectionStart`. */
  title: string | null;
  language: string;
  lines: readonly ChunkLineInput[];
  /** First unit of its block / last unit of its block / first block of its page. */
  startsBlock: boolean;
  firstOnPage: boolean;
  /** The block's text ends a sentence. */
  endsSentence: boolean;
}

interface Segment {
  page: ChunkPageInput;
  start: number;
  end: number;
}

interface Draft {
  section: string | null;
  segments: Segment[];
  units: Unit[];
  /** Flush after the unit just added (a paragraph that ran over a page break ends the chunk). */
  closed: boolean;
}

const collapse = (text: string): string => text.replace(/\s+/gu, ' ').trim();

/**
 * Splits a document's pages into chunks. See the module comment; the rules, in order:
 *  - a heading starts a new chunk and sets the section title carried until the next heading;
 *  - whole blocks are packed until `targetChars` would be exceeded; no chunk exceeds `maxChars` (or `maxTokens`);
 *  - a block longer than that is split at sentence boundaries (then clauses, words);
 *  - a chunk never crosses a page, except one paragraph that continues (the last block of the page does not end
 *    a sentence and the next page opens with a non-heading block);
 *  - a chunk shorter than `minChars` joins the previous chunk of the same page and section;
 *  - `overlapChars` of whole trailing sentences of the previous chunk of the same section are prepended.
 */
export function chunkDocument(pages: readonly ChunkPageInput[], options: ChunkingOptions): Chunk[] {
  const count = options.countTokens ?? estimateTokens;
  const maxTokens = options.maxTokens ?? Number.POSITIVE_INFINITY;
  const fits = (text: string): boolean => text.length <= options.maxChars && count(text) <= maxTokens;
  const drafts = packUnits(buildUnits(pages, options, fits), options, fits);
  const merged = mergeSmall(drafts, options, fits);
  return finalize(merged, options, count, maxTokens);
}

// ---------------------------------------------------------------------------------------------------
// Units: blocks, with the long ones cut into sentence-sized pieces
// ---------------------------------------------------------------------------------------------------

function buildUnits(
  pages: readonly ChunkPageInput[],
  options: ChunkingOptions,
  fits: (text: string) => boolean,
): Unit[] {
  const units: Unit[] = [];
  for (const page of pages) {
    page.blocks.forEach((block, blockIndex) => {
      if (block.text.trim() === '') return;
      const language = block.language ?? page.language;
      const whole: Span = { start: block.charStart, end: block.charEnd };
      // A heading is split like any other block when it does not fit (an outline title that matches the start of a
      // long paragraph must not let that paragraph through whole); its first piece keeps the title.
      const spans = fits(block.text)
        ? [whole]
        : splitBlock(block.text, language, options, fits).map((span) => ({
            start: block.charStart + span.start,
            end: block.charStart + span.end,
          }));
      spans.forEach((span, pieceIndex) => {
        units.push({
          page,
          span,
          isHeading: block.isHeading && pieceIndex === 0,
          title:
            pieceIndex > 0
              ? null
              : block.isHeading
                ? collapse(block.headingTitle ?? block.text).slice(0, SECTION_TITLE_MAX_CHARS)
                : block.sectionStart !== undefined
                  ? collapse(block.sectionStart).slice(0, SECTION_TITLE_MAX_CHARS)
                  : null,
          language,
          lines: block.lines,
          startsBlock: pieceIndex === 0,
          firstOnPage: blockIndex === 0 && pieceIndex === 0,
          endsSentence: endsParagraph(block.text),
        });
      });
    });
  }
  return units;
}

/** Sentence-sized pieces of an oversized block, each fitting the limits, packed up to the target size. */
function splitBlock(
  text: string,
  language: string,
  options: ChunkingOptions,
  fits: (text: string) => boolean,
): Span[] {
  const sentences = sentenceSpans(text, language).flatMap((span) =>
    splitLongSpan(text, span, fits, options.maxChars),
  );
  const pieces: Span[] = [];
  let current: Span | null = null;
  for (const sentence of sentences) {
    if (current === null) {
      current = { ...sentence };
      continue;
    }
    const candidate: Span = { start: current.start, end: sentence.end };
    if (
      candidate.end - candidate.start > options.targetChars ||
      !fits(text.slice(candidate.start, candidate.end))
    ) {
      pieces.push(current);
      current = { ...sentence };
    } else {
      current = candidate;
    }
  }
  if (current !== null) pieces.push(current);
  return pieces;
}

// ---------------------------------------------------------------------------------------------------
// Packing
// ---------------------------------------------------------------------------------------------------

function textOf(segments: readonly Segment[]): string {
  return segments.map((segment) => segment.page.text.slice(segment.start, segment.end)).join(BLOCK_SEPARATOR);
}

/** A copy of the draft's segments with `unit` added (extending the last one when it is on the same page). */
function withUnit(segments: readonly Segment[], unit: Unit): Segment[] {
  const last = segments[segments.length - 1];
  if (last?.page === unit.page) {
    return [...segments.slice(0, -1), { ...last, end: Math.max(last.end, unit.span.end) }];
  }
  return [...segments, { page: unit.page, start: unit.span.start, end: unit.span.end }];
}

function packUnits(
  units: readonly Unit[],
  options: ChunkingOptions,
  fits: (text: string) => boolean,
): Draft[] {
  const drafts: Draft[] = [];
  let current: Draft | null = null;
  let section: string | null = null;

  const open = (unit: Unit): Draft => {
    const draft: Draft = {
      section,
      segments: [{ page: unit.page, start: unit.span.start, end: unit.span.end }],
      units: [unit],
      closed: false,
    };
    drafts.push(draft);
    return draft;
  };

  for (const unit of units) {
    if (unit.title !== null) {
      section = unit.title;
      current = open(unit);
      continue;
    }
    if (current === null) {
      current = open(unit);
      continue;
    }
    const previous: Unit | undefined = current.units[current.units.length - 1];
    const candidate = withUnit(current.segments, unit);
    const candidateText = textOf(candidate);
    if (previous !== undefined && previous.page !== unit.page) {
      // A paragraph that runs over the page break (or a heading at the foot of the page that is followed by its
      // text) stays in one chunk; nothing else crosses a page.
      const continues = !previous.endsSentence && unit.firstOnPage && fits(candidateText);
      if (continues) {
        current.segments = candidate;
        current.units.push(unit);
        current.closed = true;
      } else {
        current = open(unit);
      }
      continue;
    }
    const tooBig = candidateText.length > options.targetChars || !fits(candidateText);
    if (current.closed || tooBig) {
      current = open(unit);
    } else {
      current.segments = candidate;
      current.units.push(unit);
    }
  }
  return drafts;
}

/** A chunk smaller than minChars joins the previous chunk when both are in the same section and on the same page. */
function mergeSmall(drafts: Draft[], options: ChunkingOptions, fits: (text: string) => boolean): Draft[] {
  const result: Draft[] = [];
  for (const draft of drafts) {
    const previous = result[result.length - 1];
    const small = textOf(draft.segments).length < options.minChars;
    const samePage =
      previous !== undefined &&
      draft.segments.length === 1 &&
      previous.segments.length === 1 &&
      previous.segments[0]?.page === draft.segments[0]?.page;
    if (
      previous !== undefined &&
      small &&
      samePage &&
      previous.section === draft.section &&
      draft.units[0]?.title === null
    ) {
      const candidate: Segment[] = draft.units.reduce<Segment[]>(
        (segments, unit) => withUnit(segments, unit),
        previous.segments,
      );
      if (fits(textOf(candidate))) {
        previous.segments = candidate;
        previous.units.push(...draft.units);
        continue;
      }
    }
    result.push(draft);
  }
  return result;
}

// ---------------------------------------------------------------------------------------------------
// Final chunks: text, overlap, language, highlights
// ---------------------------------------------------------------------------------------------------

function finalize(
  drafts: readonly Draft[],
  options: ChunkingOptions,
  count: (text: string) => number,
  maxTokens: number,
): Chunk[] {
  const chunks: Chunk[] = [];
  let previousOwn = '';
  let previousLanguage = 'und';
  let previousSection: string | null | undefined;

  drafts.forEach((draft, index) => {
    const own = textOf(draft.segments);
    const first = draft.segments[0];
    const last = draft.segments[draft.segments.length - 1];
    if (first === undefined || last === undefined) return;

    let overlap = '';
    if (options.overlapChars > 0 && index > 0 && previousSection === draft.section) {
      overlap = trailingSentences(previousOwn, previousLanguage, options.overlapChars);
      // The overlap must not push the chunk over its limits.
      while (
        overlap !== '' &&
        !withinLimits(`${overlap}${BLOCK_SEPARATOR}${own}`, options, count, maxTokens)
      ) {
        overlap = dropFirstSentence(overlap, previousLanguage);
      }
    }
    const prefix = overlap === '' ? '' : `${overlap}${BLOCK_SEPARATOR}`;
    const language = majorityLanguage(draft.units);

    chunks.push({
      index: chunks.length,
      pageStart: first.page.pageNumber,
      pageEnd: last.page.pageNumber,
      sectionTitle: draft.section,
      language,
      direction: dominantDirection(own),
      content: `${prefix}${own}`,
      searchText: normalizeForSearch(own),
      charStart: first.start,
      charEnd: last.end,
      overlapChars: prefix.length,
      tokenCount: count(`${prefix}${own}`),
      highlights: highlightsFor(draft),
    });
    previousOwn = own;
    previousLanguage = language;
    previousSection = draft.section;
  });
  return chunks;
}

function withinLimits(
  text: string,
  options: ChunkingOptions,
  count: (text: string) => number,
  maxTokens: number,
): boolean {
  return text.length <= options.maxChars && count(text) <= maxTokens;
}

/** The longest run of whole sentences at the end of `text` that is at most `limit` characters long. */
function trailingSentences(text: string, language: string, limit: number): string {
  const spans = sentenceSpans(text, language);
  let start = text.length;
  for (let i = spans.length - 1; i >= 0; i -= 1) {
    const span = spans[i];
    if (span === undefined || text.length - span.start > limit) break;
    start = span.start;
  }
  return start >= text.length ? '' : text.slice(start).trim();
}

function dropFirstSentence(overlap: string, language: string): string {
  const spans = sentenceSpans(overlap, language);
  const second = spans[1];
  return second === undefined ? '' : overlap.slice(second.start).trim();
}

/** The language with the most letters among the chunk's blocks; `und` only when nothing else is known. */
function majorityLanguage(units: readonly Unit[]): string {
  const letters = new Map<string, number>();
  for (const unit of units) {
    const text = unit.page.text.slice(unit.span.start, unit.span.end);
    letters.set(unit.language, (letters.get(unit.language) ?? 0) + (text.match(/\p{L}/gu)?.length ?? 0));
  }
  let best = 'und';
  let bestLetters = -1;
  for (const [language, n] of letters) {
    if (language === 'und') continue;
    if (n > bestLetters) {
      best = language;
      bestLetters = n;
    }
  }
  return best;
}

function union(rects: readonly NormalizedRect[]): NormalizedRect {
  const x0 = Math.min(...rects.map((rect) => rect.x));
  const y0 = Math.min(...rects.map((rect) => rect.y));
  const x1 = Math.max(...rects.map((rect) => rect.x + rect.w));
  const y1 = Math.max(...rects.map((rect) => rect.y + rect.h));
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/** One entry per page the chunk touches: the lines (as rectangles) that overlap the chunk's range on that page. */
function highlightsFor(draft: Draft): ChunkHighlight[] {
  return draft.segments.map((segment) => {
    const seen = new Set<ChunkLineInput>();
    const lines: ChunkLineInput[] = [];
    for (const unit of draft.units) {
      if (unit.page !== segment.page) continue;
      for (const line of unit.lines) {
        if (seen.has(line) || line.charEnd <= segment.start || line.charStart >= segment.end) continue;
        seen.add(line);
        lines.push(line);
      }
    }
    // Text read without boxes (Gemini) has the whole page as the rectangle of every line: one rectangle says it.
    const distinct = new Map<string, NormalizedRect>();
    for (const line of lines) {
      const { x, y, w, h } = line.rect;
      distinct.set(`${String(x)},${String(y)},${String(w)},${String(h)}`, line.rect);
    }
    let rects = [...distinct.values()];
    if (rects.length > MAX_RECTS_PER_SPAN) rects = [union(rects)];
    return { page: segment.page.pageNumber, rects, charStart: segment.start, charEnd: segment.end };
  });
}

// ---------------------------------------------------------------------------------------------------
// The embedding window
// ---------------------------------------------------------------------------------------------------

export interface TokenWindow {
  /** The longest input the embedding model reads, counted the way `countTokens` counts (prefix and markers included). */
  maxTokens: number;
  /** The model's own tokenizer, synchronously. */
  countTokens: (text: string) => number;
}

/** The blocks of `page` cut to the range [from, to) of the page text, as plain blocks. */
function clipBlocks(page: ChunkPageInput, from: number, to: number): ChunkBlockInput[] {
  const clipped: ChunkBlockInput[] = [];
  for (const block of page.blocks) {
    const start = Math.max(block.charStart, from);
    const end = Math.min(block.charEnd, to);
    if (end <= start) continue;
    clipped.push({
      ...block,
      text: page.text.slice(start, end),
      charStart: start,
      charEnd: end,
      isHeading: false,
      headingTitle: undefined,
      sectionStart: undefined,
    });
  }
  return clipped;
}

/**
 * One chunk that is too long for the embedding window, cut into chunks that are not: its own text (every page range
 * it covers) is chunked again with the exact token counter, so the pieces break at sentence boundaries, keep exact
 * offsets and highlights, carry the same section and get the usual overlap. The first piece keeps the chunk's own
 * overlap prefix when that still fits.
 */
function splitOversizedChunk(
  chunk: Chunk,
  pages: readonly ChunkPageInput[],
  options: ChunkingOptions,
  window: TokenWindow,
): Chunk[] {
  const mini: ChunkPageInput[] = [];
  for (const span of chunk.highlights) {
    const page = pages.find((candidate) => candidate.pageNumber === span.page);
    if (page === undefined) return [chunk];
    const blocks = clipBlocks(page, span.charStart, span.charEnd);
    const [first] = blocks;
    if (first !== undefined && mini.length === 0) first.sectionStart = chunk.sectionTitle ?? undefined;
    mini.push({ ...page, blocks });
  }
  const pieces = chunkDocument(mini, {
    ...options,
    countTokens: window.countTokens,
    maxTokens: window.maxTokens,
  });
  const [head] = pieces;
  if (head === undefined) return [chunk];
  if (chunk.overlapChars > 0) {
    const prefix = chunk.content.slice(0, chunk.overlapChars);
    const content = `${prefix}${head.content}`;
    if (content.length <= options.maxChars && window.countTokens(content) <= window.maxTokens) {
      pieces[0] = {
        ...head,
        content,
        overlapChars: prefix.length + head.overlapChars,
        tokenCount: window.countTokens(content),
      };
    }
  }
  return pieces.map((piece) => ({ ...piece, sectionTitle: chunk.sectionTitle }));
}

/**
 * Guarantees that no chunk is longer than the embedding model's input window. The chunker works with an estimate
 * (it runs where the tokenizer is not loaded); with the real counter in hand this splits every chunk that is still
 * too long (an estimate is wrong for Arabic-Indic digits, URLs, formulas, emoji), instead of letting the model
 * silently drop its tail. Chunks that fit are returned untouched; the result is renumbered.
 */
export function enforceTokenWindow(
  chunks: readonly Chunk[],
  pages: readonly ChunkPageInput[],
  options: ChunkingOptions,
  window: TokenWindow,
): Chunk[] {
  const result: Chunk[] = [];
  for (const chunk of chunks) {
    if (window.countTokens(chunk.content) <= window.maxTokens) result.push(chunk);
    else result.push(...splitOversizedChunk(chunk, pages, options, window));
  }
  return result.map((chunk, index) => ({ ...chunk, index }));
}
