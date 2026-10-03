import type { Direction } from '@enchanted/shared';

const RTL_LETTER =
  /[\p{Script=Arabic}\p{Script=Hebrew}\p{Script=Syriac}\p{Script=Thaana}\p{Script=Nko}\p{Script=Samaritan}\p{Script=Mandaic}]/u;
const LETTER = /\p{L}/u;

/** The direction a browser gives `dir="auto"` text: that of its first letter with a direction; left to right with none. */
export function firstStrongDirection(text: string): Direction {
  for (const character of text) {
    if (RTL_LETTER.test(character)) return 'rtl';
    if (LETTER.test(character)) return 'ltr';
  }
  return 'ltr';
}

const PERSIAN_ONLY = /[پچژگ]/u;
const URDU_ONLY = /[ٹڈڑںھے]/u;

/**
 * A language label for the reader's or the diary's writing, so screen readers pick the right voice and the Arabic faces apply:
 * `ar`, `fa`, `ur` or `he` when most of the letters are in that script; undefined for everything else (the text then inherits
 * the interface language: a Latin-script question is not told apart from another Latin-script language).
 */
export function detectLang(text: string): 'ar' | 'fa' | 'ur' | 'he' | undefined {
  let arabic = 0;
  let hebrew = 0;
  let total = 0;
  for (const character of text) {
    if (!LETTER.test(character)) continue;
    total += 1;
    if (/\p{Script=Arabic}/u.test(character)) arabic += 1;
    else if (/\p{Script=Hebrew}/u.test(character)) hebrew += 1;
  }
  if (total === 0) return undefined;
  if (arabic / total > 0.5) {
    if (PERSIAN_ONLY.test(text)) return 'fa';
    if (URDU_ONLY.test(text)) return 'ur';
    return 'ar';
  }
  return hebrew / total > 0.5 ? 'he' : undefined;
}

/**
 * The interface language whose copy the diary's own lines should use for a question: its own lines follow the question's script
 * (an Arabic question gets the Arabic line, a Latin one the English line), whatever the interface is set to; a question with no
 * letters (digits, symbols) falls back to the interface language.
 */
export function scriptLanguage(question: string, fallback: 'en' | 'ar'): 'en' | 'ar' {
  let arabic = 0;
  let latin = 0;
  for (const character of question) {
    if (/\p{Script=Arabic}/u.test(character)) arabic += 1;
    else if (/\p{Script=Latin}/u.test(character)) latin += 1;
  }
  if (arabic === 0 && latin === 0) return fallback;
  return arabic >= latin ? 'ar' : 'en';
}
