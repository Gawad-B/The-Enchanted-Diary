import { MIN_LETTERS_FOR_DETECTION, summarizeLanguages } from '../language/detect.js';

/*
 * Language packs. The language detector speaks ISO 639-1 (`en`, `ar`); Tesseract packs have ISO 639-2/T-style codes
 * (`eng`, `ara`). Only languages the detector can name are listed.
 */

const PAIRS: readonly (readonly [iso1: string, tesseract: string])[] = [
  ['en', 'eng'],
  ['ar', 'ara'],
  ['fa', 'fas'],
  ['ur', 'urd'],
  ['fr', 'fra'],
  ['es', 'spa'],
  ['de', 'deu'],
  ['it', 'ita'],
  ['pt', 'por'],
  ['tr', 'tur'],
  ['nl', 'nld'],
  ['pl', 'pol'],
  ['ro', 'ron'],
  ['sv', 'swe'],
  ['da', 'dan'],
  ['nb', 'nor'],
  ['no', 'nor'],
  ['fi', 'fin'],
  ['cs', 'ces'],
  ['hu', 'hun'],
  ['id', 'ind'],
  ['vi', 'vie'],
  ['ru', 'rus'],
  ['el', 'ell'],
  ['he', 'heb'],
  ['hi', 'hin'],
  ['th', 'tha'],
  ['ja', 'jpn'],
  ['ko', 'kor'],
  ['zh', 'chi_sim'],
];

const TO_TESSERACT = new Map(PAIRS);
const TO_ISO1 = new Map<string, string>();
for (const [iso1, tesseract] of PAIRS) if (!TO_ISO1.has(tesseract)) TO_ISO1.set(tesseract, iso1);

/** The Tesseract pack for an ISO 639-1 language code, if there is one. */
export const tesseractCodeFor = (iso1: string): string | undefined => TO_TESSERACT.get(iso1);

/** The ISO 639-1 code for a Tesseract pack, if known. */
export const iso1For = (tesseract: string): string | undefined => TO_ISO1.get(tesseract);

/** A language needs at least this share of the letters of the sample to be tried. */
const MIN_SHARE = 0.15;
const MAX_CANDIDATES = 3;

/**
 * The language packs to try on the first OCR page: the languages found in the document's own text pages (mapped to
 * packs, restricted to the packs the operator allows, at most three, the largest share first), or `configured`
 * (OCR_LANGUAGES) when there is no usable text or none of its languages has an allowed pack.
 */
export function candidateLanguages(
  sample: string,
  options: { configured: readonly string[]; allowed: readonly string[] },
): string[] {
  const configured = [...new Set(options.configured)];
  const letters = sample.match(/\p{L}/gu)?.length ?? 0;
  if (letters < MIN_LETTERS_FOR_DETECTION) return configured;
  const allowed = new Set(options.allowed);
  const found: string[] = [];
  for (const { code, share } of summarizeLanguages([{ text: sample }])) {
    if (share < MIN_SHARE) continue;
    const pack = tesseractCodeFor(code);
    if (pack !== undefined && allowed.has(pack) && !found.includes(pack)) found.push(pack);
    if (found.length === MAX_CANDIDATES) break;
  }
  return found.length > 0 ? found : configured;
}
