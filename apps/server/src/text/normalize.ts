/*
 * Normalisation of text that came out of a PDF (or out of OCR) before it is stored, chunked, embedded and
 * indexed. The search form (`search_text`) is produced by the shared `normalizeForSearch`; this module only
 * cleans the text that people (and the model) read.
 */

// Invisible characters that carry no text: soft hyphen, zero-width space, word joiner, BOM, left/right marks,
// Arabic letter mark, the bidi embedding/override/isolate controls (U+202A-U+202E, U+2066-U+2069), the
// Mongolian vowel separator and the "tag" characters (U+E0000-U+E007F, used to smuggle hidden text).
// ZWJ (U+200D) and ZWNJ (U+200C) are kept: Persian and Urdu spelling depends on them.
const INVISIBLE =
  /[\u00AD\u180E\u200B\u200E\u200F\u2060\uFEFF\u061C\u202A-\u202E\u2066-\u2069\u{E0000}-\u{E007F}]/gu;

// Tashkeel (U+064B-U+065F), superscript alef, Quranic annotation signs (U+06D6-U+06ED) and tatweel. pdf.js emits
// these as separately positioned glyphs, so they come out scrambled; they are stripped at ingest, for display
// text, search and embeddings alike (a documented limitation: diacritised text loses its vowels).
const ARABIC_MARKS = /[\u064B-\u065F\u0670\u06D6-\u06ED\u0640]/g;

/** NUL and the replacement character: what pdf.js returns when it cannot map a glyph to Unicode. */
// eslint-disable-next-line no-control-regex -- matching NUL is the point
export const UNMAPPED_GLYPH = /[\u0000\uFFFD]/g;

/** C0 and C1 control characters except tab, line feed and carriage return: never text, always a decoding accident. */
// eslint-disable-next-line no-control-regex -- matching control characters is the point
export const CONTROL_CHARS = /[\u{1}-\u{8}\u{B}\u{C}\u{E}-\u{1F}\u{7F}-\u{9F}]/gu;

const HORIZONTAL_SPACE = /[^\S\n]+/gu;
const HYPHEN_END = /(\p{Script=Latin})[-‐]$/u;
const LOWERCASE_LATIN_START = /^\p{Script=Latin}/u;

/** Removes control characters, invisible characters, unmapped glyphs and Arabic marks, after NFKC. No whitespace changes. */
export function stripInvisibleAndMarks(text: string): string {
  return text
    .normalize('NFKC')
    .replace(UNMAPPED_GLYPH, '')
    .replace(CONTROL_CHARS, '')
    .replace(INVISIBLE, '')
    .replace(ARABIC_MARKS, '');
}

/**
 * One line of text, cleaned: NFKC (folds Arabic presentation forms and ligatures such as lam-alef U+FEFB into
 * base letters), invisible characters and marks removed, runs of spaces collapsed, trimmed.
 */
export function normalizeLine(text: string): string {
  return stripInvisibleAndMarks(text).replace(HORIZONTAL_SPACE, ' ').trim();
}

/** True when `previous` ends with a Latin letter plus a hyphen and `next` continues with a lower-case word. */
function continuesHyphenatedWord(previous: string, next: string): boolean {
  if (!HYPHEN_END.test(previous) || !LOWERCASE_LATIN_START.test(next)) return false;
  const first = next[0] ?? '';
  return first !== first.toUpperCase() && first === first.toLowerCase();
}

export interface JoinedLines {
  text: string;
  /** For every input line, where its (possibly shortened) text sits in `text`. */
  ranges: { start: number; end: number }[];
}

/**
 * Joins already-normalised lines with "\n", undoing line-break hyphenation: "informa-" + "tion" becomes
 * "information" when the next line starts with a lower-case Latin letter (a capital means a real hyphenated
 * name or a new sentence). Only Latin hyphenation is undone; "كلمة-" is left alone. The ranges let callers keep
 * per-line geometry aligned with the final text.
 */
export function joinLines(lines: readonly string[]): JoinedLines {
  const ranges: { start: number; end: number }[] = [];
  let text = '';
  for (let i = 0; i < lines.length; i += 1) {
    let line = lines[i] ?? '';
    const next = lines[i + 1];
    if (next !== undefined && continuesHyphenatedWord(line, next)) line = line.replace(/[-‐]$/u, '');
    const joinsPrevious = i > 0 && continuesHyphenatedWord(lines[i - 1] ?? '', line);
    if (i > 0 && !joinsPrevious) text += '\n';
    const start = text.length;
    text += line;
    ranges.push({ start, end: text.length });
  }
  return { text, ranges };
}

/**
 * Normalises a block of extracted text: every line is cleaned (see {@link normalizeLine}), Latin line-break
 * hyphenation is undone, and the line structure is kept: single newlines between lines, at most one blank
 * line between blocks, no leading or trailing blank lines.
 */
export function normalizeExtractedText(text: string): string {
  const lines = text.split(/\r\n|\r|\n/).map(normalizeLine);
  const { text: joined } = joinLines(lines);
  return joined.replace(/\n{3,}/g, '\n\n').trim();
}
