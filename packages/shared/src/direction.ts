import type { Direction } from './api.js';

/** Primary language subtags written right to left. */
export const RTL_LANGUAGES = ['ar', 'fa', 'ur', 'he', 'ps', 'sd', 'ug', 'yi', 'ckb'] as const;

// ISO 639-3 spellings that language detectors (franc, tesseract) emit for the same languages.
const RTL_LANGUAGE_ALIASES: Record<string, string> = {
  ara: 'ar',
  arb: 'ar',
  fas: 'fa',
  pes: 'fa',
  urd: 'ur',
  heb: 'he',
  pus: 'ps',
  pbt: 'ps',
  snd: 'sd',
  uig: 'ug',
  yid: 'yi',
};

/** Direction for a BCP 47 / ISO 639 language code such as "ar", "ar-EG", "fa" or "urd". */
export function directionForLanguage(code: string): Direction {
  const primary = code.trim().toLowerCase().split(/[-_]/)[0] ?? '';
  const language = RTL_LANGUAGE_ALIASES[primary] ?? primary;
  return (RTL_LANGUAGES as readonly string[]).includes(language) ? 'rtl' : 'ltr';
}

const RTL_LETTER =
  /[\p{Script=Arabic}\p{Script=Hebrew}\p{Script=Syriac}\p{Script=Thaana}\p{Script=Nko}\p{Script=Samaritan}\p{Script=Mandaic}]/u;
const LETTER = /\p{L}/gu;

/**
 * Direction of a piece of text: 'rtl' when at least half of its letters are strongly right-to-left.
 * Digits, punctuation and marks are neutral; text without any letter is 'ltr'.
 */
export function dominantDirection(text: string): Direction {
  let rtl = 0;
  let total = 0;
  for (const letter of text.match(LETTER) ?? []) {
    total += 1;
    if (RTL_LETTER.test(letter)) rtl += 1;
  }
  return total > 0 && rtl / total >= 0.5 ? 'rtl' : 'ltr';
}
