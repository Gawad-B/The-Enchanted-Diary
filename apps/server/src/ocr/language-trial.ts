import { detectLanguage } from '../language/detect.js';
import { tesseractCodeFor } from './languages.js';
import { OcrUnavailableError, type OcrResult } from './types.js';

/*
 * Which language packs to read a scan with (global section N). The first OCR page is read with each candidate on its
 * own and the highest mean confidence wins: Tesseract reports a confidence for what it believes it read, and a page
 * in the wrong language scores far lower (59 and 34 points apart on the verification samples). Two languages are
 * combined only when both read the page with more than 60: combined packs slow the engine down and can inject junk
 * (the Latin tokens "Je", "Bed" appeared in an Arabic page read as `ara+eng`). One extra trial follows when the
 * winner's text reads as another language the operator allows (a French book read as English).
 *
 * Persian and Urdu are written in the Arabic script and the `ara` pack reads them with Arabic letters: it has no
 * پ چ ژ گ and no Urdu ٹ ڈ ڑ ں ے, so a Persian page cannot be told from an Arabic one by what `ara` returns, and the
 * language of its text can never be seen to be Persian. When the Arabic script wins, `fas` and `urd` (if allowed) read
 * the page too, and the best of the three is kept: by confidence, and within a few points of it by the letters only
 * Persian or Urdu has.
 */

/** Both languages must exceed this mean confidence before they are read together. */
export const COMBINE_MIN_CONFIDENCE = 60;
/** A combination is kept unless it reads the page this many points worse than the best language alone. */
const COMBINE_TOLERANCE = 5;
/** When the candidates read the page with less than this, the other configured languages are tried too. */
export const FALLBACK_BELOW_CONFIDENCE = 50;
/** Within this many points of the best confidence, the letters a language alone has decide between packs of one script. */
const SCRIPT_TIE_POINTS = 3;
/** Share of the letters that must be پ چ ژ گ before text counts as Persian evidence (Arabic has none of them). */
const PERSIAN_EVIDENCE_SHARE = 0.02;
/** Share of the letters that must be Urdu-only before text counts as Urdu evidence (Persian read as Urdu gets a few). */
const URDU_EVIDENCE_SHARE = 0.1;
/** The packs written in the Arabic script: the same page reads differently with each. */
const ARABIC_SCRIPT_PACKS: readonly string[] = ['ara', 'fas', 'urd'];
const PERSIAN_ONLY_LETTERS = /[پچژگ]/gu;
const URDU_ONLY_LETTERS = /[ٹڈڑںےۓہھ]/gu;
/** Fewer characters than this say too little about a language: the trial goes on with the next page. */
export const TRIAL_MIN_CHARS = 25;

export type Recognise = (languages: string[]) => Promise<OcrResult>;

export interface TrialRun {
  languages: string[];
  result: OcrResult;
}

export interface TrialChoice extends TrialRun {
  /** False when the page had too little text to decide; the caller keeps trying on the next page. */
  decided: boolean;
}

const characters = (text: string): number => text.replace(/\s/gu, '').length;

/** The language trial is Tesseract's: its results always carry a confidence (a provider without one scores 0). */
const conf = (run: TrialRun): number => run.result.confidence ?? 0;

