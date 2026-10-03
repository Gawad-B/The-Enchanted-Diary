import type { EvidenceThresholds } from '../../src/rag/constants.js';

/*
 * Evidence thresholds for the test stand-in embedding model (hashed character trigrams), whose cosine scores are not
 * Gemini's. Measured on text-en: an unrelated question tops out at 0.39, a related one at 0.4 to 0.55. These let related
 * questions through as strong. Test code only: the real thresholds are calibrated per model in src/rag/constants.ts.
 */
export const STAND_IN_THRESHOLDS: EvidenceThresholds = {
  floor: 0.2,
  sameLanguageFloor: 0.2,
  strong: 0.38,
  crossLanguageStrong: 0.38,
  informativeCoverage: 0.5,
};

/** Thresholds that make the stand-in model's 0.39 for an unrelated question "no evidence" and a lexical match "weak". */
export const STRICT_THRESHOLDS: EvidenceThresholds = {
  floor: 0.45,
  sameLanguageFloor: 0.45,
  strong: 0.6,
  crossLanguageStrong: 0.6,
  informativeCoverage: 0.5,
};
