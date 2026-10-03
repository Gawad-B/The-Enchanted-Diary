import {
  DAILY_QUOTA_DETAIL,
  KEY_REJECTED_DETAIL,
  MODEL_NOT_FOUND_DETAIL,
  NO_QUOTA_DETAIL,
} from '../gemini/index.js';
import { OCR_BUDGET_DETAIL, OCR_CAPABILITY_DETAIL, OCR_SERVICE_DETAIL } from '../ocr/types.js';
import { AppError } from '../http/errors.js';
import type { PageAssessment } from '../pdf/quality.js';
import type { PageEvidenceFlags } from './analyze.js';
import {
  LOW_OCR_CONFIDENCE,
  decidePage,
  failedPageDecision,
  type OcrOutcome,
  type PageDecision,
} from './page-policy.js';
import type { ParseResult } from './worker/host.js';
import type { SerializedPage } from './worker/protocol.js';

/*
 * After extraction and OCR: what every page of the document is, which pages carry text into analysis and chunking,
 * how far each page's text can be trusted, and why the document failed if no page has any text.
 */

export interface SettleInput {
  parsed: ParseResult;
  assessments: ReadonlyMap<number, PageAssessment>;
  /** One outcome for every page that needed OCR. */
  outcomes: ReadonlyMap<number, OcrOutcome>;
  /** Whether the OCR engine can read; null when it was never asked (no page needed OCR). */
  ocrAvailable: boolean | null;
  /** OCR_PROVIDER is not `none`. */
  ocrConfigured: boolean;
}

export interface SettledPages {
  decisions: Map<number, PageDecision>;
  /** The pages as they are stored: where OCR text won it replaces the extracted text. */
  pages: Map<number, SerializedPage>;
  /** What the language, direction and sections analysis may take from each page's text (see PageEvidenceFlags). */
  evidence: Map<number, PageEvidenceFlags>;
  /** The pages that carry text onward, in page order. */
  kept: SerializedPage[];
  /** Why the document cannot be indexed, if no page has text; null otherwise. */
  failure: AppError | null;
}

/** Pages OCR left unread for the reason `detail`. */
const failedWith = (outcomes: ReadonlyMap<number, OcrOutcome>, detail: string): number =>
  [...outcomes.values()].filter((outcome) => outcome.kind === 'failed' && outcome.detail === detail).length;

/** The faults of the configuration that the OCR worker reports as the detail of the pages it left (curated). */
const CONFIG_FAULTS: readonly string[] = [
  KEY_REJECTED_DETAIL,
  MODEL_NOT_FOUND_DETAIL,
  NO_QUOTA_DETAIL,
  OCR_CAPABILITY_DETAIL,
];

/**
 * Why a document with no readable page cannot be indexed when the pages were not damaged or empty but could not be read:
 * the model service refuses the configuration (the owner has to act), its quota ran out or it did not answer, or the time
 * allowed for OCR ran out first (the same upload may work later). Null otherwise: the pages are then judged on their own.
 */
function unreadNotByDamage(outcomes: ReadonlyMap<number, OcrOutcome>): AppError | null {
  const fault = CONFIG_FAULTS.find((detail) => failedWith(outcomes, detail) > 0);
  if (fault !== undefined) {
    return new AppError(
      'LLM_UNAVAILABLE',
      'Text recognition is not set up correctly on this server (the model service refuses its key or its model, or has no quota for it); the owner should check GEMINI_API_KEY and OCR_MODEL.',
      `${fault} (OCR_PARTIAL)`,
    );
  }
  if (failedWith(outcomes, DAILY_QUOTA_DETAIL) > 0) {
    return new AppError(
      'RATE_LIMITED',
      'The daily limit of the text-recognition service was reached before any page could be read; upload the document again later.',
      `${DAILY_QUOTA_DETAIL} (OCR_PARTIAL)`,
    );
  }
  if (failedWith(outcomes, OCR_SERVICE_DETAIL) > 0) {
    return new AppError(
      'LLM_UNAVAILABLE',
      'The text-recognition service could not be reached before any page could be read; upload the document again in a moment.',
      `${OCR_SERVICE_DETAIL} (OCR_PARTIAL)`,
    );
  }
  if (failedWith(outcomes, OCR_BUDGET_DETAIL) > 0) {
    return new AppError(
      'LLM_UNAVAILABLE',
      'Reading the pages took longer than the time allowed before any of them could be read; upload the document again in a moment.',
      `${OCR_BUDGET_DETAIL} (OCR_PARTIAL)`,
    );
  }
  return null;
}

