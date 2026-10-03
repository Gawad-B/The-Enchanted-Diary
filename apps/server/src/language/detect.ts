import { directionForLanguage, dominantDirection, type Direction } from '@enchanted/shared';
import { francAll } from 'franc-min';

/** Fewer letters than this are not enough to tell Latin-script languages apart. */
export const MIN_LETTERS_FOR_DETECTION = 40;
/** franc is run on at most this many characters: the n-gram profile of a few pages is as good as of a book. */
const MAX_SAMPLE_CHARS = 6000;

export type Script =
  | 'latin'
  | 'arabic'
  | 'cyrillic'
  | 'greek'
  | 'hebrew'
  | 'han'
  | 'kana'
  | 'hangul'
  | 'devanagari'
  | 'thai'
  | 'other'
  | 'none';

export interface LanguageGuess {
  /** ISO 639-1 code, or `und` when it cannot be told. */
  code: string;
  /** 0..1. Script-decided results are as confident as the script share; franc results use the score margin. */
  confidence: number;
  script: Script;
  direction: Direction;
}

export interface LanguageShare {
  code: string;
  /** Fraction of the letters of the whole text, 0..1; the shares of a summary add up to 1. */
  share: number;
}

// franc (ISO 639-3) -> ISO 639-1 for the languages the product promises plus the other common Latin-script
// ones. franc-min knows no Danish, Norwegian or Finnish: they cannot be detected without the full `franc`.
const FRANC_TO_ISO1: Record<string, string> = {
  eng: 'en',
  fra: 'fr',
  spa: 'es',
  deu: 'de',
  ita: 'it',
  por: 'pt',
  tur: 'tr',
  nld: 'nl',
  pol: 'pl',
  ron: 'ro',
  swe: 'sv',
  dan: 'da',
  nob: 'nb',
  nno: 'nn',
  nor: 'no',
  fin: 'fi',
  ces: 'cs',
  hun: 'hu',
  ind: 'id',
  vie: 'vi',
};
const LATIN_CANDIDATES = Object.keys(FRANC_TO_ISO1);

const SCRIPT_DEFAULT_LANGUAGE: Record<Exclude<Script, 'latin' | 'arabic' | 'other' | 'none'>, string> = {
  cyrillic: 'ru',
  greek: 'el',
  hebrew: 'he',
  han: 'zh',
  kana: 'ja',
  hangul: 'ko',
  devanagari: 'hi',
  thai: 'th',
};

const SCRIPT_TESTS: [Script, RegExp][] = [
  ['latin', /\p{Script=Latin}/u],
  ['arabic', /\p{Script=Arabic}/u],
  ['cyrillic', /\p{Script=Cyrillic}/u],
  ['greek', /\p{Script=Greek}/u],
  ['hebrew', /\p{Script=Hebrew}/u],
  ['han', /\p{Script=Han}/u],
  ['kana', /[\p{Script=Hiragana}\p{Script=Katakana}]/u],
  ['hangul', /\p{Script=Hangul}/u],
  ['devanagari', /\p{Script=Devanagari}/u],
  ['thai', /\p{Script=Thai}/u],
];

function scriptOfLetter(letter: string): Script {
  for (const [script, test] of SCRIPT_TESTS) if (test.test(letter)) return script;
  return 'other';
}

export type ScriptCounts = Record<Script, number>;

/** Letters per script. Digits, punctuation, symbols and marks are not letters and are not counted. */
export function countScripts(text: string): ScriptCounts {
  const counts: ScriptCounts = {
    latin: 0,
    arabic: 0,
    cyrillic: 0,
    greek: 0,
    hebrew: 0,
    han: 0,
    kana: 0,
    hangul: 0,
    devanagari: 0,
    thai: 0,
    other: 0,
    none: 0,
  };
  for (const letter of text.match(/\p{L}/gu) ?? []) counts[scriptOfLetter(letter)] += 1;
  return counts;
}

const URDU_LETTERS = /[ٹڈڑںےۓہھ]/gu; // ٹ ڈ ڑ ں ے ۓ ہ ھ
const PERSIAN_ONLY_LETTERS = /[پچژگ]/gu; // پ چ ژ گ
const PERSIAN_FORM_LETTERS = /[کی]/gu; // ک ی (Arabic uses ك ي)
const ARABIC_FORM_LETTERS = /[كي]/gu; // ك ي

const count = (text: string, pattern: RegExp): number => text.match(pattern)?.length ?? 0;

/**
 * Tells Arabic, Persian and Urdu apart by their letters. Urdu-only letters win (Urdu also uses the Persian
 * ones); then the Persian letters pe, che, zhe, gaf, or Persian kaf/yeh in the absence of Arabic kaf/yeh;
 * everything else is Arabic.
 */
export function classifyArabicScript(text: string): 'ar' | 'fa' | 'ur' {
  if (count(text, URDU_LETTERS) > 0) return 'ur';
  const persianOnly = count(text, PERSIAN_ONLY_LETTERS);
  const persianForms = count(text, PERSIAN_FORM_LETTERS);
  const arabicForms = count(text, ARABIC_FORM_LETTERS);
  if (persianOnly > 0 || persianForms > arabicForms) return 'fa';
  return 'ar';
}

