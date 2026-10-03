import { countScripts } from '../language/detect.js';
import type { ExtractedPage, PageQuality } from './types.js';

/*
 * Is the text pdf.js extracted from a page any good? Producers lose or garble glyphs in ways that cannot be
 * repaired afterwards (tech-verification section 4): U+0000 for ligature glyphs, wrong ASCII characters where
 * ligatures were, mojibake and random scripts when a font has no usable ToUnicode map. The page is then a
 * candidate for OCR (src/ocr, run by the ingestion pipeline); without OCR, or if OCR does not read the page better, the
 * cleaned text is kept and flagged.
 */

/** Share of unmapped glyphs (NUL / U+FFFD) above which the page needs OCR: 0.5% (global section N). */
export const UNMAPPED_RATIO_LIMIT = 0.005;
/** Share of mojibake characters above which the page needs OCR (review item I8). */
export const MOJIBAKE_RATIO_LIMIT = 0.2;
/** Share of U+FFFD / private-use characters above which a page is garbage (brief, requirement 4). */
export const GARBAGE_RATIO_LIMIT = 0.3;
/** An Arabic-looking font with fewer Arabic letters than this share means the Arabic glyphs were mis-mapped. */
export const ARABIC_FONT_MIN_LETTER_SHARE = 0.05;
/** Pages with this many characters or more are not considered "image pages" however much of them is image. */
export const IMAGE_PAGE_MAX_CHARS = 200;
export const IMAGE_COVERAGE_LIMIT = 0.5;
/** A page with this many filled vector paths or more is drawn, not blank: text turned into outlines has hundreds. */
export const BLANK_PAGE_MAX_VECTOR_PATHS = 20;