const outcomeKinds = (outcomes: ReadonlyMap<number, OcrOutcome>): Set<OcrOutcome['kind']> =>
  new Set([...outcomes.values()].map((outcome) => outcome.kind));

function emptyDocumentDetail(outcomes: ReadonlyMap<number, OcrOutcome>): string {
  const kinds = outcomeKinds(outcomes);
  if (kinds.has('unavailable')) return 'no page contains text and OCR is not available (OCR_UNAVAILABLE)';
  if (kinds.has('read')) return 'no page contains text; OCR found none (LOW_TEXT_QUALITY)';
  if (kinds.has('skipped')) return 'no page contains text and OCR was skipped (OCR_PARTIAL)';
  return 'no page contains text';
}

export function settlePages(input: SettleInput): SettledPages {
  const { parsed, assessments, outcomes } = input;
  const decisions = new Map<number, PageDecision>();
  const pages = new Map<number, SerializedPage>();
  const evidence = new Map<number, PageEvidenceFlags>();
  const unreadable = new Set(parsed.failures.map((failure) => failure.pageNumber));
  let tooBigToDecode = 0;

  for (const page of parsed.pages) {
    const assessment = assessments.get(page.pageNumber);
    if (assessment === undefined) throw new Error(`page ${String(page.pageNumber)} was not assessed`);
    const outcome = outcomes.get(page.pageNumber);
    const decision = decidePage(page, assessment, outcome);
    decisions.set(page.pageNumber, decision);
    if (decision.ocrText === undefined) {
      pages.set(page.pageNumber, page);
    } else {
      const { confidence: _confidence, ...replacement } = decision.ocrText; // the confidence is kept in the decision
      pages.set(page.pageNumber, { ...page, ...replacement });
    }

    // A page without text whose image the extraction limit refused (4000 x 4000 pixels or more), and which OCR did not
    // read: a scan too big to read. It is unreadable, not empty.
    const oversized = page.removedImages > 0 && page.charCount === 0 && outcome?.kind !== 'read';
    if (oversized) tooBigToDecode += 1;
    if (decision.extraction === 'empty' && (oversized || outcome?.kind === 'failed')) {
      unreadable.add(page.pageNumber);
    }

    // A page of garbage says nothing about the document; an Arabic font on it still says which way it reads. OCR text
    // the engine was unsure of is no better evidence.
    if (decision.extraction === 'ocr') {
      // An engine that reports no confidence (Gemini) has not said it is unsure.
      if (
        decision.ocrConfidence !== undefined &&
        decision.ocrConfidence !== null &&
        decision.ocrConfidence < LOW_OCR_CONFIDENCE
      )
        evidence.set(page.pageNumber, { garbled: true });
    } else if (decision.keepText && assessment.unreliable) {
      evidence.set(page.pageNumber, {
        garbled: true,
        ...(page.quality.arabicFontNames ? { directionHint: 'rtl' as const } : {}),
      });
    }
  }

  // Pages that could not be extracted at all: empty.
  const engineAvailable = input.ocrAvailable ?? input.ocrConfigured;
  for (let pageNumber = 1; pageNumber <= parsed.pageCount; pageNumber += 1) {
    if (!decisions.has(pageNumber)) decisions.set(pageNumber, failedPageDecision(engineAvailable));
  }

  const kept = parsed.pages
    .map((page) => pages.get(page.pageNumber))
    .filter((page): page is SerializedPage => {
      return page !== undefined && decisions.get(page.pageNumber)?.keepText === true && page.charCount > 0;
    });

  let failure: AppError | null = null;
  if (kept.length === 0) {
    failure =
      unreadNotByDamage(outcomes) ??
      (unreadable.size > 0
        ? new AppError(
            'PDF_UNREADABLE',
            'The pages appear damaged or unreadable.',
            `${String(unreadable.size)} of ${String(parsed.pageCount)} pages could not be read` +
              (tooBigToDecode > 0 ? ` (${String(tooBigToDecode)} hold images too large to decode)` : ''),
          )
        : new AppError('PDF_EMPTY', 'The PDF has no readable text.', emptyDocumentDetail(outcomes)));
  }
  return { decisions, pages, evidence, kept, failure };
}
