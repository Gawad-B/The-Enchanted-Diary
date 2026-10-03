/*
 * Sentence and clause boundaries for splitting text that is too long for one chunk, and for choosing the
 * sentences that overlap two chunks. Offsets always refer to the text that was passed in.
 */

export interface Span {
  start: number;
  end: number;
}

const segmenters = new Map<string, Intl.Segmenter>();

function segmenterFor(language: string): Intl.Segmenter {
  const locale = /^[a-z]{2,3}$/.test(language) ? language : 'en';
  let segmenter = segmenters.get(locale);
  if (segmenter === undefined) {
    try {
      segmenter = new Intl.Segmenter(locale, { granularity: 'sentence' });
    } catch {
      segmenter = new Intl.Segmenter('en', { granularity: 'sentence' });
    }
    segmenters.set(locale, segmenter);
  }
  return segmenter;
}

/**
 * Sentence spans of `text`, with surrounding whitespace excluded. Line breaks are only the wrapping of the
 * PDF, not sentence ends, so they are treated as spaces (a same-length replacement: offsets stay valid).
 * Arabic sentences end at "؟" and "." like any other: the text is never reversed or rearranged.
 */
export function sentenceSpans(text: string, language: string): Span[] {
  const flat = text.replace(/\n/g, ' ');
  const spans: Span[] = [];
  for (const { index, segment } of segmenterFor(language).segment(flat)) {
    const leading = segment.length - segment.trimStart().length;
    const trailing = segment.length - segment.trimEnd().length;
    const start = index + leading;
    const end = index + segment.length - trailing;
    if (end > start) spans.push({ start, end });
  }
  return spans;
}

const CLAUSE_BREAK = /[,;:،؛—–]\s+/gu;

/** Splits a span that is still too long: at clause punctuation, else at spaces, else at a hard limit. */
export function splitLongSpan(
  text: string,
  span: Span,
  fits: (piece: string) => boolean,
  maxChars: number,
): Span[] {
  const piece = text.slice(span.start, span.end);
  if (fits(piece)) return [span];
  const cuts: number[] = [];
  for (const match of piece.matchAll(CLAUSE_BREAK)) cuts.push(span.start + match.index + match[0].length);
  const spaces: number[] = [];
  for (const match of piece.matchAll(/\s+/gu)) spaces.push(span.start + match.index + match[0].length);

  const result: Span[] = [];
  let start = span.start;
  while (start < span.end) {
    let end = span.end;
    if (!fits(text.slice(start, end))) {
      end =
        lastFittingCut(text, start, span.end, cuts, fits, maxChars) ??
        lastFittingCut(text, start, span.end, spaces, fits, maxChars) ??
        hardCut(text, start, span.end, fits, maxChars);
    }
    const trimmed = trimSpan(text, { start, end });
    if (trimmed.end > trimmed.start) result.push(trimmed);
    start = end;
  }
  return result;
}

function lastFittingCut(
  text: string,
  start: number,
  limit: number,
  cuts: readonly number[],
  fits: (piece: string) => boolean,
  maxChars: number,
): number | null {
  let best: number | null = null;
  for (const cut of cuts) {
    if (cut <= start || cut >= limit) continue;
    if (cut - start > maxChars) break;
    if (!fits(text.slice(start, cut))) break;
    best = cut;
  }
  // A cut that leaves almost nothing is no better than a hard one.
  return best !== null && best - start >= 1 ? best : null;
}

/** The largest end <= maxChars from `start` that fits, never inside a surrogate pair. */
function hardCut(
  text: string,
  start: number,
  limit: number,
  fits: (piece: string) => boolean,
  maxChars: number,
): number {
  let end = Math.min(limit, start + maxChars);
  while (end > start + 1 && !fits(text.slice(start, end)))
    end = Math.max(start + 1, end - Math.max(1, Math.floor((end - start) * 0.1)));
  const code = text.charCodeAt(end - 1);
  if (code >= 0xd800 && code <= 0xdbff && end < limit) end += 1; // keep a surrogate pair whole
  return Math.min(limit, Math.max(end, start + 1));
}

function trimSpan(text: string, span: Span): Span {
  let { start, end } = span;
  while (start < end && /\s/u.test(text[start] ?? '')) start += 1;
  while (end > start && /\s/u.test(text[end - 1] ?? '')) end -= 1;
  return { start, end };
}
