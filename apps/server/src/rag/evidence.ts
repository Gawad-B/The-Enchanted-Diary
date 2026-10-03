import type { Evidence } from '@enchanted/shared';
import { STRONG_LEXICAL_COVERAGE, type EvidenceThresholds } from './constants.js';

export interface EvidenceSignals {
  /** The question has at least one non-stopword word that occurs somewhere in the document. */
  lexicalHit: boolean;
  /** 0..1: the idf-weighted share of the question's informative words that the best-matching chunk contains. */
  lexicalCoverage: number;
  /** A shared word is a number or an identifier ("1847", "MS-4471"): evidence on its own. */
  identifierHit: boolean;
  /** A shared word is a proper name written with a capital ("Thornquist"): evidence on its own. */
  properNameHit: boolean;
  /**
   * The question is written in the document's own language (true), in another (false), or one of the two is not known (null:
   * the lower of the two floors applies).
   */
  sameLanguage: boolean | null;
  /** The question names a page that exists, or points at the visible page, and asks nothing else ("what does page 4 say?"). */
  pageOnly: boolean;
  /** Best cosine similarity of the semantic search, null when it found nothing (or the query could not be embedded). */
  topCosine: number | null;
  /** The document has chunks at all. */
  hasChunks: boolean;
  /** The question is about the document as a whole (summary, "what is it about"): no passage answers it, the overview does. */
  meta?: boolean;
  /** The query could not be embedded: retrieval ran on words and pages alone, so the cosine says nothing. */
  degraded?: boolean;
}

/** Whether a shared word counts as evidence that the document covers the question (Ruling 3 of the review). */
export function informativeHit(signals: EvidenceSignals, thresholds: EvidenceThresholds): boolean {
  return (
    signals.lexicalHit &&
    (signals.identifierHit ||
      signals.properNameHit ||
      signals.lexicalCoverage >= thresholds.informativeCoverage)
  );
}

/**
 * The evidence gate that runs BEFORE the language model:
 *  - `none`: no chunks, or no INFORMATIVE word of the question occurs in the document AND the best cosine is below the model's
 *    calibrated floor (the same-language floor for a question in the document's language, the other floor for a question in
 *    another language, the lower of the two when a language is unknown). The pipeline answers "not found" without asking the
 *    model (nothing it could cite exists, and a model asked anyway is where invented answers come from). A shared word is
 *    informative when it is a number, an identifier or a proper name, or when the best chunk holds enough of the question's
 *    words (`informativeCoverage`): a generic word ("capital", "home") does not keep a question about Peru past the gate;
 *  - `strong`: the question only points at a page that exists ("what does page 4 say?"); or it is about the document as a whole;
 *    or the best cosine reaches the model's strong mark (language-aware); or the best chunk contains most of the question's
 *    informative words (STRONG_LEXICAL_COVERAGE) and the cosine is above the floor;
 *  - `weak`: it passed the gate on one signal only. The model is told so.
 * A query that could not be embedded (`degraded`) has no cosine to judge: chunks found by words or pages are `weak`, never
 * `none`, so a quota running out cannot turn into a false "not in the document".
 */
export function assessEvidence(signals: EvidenceSignals, thresholds: EvidenceThresholds): Evidence {
  if (!signals.hasChunks) return 'none';
  if (signals.pageOnly || signals.meta === true) return 'strong';
  if (signals.degraded === true) return 'weak';
  const cosine = signals.topCosine ?? Number.NEGATIVE_INFINITY;
  const floor =
    signals.sameLanguage === null
      ? Math.min(thresholds.floor, thresholds.sameLanguageFloor)
      : signals.sameLanguage
        ? thresholds.sameLanguageFloor
        : thresholds.floor;
  const strongMark =
    signals.sameLanguage === null
      ? Math.min(thresholds.strong, thresholds.crossLanguageStrong)
      : signals.sameLanguage
        ? thresholds.strong
        : thresholds.crossLanguageStrong;
  const informative = informativeHit(signals, thresholds);
  if (!informative && cosine < floor) return 'none';
  if (cosine >= strongMark) return 'strong';
  if (informative && signals.lexicalCoverage >= STRONG_LEXICAL_COVERAGE && cosine >= floor) return 'strong';
  return 'weak';
}