// C0 controls except tab/newline/CR, C1 controls, Latin-1 letters U+00C0-U+00FF (what UTF-8 Arabic looks like
// when it is decoded as Latin-1), private use, replacement character.
// eslint-disable-next-line no-control-regex -- control characters are part of what this detects
const MOJIBAKE = /[\u0001-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009FÀ-ÿ\uE000-\uF8FF\uFFFD]/gu;
const GARBAGE = /[\uE000-\uF8FF\uFFFD]/gu;
const SANDWICHED_ASCII = /(?<=\p{Script=Arabic})[0-9@#$%&*+=<>^_~|\\/]+(?=\p{Script=Arabic})/gu;
export const ARABIC_FONT_NAME =
  /Arab|Naskh|Nastaliq|Kufi|Amiri|Scheherazade|Lateef|Traditional Arabic|Simplified Arabic/iu;

const NON_SPACE = /\S/gu;

/** Bucket for the script-scatter check: a script name for the ones we know, else the Unicode block. */
function bucketOf(letter: string): string {
  const cp = letter.codePointAt(0) ?? 0;
  if (cp < 0x250) return 'latin';
  if (cp >= 0x600 && cp <= 0x6ff) return 'arabic';
  if (cp >= 0x750 && cp <= 0x77f) return 'arabic';
  if (cp >= 0xfb50 && cp <= 0xfeff) return 'arabic';
  if (cp >= 0x400 && cp <= 0x52f) return 'cyrillic';
  if (cp >= 0x370 && cp <= 0x3ff) return 'greek';
  if (cp >= 0x590 && cp <= 0x5ff) return 'hebrew';
  if (cp >= 0x3040 && cp <= 0x30ff) return 'kana';
  if (cp >= 0x4e00 && cp <= 0x9fff) return 'han';
  if (cp >= 0xac00 && cp <= 0xd7af) return 'hangul';
  return `block-${(cp >> 8).toString(16)}`;
}

/**
 * Letters spread over several unrelated scripts: more than half of them outside the two biggest script
 * buckets. A bilingual text (Arabic and Latin, even with a Cyrillic quotation) never gets there; text whose
 * glyph ids were read as Unicode does.
 */
function hasScriptScatter(text: string): boolean {
  const letters = text.match(/\p{L}/gu) ?? [];
  if (letters.length < 20) return false;
  const buckets = new Map<string, number>();
  for (const letter of letters) {
    const key = bucketOf(letter);
    buckets.set(key, (buckets.get(key) ?? 0) + 1);
  }
  const sizes = [...buckets.values()].sort((a, b) => b - a);
  const topTwo = (sizes[0] ?? 0) + (sizes[1] ?? 0);
  return (letters.length - topTwo) / letters.length > 0.5;
}

/** Quality evidence for the cleaned page text plus the counts from before cleaning. */
export function computeQuality(
  text: string,
  raw: { chars: number; unmapped: number; controls: number },
  fontNames: readonly string[],
): PageQuality {
  const { chars: rawChars, unmapped: unmappedChars, controls: controlChars } = raw;
  const nonSpace = text.match(NON_SPACE)?.length ?? 0;
  // Control characters were stripped from the text; they still count as evidence of garbage.
  const denominator = nonSpace + unmappedChars + controlChars;
  const ratio = (count: number): number => (denominator === 0 ? 0 : count / denominator);
  const mojibake = text.match(MOJIBAKE)?.length ?? 0;
  const garbage = text.match(GARBAGE)?.length ?? 0;
  const counts = countScripts(text);
  const letters = Object.values(counts).reduce((sum, n) => sum + n, 0);
  return {
    rawChars,
    unmappedChars,
    unmappedRatio: rawChars === 0 ? 0 : unmappedChars / rawChars,
    mojibakeRatio: ratio(mojibake + unmappedChars + controlChars),
    garbageRatio: ratio(garbage + unmappedChars),
    sandwichedAscii: text.match(SANDWICHED_ASCII)?.length ?? 0,
    arabicLetterShare: letters === 0 ? 0 : counts.arabic / letters,
    scriptScatter: hasScriptScatter(text),
    arabicFontNames: fontNames.some((name) => ARABIC_FONT_NAME.test(name)),
  };
}

export type OcrReason =
  | 'few-characters'
  | 'image-page'
  | 'garbage'
  | 'unmapped-glyphs'
  | 'mojibake'
  | 'sandwiched-ascii'
  | 'script-scatter'
  | 'arabic-font-without-arabic';

export interface PageAssessment {
  /** True when OCR should replace (or at least check) the extracted text. */
  needsOcr: boolean;
  /** True when text exists but cannot be trusted: the page gets LOW_TEXT_QUALITY if OCR cannot fix it. */
  lowTextQuality: boolean;
  /**
   * The text is mostly garbage (mojibake, letters scattered over unrelated scripts, an Arabic font without Arabic
   * letters): it says nothing about the document's language, direction or headings, unlike a page that only lost a
   * few glyphs (`unmapped-glyphs`), whose text is still mostly right.
   */
  unreliable: boolean;
  reasons: OcrReason[];
}

export interface AssessOptions {
  /** OCR_MIN_CHARS. */
  minChars: number;
}

/**
 * A page with nothing on it to read: no text, no image, and no more than a rule or a border of vector drawing. Such a
 * page never starts OCR and is not a warning. Text drawn as vector outlines (no font, no text layer: print-ready and
 * flattened files, often Arabic ones) has no text and no image either, but hundreds of filled paths: it is not blank.
 */
export function isBlankPage(
  page: Pick<ExtractedPage, 'charCount' | 'imageCoverage' | 'vectorPaths'>,
): boolean {
  return page.charCount === 0 && page.imageCoverage === 0 && page.vectorPaths < BLANK_PAGE_MAX_VECTOR_PATHS;
}

/** Why (if at all) a page should go to OCR. */
export function assessPage(
  page: Pick<ExtractedPage, 'charCount' | 'imageCoverage' | 'quality'>,
  options: AssessOptions,
): PageAssessment {
  const reasons: OcrReason[] = [];
  const quality = page.quality;
  if (page.charCount < options.minChars) reasons.push('few-characters');
  if (page.charCount < IMAGE_PAGE_MAX_CHARS && page.imageCoverage > IMAGE_COVERAGE_LIMIT)
    reasons.push('image-page');
  if (quality.garbageRatio > GARBAGE_RATIO_LIMIT) reasons.push('garbage');

  const garbled: OcrReason[] = [];
  if (quality.unmappedRatio > UNMAPPED_RATIO_LIMIT) garbled.push('unmapped-glyphs');
  if (quality.mojibakeRatio > MOJIBAKE_RATIO_LIMIT) garbled.push('mojibake');
  const arabicLetters = quality.arabicLetterShare;
  if (quality.sandwichedAscii >= 2 && arabicLetters > 0) garbled.push('sandwiched-ascii');
  if (quality.scriptScatter) garbled.push('script-scatter');
  if (
    quality.arabicFontNames &&
    quality.arabicLetterShare < ARABIC_FONT_MIN_LETTER_SHARE &&
    page.charCount >= options.minChars
  ) {
    garbled.push('arabic-font-without-arabic');
  }
  reasons.push(...garbled);
  const needsOcr = reasons.length > 0;
  const unreliable = reasons.some((reason) =>
    ['mojibake', 'script-scatter', 'garbage', 'arabic-font-without-arabic'].includes(reason),
  );
  return {
    needsOcr,
    lowTextQuality: garbled.length > 0 || reasons.includes('garbage'),
    unreliable,
    reasons,
  };
}

/**
 * Whether a page needs OCR (`needsOcr(page)` of the brief): too little text, an image-dominated page with
 * little text, or text that is garbled. `minChars` defaults to OCR_MIN_CHARS' default of 25.
 */
export function needsOcr(
  page: Pick<ExtractedPage, 'charCount' | 'imageCoverage' | 'quality'>,
  options: Partial<AssessOptions> = {},
): boolean {
  return assessPage(page, { minChars: options.minChars ?? 25 }).needsOcr;
}
