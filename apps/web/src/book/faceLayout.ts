import { dominantDirection, type Direction, type DocumentDetail } from '@enchanted/shared';
import type { Language, Strings } from '../i18n/strings';
import { format } from '../i18n/strings/format';

/*
 * What the diary writes on its own pages, as pure data (no canvas): the bookplate's lines and the helpers
 * that keep text safe and fitted. The drawing lives in ParchmentPageSource.
 */

const MAX_FILENAME_CHARS = 120;

/**
 * A file name that is safe to draw: the last path segment, without control characters, bidirectional
 * embedding/override/isolate controls (U+202A-U+202E, U+2066-U+2069), tag characters, or anything that could
 * reorder the surrounding text, collapsed whitespace, and at most 120 characters (the server does the same;
 * this is the second line of defence).
 */
export function sanitizeFilename(name: string, maxChars = MAX_FILENAME_CHARS): string {
  const lastSegment = name.split(/[\\/]/).pop() ?? '';
  const cleaned = Array.from(lastSegment)
    .filter((char) => {
      const code = char.codePointAt(0) ?? 0;
      if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) return false; // control characters
      if (code >= 0x202a && code <= 0x202e) return false; // bidi embedding and override
      if (code >= 0x2066 && code <= 0x2069) return false; // bidi isolates
      if (code === 0x200e || code === 0x200f || code === 0x061c) return false; // implicit direction marks
      if (code >= 0xe0000 && code <= 0xe007f) return false; // tag characters
      return code !== 0xfeff && code !== 0x2028 && code !== 0x2029;
    })
    .join('')
    .replace(/\s+/g, ' ')
    .trim();
  const characters = Array.from(cleaned);
  return characters.length > maxChars ? `${characters.slice(0, maxChars - 1).join('')}\u2026` : cleaned;
}

/** Shortens `text` with an ellipsis until `measure` says it fits `maxWidth`. */
export function fitText(text: string, maxWidth: number, measure: (candidate: string) => number): string {
  if (measure(text) <= maxWidth) return text;
  const characters = Array.from(text);
  while (characters.length > 1) {
    characters.pop();
    const candidate = `${characters.join('').trimEnd()}\u2026`;
    if (measure(candidate) <= maxWidth) return candidate;
  }
  return '\u2026';
}

/** Greedy word wrap with a caller-supplied width measure; a word wider than the line stays on its own line. */
export function wrapWords(text: string, maxWidth: number, measure: (candidate: string) => number): string[] {
  const words = text.split(/\s+/).filter((word) => word.length > 0);
  const lines: string[] = [];
  let line = '';
  for (const word of words) {
    const candidate = line === '' ? word : `${line} ${word}`;
    if (line !== '' && measure(candidate) > maxWidth) {
      lines.push(line);
      line = word;
    } else {
      line = candidate;
    }
  }
  if (line !== '') lines.push(line);
  return lines;
}

export type BookplateInput = Pick<
  DocumentDetail,
  'filename' | 'pageCount' | 'languages' | 'primaryLanguage' | 'createdAt'
>;

export interface BookplateModel {
  heading: string;
  /** The sanitised file name. */
  title: string;
  /** Base direction to draw the title with, so a mixed Arabic and Latin name reads correctly. */
  titleDirection: Direction;
  pages: string;
  /** null when no language is known. */
  languages: string | null;
  bound: string;
}

/** The languages worth naming: those with a tenth of the text or more, at most three, largest first. */
export function significantLanguages(
  languages: BookplateInput['languages'],
  primaryLanguage: string,
): string[] {
  const picked = [...languages]
    .filter((entry) => entry.share >= 0.1 && entry.code !== 'und')
    .sort((a, b) => b.share - a.share)
    .slice(0, 3)
    .map((entry) => entry.code);
  if (picked.length === 0 && primaryLanguage !== 'und' && primaryLanguage !== '')
    picked.push(primaryLanguage);
  return picked;
}

function languageName(code: string, uiLanguage: Language): string {
  try {
    return new Intl.DisplayNames([uiLanguage], { type: 'language' }).of(code) ?? code;
  } catch {
    return code;
  }
}

/** The lines of the bookplate for a document, in the interface language. */
export function bookplateModel(
  document: BookplateInput,
  copy: Strings['scene']['bookplate'],
  uiLanguage: Language,
): BookplateModel {
  const title = sanitizeFilename(document.filename);
  const named = significantLanguages(document.languages, document.primaryLanguage).map((code) =>
    languageName(code, uiLanguage),
  );
  const date = new Date(document.createdAt);
  const bound = Number.isNaN(date.getTime())
    ? ''
    : new Intl.DateTimeFormat(uiLanguage, { dateStyle: 'long' }).format(date);
  return {
    heading: copy.heading,
    title,
    titleDirection: dominantDirection(title),
    pages: document.pageCount === 1 ? copy.pageOne : format(copy.pages, { n: document.pageCount }),
    languages:
      named.length > 0
        ? format(copy.languages, { languages: named.join(uiLanguage === 'ar' ? '، ' : ', ') })
        : null,
    bound: bound === '' ? '' : format(copy.bound, { date: bound }),
  };
}