/** Runs the language trial on one page. `extra` are the packs OCR_EXTRA_LANGUAGES allows for the extra trial. */
export async function chooseLanguages(options: {
  candidates: readonly string[];
  /**
   * Languages tried too, but only if the candidates read the page badly: the candidates come from the text pages of
   * the document, and a scanned body may be in another language than its typeset cover (OCR_LANGUAGES, minus the
   * candidates).
   */
  fallback?: readonly string[];
  extra: readonly string[];
  recognize: Recognise;
}): Promise<TrialChoice> {
  const runs: TrialRun[] = [];
  let unavailable: OcrUnavailableError | undefined;
  const read = async (language: string): Promise<void> => {
    try {
      runs.push({ languages: [language], result: await options.recognize([language]) });
    } catch (error) {
      // A language whose pack cannot be had is not a reason to lose the page: the others are tried.
      if (!(error instanceof OcrUnavailableError)) throw error;
      unavailable ??= error;
    }
  };
  for (const language of options.candidates) await read(language);
  const bestSoFar = Math.max(-1, ...runs.map(conf));
  if (bestSoFar < FALLBACK_BELOW_CONFIDENCE) {
    for (const language of options.fallback ?? []) {
      if (!options.candidates.includes(language)) await read(language);
    }
  }
  const first = rankByConfidence(runs)[0];
  if (first === undefined) throw unavailable ?? new Error('chooseLanguages needs at least one candidate');

  // The Arabic script won (alone or with another language): the other packs of that script read the page too.
  if (isArabicScript(first)) {
    const known = new Set([...options.candidates, ...(options.fallback ?? []), ...options.extra]);
    for (const pack of ARABIC_SCRIPT_PACKS) {
      const tried = runs.some((run) => run.languages.length === 1 && run.languages[0] === pack);
      if (known.has(pack) && !tried) await read(pack);
    }
  }
  let best = pickBest(runs);

  // Two languages are combined only across scripts (English with Arabic), never two packs of one script.
  const second = rankByConfidence(runs).find(
    (run) => run !== best && !(isArabicScript(best) && isArabicScript(run)),
  );
  if (second !== undefined && conf(best) > COMBINE_MIN_CONFIDENCE && conf(second) > COMBINE_MIN_CONFIDENCE) {
    const languages = [...best.languages, ...second.languages];
    const combined = await tryRecognise(options.recognize, languages);
    if (combined !== null && conf(combined) >= conf(best) - COMBINE_TOLERANCE) {
      best = combined;
    }
  }

  const pack = detectedPack(best.result.text);
  if (pack !== undefined && options.extra.includes(pack) && !best.languages.includes(pack)) {
    const extra = await tryRecognise(options.recognize, [pack]);
    if (extra !== null && conf(extra) > conf(best)) best = extra;
  }

  return { ...best, decided: characters(best.result.text) >= TRIAL_MIN_CHARS };
}

const rankByConfidence = (runs: readonly TrialRun[]): TrialRun[] =>
  [...runs].sort((a, b) => conf(b) - conf(a));

/** True when the run read the page with a pack of the Arabic script (possibly together with another). */
const isArabicScript = (run: TrialRun): boolean =>
  run.languages.some((pack) => ARABIC_SCRIPT_PACKS.includes(pack));

/** How much the text of a run says it is in the language of its pack: 0 for no evidence, more for more. */
function scriptEvidence(run: TrialRun): number {
  if (run.languages.length !== 1) return 0;
  const letters = run.result.text.match(/\p{L}/gu)?.length ?? 0;
  if (letters === 0) return 0;
  const share = (pattern: RegExp): number => (run.result.text.match(pattern)?.length ?? 0) / letters;
  switch (run.languages[0]) {
    case 'urd': {
      const urdu = share(URDU_ONLY_LETTERS);
      return urdu >= URDU_EVIDENCE_SHARE ? 1 + urdu : 0;
    }
    case 'fas': {
      const persian = share(PERSIAN_ONLY_LETTERS);
      return persian >= PERSIAN_EVIDENCE_SHARE ? persian : 0;
    }
    default:
      return 0;
  }
}

/** The run with the highest confidence; among those within a few points of it, the one whose text shows its script's letters. */
function pickBest(runs: readonly TrialRun[]): TrialRun {
  const ranked = rankByConfidence(runs);
  const top = ranked[0];
  if (top === undefined) throw new Error('no run to pick from');
  const close = ranked.filter((run) => conf(top) - conf(run) <= SCRIPT_TIE_POINTS);
  return close.reduce((best, run) => (scriptEvidence(run) > scriptEvidence(best) ? run : best), top);
}

/** The pack of the language a text reads as (`und` and unknown languages give undefined). */
function detectedPack(text: string): string | undefined {
  const { code } = detectLanguage(text);
  return code === 'und' ? undefined : tesseractCodeFor(code);
}

/** A trial that is only an improvement on what is already in hand: a missing pack just means no improvement. */
async function tryRecognise(recognize: Recognise, languages: string[]): Promise<TrialRun | null> {
  try {
    return { languages, result: await recognize(languages) };
  } catch (error) {
    if (error instanceof OcrUnavailableError) return null;
    throw error;
  }
}
