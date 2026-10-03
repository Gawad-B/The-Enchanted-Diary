import type { WarningCode } from '@enchanted/shared';
import type { OcrPageText } from '../ocr/ocr-page.js';
import type { ExtractedPage } from '../pdf/types.js';
import { isBlankPage, type PageAssessment } from '../pdf/quality.js';

/*
 * What becomes of a page, given what extraction found and what OCR made of it. Global section N: text that exists is
 * never dropped; OCR replaces it only where it is the better text.
 */

/**
 * OCR text below this mean confidence is flagged LOW_TEXT_QUALITY (still indexed: it is better than nothing). An engine
 * that reports no confidence (Gemini: `null`) is neither trusted nor doubted by it: such a read is judged by how much of
 * the page it covers.
 */
export const LOW_OCR_CONFIDENCE = 40;
/** Typical word length in characters, to turn "share of lost glyphs" into "share of damaged words". */
const AVERAGE_WORD_CHARS = 5;

/** What OCR did for a page that needed it. */
export type OcrOutcome =
  | { kind: 'read'; confidence: number | null; languages: string[]; text: OcrPageText }
  /**
   * The engine failed on this page: it timed out, ran out of memory, or threw. `detail` says when the engine was not at
   * fault but the service was ("daily quota reached").
   */
  | { kind: 'failed'; detail?: string }
  /** Beyond OCR_MAX_PAGES. */
  | { kind: 'skipped' }
  | { kind: 'unavailable' };

export interface PageDecision {
  extraction: 'text' | 'ocr' | 'empty';
  warnings: WarningCode[];
  /** Whether the page's text is stored and chunked. */
  keepText: boolean;
  /** Mean OCR confidence, 0..100; only for pages whose text is OCR text; null when the engine reports none (Gemini). */
  ocrConfidence?: number | null;
  /** The OCR text that replaces the extracted text of the page (present exactly when `extraction` is 'ocr'). */
  ocrText?: OcrPageText;
}

type DecidablePage = Pick<ExtractedPage, 'charCount' | 'quality' | 'imageCoverage' | 'vectorPaths'>;

/**
 * How good the extracted text of a page is, 0..100, on the scale of an OCR confidence (the share of words that are
 * right). Garbage (mojibake, scattered scripts, an Arabic font without Arabic letters) is 0. Otherwise the characters
 * that were lost or mis-mapped are turned into the share of words that contain one.
 */
export function extractedTextScore(page: DecidablePage, assessment: PageAssessment): number {
  if (assessment.unreliable) return 0;
  const { quality } = page;
  const sandwiched = page.charCount === 0 ? 0 : quality.sandwichedAscii / page.charCount;
  const damage = Math.max(quality.unmappedRatio, quality.mojibakeRatio, quality.garbageRatio, sandwiched);
  const damagedWords = 1 - (1 - Math.min(1, damage)) ** AVERAGE_WORD_CHARS;
  return Math.round(100 * (1 - damagedWords));
}

/** OCR may replace the text of a page that lost glyphs only if it read at least this share of it. */
export const MIN_OCR_COVERAGE = 0.8;
/** OCR may replace the little text of a picture page only if it found this many times as much. */
export const SPARSE_TEXT_GAIN = 1.5;

export function decidePage(page: DecidablePage, assessment: PageAssessment, ocr?: OcrOutcome): PageDecision {
  if (!assessment.needsOcr) return { extraction: 'text', warnings: [], keepText: true };
  const outcome = ocr ?? { kind: 'unavailable' as const };
  const hasText = page.charCount > 0;
  const lowQuality: WarningCode[] = assessment.lowTextQuality ? ['LOW_TEXT_QUALITY'] : [];
  // Nothing on it, and nothing it could hold (no image, no vector drawing): there is nothing to read, with or without an
  // engine. Text drawn as vector outlines is not blank: it has no text layer and no image, but hundreds of filled paths.
  const blank = isBlankPage(page);
  // Clean text that is the whole of what the page says (a slide with a picture behind it): OCR was a second opinion.
  const adequate = hasText && !assessment.lowTextQuality && !assessment.reasons.includes('few-characters');

  switch (outcome.kind) {
    case 'unavailable':
    case 'failed':
    case 'skipped': {
      if (blank || adequate) {
        return hasText
          ? { extraction: 'text', warnings: [], keepText: true }
          : { extraction: 'empty', warnings: [], keepText: false };
      }
      const code: WarningCode = outcome.kind === 'unavailable' ? 'OCR_UNAVAILABLE' : 'OCR_PARTIAL';
      return hasText
        ? { extraction: 'text', warnings: [code, ...lowQuality], keepText: true }
        : { extraction: 'empty', warnings: [code], keepText: false };
    }
    case 'read':
      return decideRead(page, assessment, outcome, hasText, lowQuality);
  }
}