function detectLatin(text: string): { code: string; confidence: number } {
  const sample = text.length > MAX_SAMPLE_CHARS ? text.slice(0, MAX_SAMPLE_CHARS) : text;
  const ranked = francAll(sample, { only: LATIN_CANDIDATES, minLength: 3 });
  const [best, second] = ranked;
  if (best === undefined || best[0] === 'und') return { code: 'und', confidence: 0 };
  const code = FRANC_TO_ISO1[best[0]];
  if (code === undefined) return { code: 'und', confidence: 0 };
  // franc scores the best language 1 and the rest relative to it: the margin to the runner-up is the confidence.
  const margin = second === undefined ? 1 : 1 - second[1];
  return { code, confidence: Math.min(1, 0.4 + 0.6 * Math.min(1, margin / 0.25)) };
}

/**
 * Detects the language of a piece of text: the dominant script decides (Unicode letter counting), Arabic-script
 * text is split into Arabic, Persian and Urdu by its letters, Latin text goes through franc restricted to the
 * supported languages. Fewer than 40 letters is `und`, unless the script itself decides (an Arabic-script text
 * is `ar` by default, Cyrillic `ru`, ...). Works for pages and for chunks; mixed text takes its majority script.
 */
export function detectLanguage(text: string): LanguageGuess {
  const counts = countScripts(text);
  const letters = Object.values(counts).reduce((sum, n) => sum + n, 0);
  if (letters === 0) return { code: 'und', confidence: 0, script: 'none', direction: 'ltr' };

  let script: Script = 'other';
  let best = -1;
  for (const [candidate, n] of Object.entries(counts) as [Script, number][]) {
    if (candidate !== 'none' && n > best) {
      best = n;
      script = candidate;
    }
  }
  const share = best / letters;
  const decided = (code: string, confidence: number): LanguageGuess => ({
    code,
    confidence,
    script,
    direction: code === 'und' ? dominantDirection(text) : directionForLanguage(code),
  });
  const short = letters < MIN_LETTERS_FOR_DETECTION;

  switch (script) {
    case 'arabic': {
      const code = classifyArabicScript(text);
      return decided(code, short ? share * 0.5 : share);
    }
    case 'latin': {
      if (short) return decided('und', 0);
      const latin = detectLatin(text);
      return decided(latin.code, latin.confidence * share);
    }
    case 'other':
      return decided('und', 0);
    default:
      return decided(SCRIPT_DEFAULT_LANGUAGE[script], short ? share * 0.5 : share);
  }
}

/** The language of each script group of a text, with its letter count: how a mixed page is split. */
function languageLetters(text: string): Map<string, number> {
  const counts = countScripts(text);
  const result = new Map<string, number>();
  const add = (code: string, letters: number): void => {
    if (letters > 0) result.set(code, (result.get(code) ?? 0) + letters);
  };
  const letters = Object.values(counts).reduce((sum, n) => sum + n, 0);
  if (letters === 0) return result;

  add(classifyArabicScript(text.replace(/[^\p{Script=Arabic}\s]+/gu, ' ')), counts.arabic);

  if (counts.latin >= MIN_LETTERS_FOR_DETECTION) {
    add(detectLatin(text.replace(/[^\p{Script=Latin}\p{M}\s'\u2019-]+/gu, ' ')).code, counts.latin);
  } else if (letters === counts.latin) {
    // A page that is only a few Latin words stays undetermined. The same words inside a text of another script
    // (English terms in Arabic prose) are not a language of their own and are not counted.
    add('und', counts.latin);
  }
  for (const script of [
    'cyrillic',
    'greek',
    'hebrew',
    'han',
    'kana',
    'hangul',
    'devanagari',
    'thai',
  ] as const) {
    add(SCRIPT_DEFAULT_LANGUAGE[script], counts[script]);
  }
  return result;
}

/**
 * Language shares of a whole document by letter count. A page contributes per script group, so a bilingual page
 * counts for both of its languages. `und` is dropped as soon as any language is known. Sorted by share, largest
 * first; shares add up to 1.
 */
export function summarizeLanguages(pages: readonly { text: string }[]): LanguageShare[] {
  const totals = new Map<string, number>();
  for (const page of pages) {
    for (const [code, letters] of languageLetters(page.text))
      totals.set(code, (totals.get(code) ?? 0) + letters);
  }
  if (totals.size > 1) totals.delete('und');
  const sum = [...totals.values()].reduce((a, b) => a + b, 0);
  if (sum === 0) return [];
  return [...totals.entries()]
    .map(([code, letters]) => ({ code, share: letters / sum }))
    .sort((a, b) => b.share - a.share || a.code.localeCompare(b.code));
}

/** The language with the largest share, or `und` for an empty summary. */
export function primaryLanguage(languages: readonly LanguageShare[]): string {
  return languages[0]?.code ?? 'und';
}

/** Direction of a document: that of its primary language (`und` falls back to the text's own letters). */
export function documentDirection(languages: readonly LanguageShare[], fallbackText = ''): Direction {
  const primary = primaryLanguage(languages);
  return primary === 'und' ? dominantDirection(fallbackText) : directionForLanguage(primary);
}
