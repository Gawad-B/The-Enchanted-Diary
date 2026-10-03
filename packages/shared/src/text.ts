/*
 * Text normalisation shared by the server (index time and query time) and the client (trigger matching).
 * Both ends must call the same functions, otherwise lexical retrieval silently stops matching.
 */

// Arabic marks that are written but not pronounced as letters: tashkeel (U+064B-U+065F), superscript alef
// (U+0670) and tatweel (U+0640). They are stripped because PDFs and users disagree about them.
const ARABIC_MARKS = /[\u064B-\u065F\u0670\u0640]/g;
const ARABIC_ALEF_FORMS = /[\u0623\u0625\u0622\u0671]/g; // أ إ آ ٱ
// Letters that Persian, Urdu and Kurdish write with their own code points where Arabic has one letter: kaf ک,
// yeh ی and ې, and the haa forms ہ ۀ ە. A scan read with the Persian or Urdu pack, and a query typed on an
// Arabic keyboard, must find each other. The letters only those languages have (پ چ ژ گ ...) are kept.
const PERSIAN_KAF = /\u06A9/g;
const PERSIAN_YEH_FORMS = /[\u06CC\u06D0]/g;
const PERSIAN_HAA_FORMS = /[\u06C1\u06C0\u06D5]/g;
const ARABIC_INDIC_AND_PERSIAN_DIGITS = /[\u0660-\u0669\u06F0-\u06F9]/g;
const FORMAT_CHARACTERS = /\p{Cf}/gu; // bidi controls, ZWJ/ZWNJ, soft hyphen, BOM
const APOSTROPHES = /['\u2018\u2019\u02BC]/g;
const PUNCTUATION_AND_SYMBOLS = /[\p{P}\p{S}]/gu;
const WHITESPACE_RUNS = /\s+/gu;

function asciiDigit(digit: string): string {
  const code = digit.charCodeAt(0);
  return String(code >= 0x06f0 ? code - 0x06f0 : code - 0x0660);
}

/**
 * The shared core: NFKC (folds Arabic presentation forms such as "ﻣﺮﺣﺒﺎ" and the ellipsis character into
 * "..."), lower case, invisible format characters and Arabic marks removed, alef / yaa / taa-marbuta
 * unified, the Persian / Urdu forms of kaf, yaa and haa folded onto the Arabic letters, Arabic-Indic and
 * Persian digits turned into ASCII digits, and apostrophes dropped.
 * Everything else that is punctuation or a symbol becomes a space, so "MS-4471" gives "ms 4471" and
 * "..." / ".." / "…" are all just separators.
 */
function normalizeCore(input: string): string {
  return input
    .normalize('NFKC')
    .toLowerCase()
    .replace(FORMAT_CHARACTERS, '')
    .replace(ARABIC_MARKS, '')
    .replace(ARABIC_ALEF_FORMS, '\u0627') // ا
    .replace(/\u0649/g, '\u064A') // ى -> ي
    .replace(/\u0629/g, '\u0647') // ة -> ه
    .replace(PERSIAN_KAF, '\u0643') // ک -> ك
    .replace(PERSIAN_YEH_FORMS, '\u064A') // ی ې -> ي
    .replace(PERSIAN_HAA_FORMS, '\u0647') // ہ ۀ ە -> ه
    .replace(ARABIC_INDIC_AND_PERSIAN_DIGITS, asciiDigit)
    .replace(APOSTROPHES, '')
    .replace(PUNCTUATION_AND_SYMBOLS, ' ')
    .replace(WHITESPACE_RUNS, ' ')
    .trim();
}

/** Normal form used to compare short messages with trigger phrases. */
export function normalizeForMatch(input: string): string {
  return normalizeCore(input);
}

// ---------------------------------------------------------------------------------------------------
// Search normalisation
// ---------------------------------------------------------------------------------------------------

const ARABIC_WORD = /^\p{Script=Arabic}+$/u;
const CJK_RUN = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+/gu;
const MIN_ARABIC_STEM_LENGTH = 3;

// Prefix combinations that the light stemmer removes: optional conjunction (و/ف), optional preposition
// (ب/ك/ل) and the article ال, or the contraction لل (ل + ال). A bare و/ف/ب/ك/ل is NOT stripped: it is far
// too often the first letter of the word itself (كتاب = "book", not "ك" + "تاب").
const ARABIC_PREFIXES = [/^[\u0648\u0641]?[\u0628\u0643\u0644]?\u0627\u0644/, /^[\u0648\u0641]?\u0644\u0644/];

function arabicLightStem(token: string): string | null {
  if (!ARABIC_WORD.test(token)) return null;
  for (const prefix of ARABIC_PREFIXES) {
    const match = prefix.exec(token);
    if (match) {
      const stem = token.slice(match[0].length);
      return stem.length >= MIN_ARABIC_STEM_LENGTH ? stem : null;
    }
  }
  return null;
}

function cjkBigrams(token: string): string[] {
  const bigrams: string[] = [];
  for (const run of token.match(CJK_RUN) ?? []) {
    const characters = Array.from(run);
    for (let i = 0; i + 1 < characters.length; i += 1) {
      bigrams.push(`${characters[i] ?? ''}${characters[i + 1] ?? ''}`);
    }
  }
  return bigrams;
}

export interface SearchTerms {
  /** The normalised words in reading order (use these for phrase queries). */
  surface: string[];
  /** Extra forms that widen recall: Arabic light stems and CJK character bigrams. No duplicates. */
  extra: string[];
}

/** Splits `input` into surface words plus the extra recall forms described on {@link SearchTerms}. */
export function searchTerms(input: string): SearchTerms {
  const normalized = normalizeCore(input);
  const surface = normalized === '' ? [] : normalized.split(' ');
  const known = new Set(surface);
  const extra: string[] = [];
  const addExtra = (term: string): void => {
    if (!known.has(term)) {
      known.add(term);
      extra.push(term);
    }
  };
  for (const token of surface) {
    const stem = arabicLightStem(token);
    if (stem !== null) addExtra(stem);
    cjkBigrams(token).forEach(addExtra);
  }
  return { surface, extra };
}

/**
 * Text for the `search_text` column and for lexical queries. Surface words come first and in order (so
 * adjacency still means adjacency); the extra recall forms follow.
 */
export function normalizeForSearch(input: string): string {
  const { surface, extra } = searchTerms(input);
  return [...surface, ...extra].join(' ');
}