/**
 * Whether the OCR text replaces the extracted text. Text that is garbage (or absent) is worth nothing: any read replaces it.
 * Anything else is protected: a read that covers only part of the page (Tesseract reports a high mean confidence for a
 * fragment it read well: "returned only line 1, but correct (conf 88)") or that the engine is unsure of does not take its
 * place. A page that lost glyphs is replaced by a read of at least 80% of its characters that is better than its text. A
 * picture page is replaced by a read of 1.5 times as much text: where its own text is clean and as long as a few
 * lines (a slide, a caption) the read must also be sure of itself (confidence at least 40, when the engine reports one); where it is a few
 * characters (a page number, a stamp) it need not be: a long read is the page, however poor the scan, and carries
 * LOW_TEXT_QUALITY when it is below 40.
 */
function ocrReplacesText(
  page: DecidablePage,
  assessment: PageAssessment,
  outcome: Extract<OcrOutcome, { kind: 'read' }>,
  hasText: boolean,
): boolean {
  if (!hasText || assessment.unreliable) return true;
  const ocrChars = outcome.text.charCount;
  const { confidence } = outcome;
  const sparse = assessment.reasons.includes('few-characters') || assessment.reasons.includes('image-page');
  if (sparse) {
    const more = ocrChars >= SPARSE_TEXT_GAIN * page.charCount;
    const adequate = !assessment.lowTextQuality && !assessment.reasons.includes('few-characters');
    return adequate ? more && (confidence === null || confidence >= LOW_OCR_CONFIDENCE) : more;
  }
  return (
    ocrChars >= MIN_OCR_COVERAGE * page.charCount &&
    (confidence === null || confidence > extractedTextScore(page, assessment))
  );
}

function decideRead(
  page: DecidablePage,
  assessment: PageAssessment,
  outcome: Extract<OcrOutcome, { kind: 'read' }>,
  hasText: boolean,
  lowQuality: WarningCode[],
): PageDecision {
  if (outcome.text.charCount === 0) {
    // Nothing was read. Text that exists stays. A page with none is empty: blank if it has no image either (there is
    // nothing it could have held), otherwise a picture OCR could not read, which is worth a warning.
    if (hasText) return { extraction: 'text', warnings: lowQuality, keepText: true };
    return {
      extraction: 'empty',
      warnings: isBlankPage(page) ? [] : ['LOW_TEXT_QUALITY'],
      keepText: false,
    };
  }
  if (!ocrReplacesText(page, assessment, outcome, hasText)) {
    return { extraction: 'text', warnings: lowQuality, keepText: true };
  }
  return {
    extraction: 'ocr',
    warnings:
      outcome.confidence !== null && outcome.confidence < LOW_OCR_CONFIDENCE ? ['LOW_TEXT_QUALITY'] : [],
    keepText: true,
    ocrConfidence: outcome.confidence,
    ocrText: outcome.text,
  };
}

/**
 * A page that could not be extracted at all (timeout, crash): empty. OCR was not tried on it (what stopped the text
 * extraction would stop the rendering too), so it is flagged like a page OCR could not read when there is an engine,
 * and like an unreadable scan when there is none.
 */
export const failedPageDecision = (ocrAvailable: boolean): PageDecision => ({
  extraction: 'empty',
  warnings: [ocrAvailable ? 'OCR_PARTIAL' : 'OCR_UNAVAILABLE'],
  keepText: false,
});

/** The decision for a page that could not be extracted when there is no OCR engine (the state of affairs before OCR). */
export const FAILED_PAGE_DECISION: PageDecision = failedPageDecision(false);

export interface PageWarningInput {
  pageNumber: number;
  warnings: readonly WarningCode[];
}

const WARNING_ORDER: readonly WarningCode[] = ['OCR_PARTIAL', 'OCR_UNAVAILABLE', 'LOW_TEXT_QUALITY'];

/** Groups per-page warnings into the document's `warnings` list: one entry per code with its sorted pages. */
export function collectWarnings(
  pages: readonly PageWarningInput[],
): { code: WarningCode; pages: number[] }[] {
  return WARNING_ORDER.flatMap((code) => {
    const numbers = pages.filter((page) => page.warnings.includes(code)).map((page) => page.pageNumber);
    return numbers.length === 0 ? [] : [{ code, pages: numbers.sort((a, b) => a - b) }];
  });
}
