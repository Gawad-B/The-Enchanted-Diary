import type { Direction } from '@enchanted/shared';

/*
 * What lands on the page as one piece of ink. Latin, Greek and Cyrillic text is written glyph by glyph (a grapheme
 * cluster each, so a combining accent never lands apart from its letter). Scripts that join letters, or write without
 * spaces (Arabic, Hebrew, Indic, Thai, Khmer, Han, Kana, Hangul ...), are written word by word: splitting an Arabic word
 * into one element per letter would break its joining, so a unit is never smaller than a word there.
 */

export type UnitKind = 'glyph' | 'word' | 'space' | 'break';
/** The direction a unit asks for: letters of a right-to-left script, letters/digits of the others, or neither. */
export type UnitScript = 'rtl' | 'ltr' | 'neutral';

export interface InkUnit {
  text: string;
  kind: UnitKind;
  script: UnitScript;
}

const WORD_BY_WORD =
  /[\p{Script=Arabic}\p{Script=Hebrew}\p{Script=Syriac}\p{Script=Thaana}\p{Script=Nko}\p{Script=Mandaic}\p{Script=Devanagari}\p{Script=Bengali}\p{Script=Gurmukhi}\p{Script=Gujarati}\p{Script=Oriya}\p{Script=Tamil}\p{Script=Telugu}\p{Script=Kannada}\p{Script=Malayalam}\p{Script=Sinhala}\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}\p{Script=Tibetan}\p{Script=Mongolian}\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
const RTL_LETTER =
  /[\p{Script=Arabic}\p{Script=Hebrew}\p{Script=Syriac}\p{Script=Thaana}\p{Script=Nko}\p{Script=Samaritan}\p{Script=Mandaic}]/u;
const LETTER_OR_DIGIT = /[\p{L}\p{N}]/u;

let wordSegmenter: Intl.Segmenter | undefined;
let graphemeSegmenter: Intl.Segmenter | undefined;

function segmenters(): { word: Intl.Segmenter; grapheme: Intl.Segmenter } {
  wordSegmenter ??= new Intl.Segmenter(undefined, { granularity: 'word' });
  graphemeSegmenter ??= new Intl.Segmenter(undefined, { granularity: 'grapheme' });
  return { word: wordSegmenter, grapheme: graphemeSegmenter };
}

function scriptOf(text: string): UnitScript {
  if (RTL_LETTER.test(text)) return 'rtl';
  return LETTER_OR_DIGIT.test(text) ? 'ltr' : 'neutral';
}

/** The units of a text, in order. Joining them gives the text back, exactly. */
export function segmentInk(text: string): InkUnit[] {
  if (text === '') return [];
  const { word, grapheme } = segmenters();
  const units: InkUnit[] = [];
  for (const piece of word.segment(text)) {
    if (piece.isWordLike === true && WORD_BY_WORD.test(piece.segment)) {
      units.push({ text: piece.segment, kind: 'word', script: scriptOf(piece.segment) });
      continue;
    }
    for (const part of grapheme.segment(piece.segment)) {
      const value = part.segment;
      if (value === '\n' || value === '\r' || value === '\r\n') {
        units.push({ text: value, kind: 'break', script: 'neutral' });
      } else if (/^\s+$/u.test(value)) {
        units.push({ text: value, kind: 'space', script: 'neutral' });
      } else {
        units.push({ text: value, kind: 'glyph', script: scriptOf(value) });
      }
    }
  }
  return units;
}

/** The words of a question, in reading order (which is the order of the text, right-to-left scripts included). */
export function wordsOf(text: string): string[] {
  return text.split(/\s+/u).filter((word) => word !== '');
}

export interface Run {
  /** A left-to-right run inside right-to-left text: wrapped in <bdi> so its order is its own. */
  isolate: boolean;
  units: InkUnit[];
}

/**
 * Groups the units of right-to-left text into runs: every stretch from the first to the last left-to-right unit (Latin
 * words, numbers) is one isolated run, so Latin inside Arabic keeps its own order and its neighbours' punctuation does
 * not pull it around. A line break ends a run. In left-to-right text nothing is isolated, unless `symmetric` is set (the diary's
 * answers): then a stretch of right-to-left words inside a left-to-right paragraph is isolated the same way, so an Arabic quotation
 * in an English sentence keeps its own order and its punctuation does not jump to the wrong end.
 */
export function groupRuns(
  units: readonly InkUnit[],
  direction: Direction,
  options: { symmetric?: boolean } = {},
): Run[] {
  if (direction === 'ltr') {
    if (options.symmetric === true) return groupForeign(units, 'rtl');
    return units.length === 0 ? [] : [{ isolate: false, units: [...units] }];
  }
  return groupForeign(units, 'ltr');
}

/**
 * Isolated runs of the units whose script is `foreign` (the opposite of the paragraph's direction): the stretch from the first
 * to the last such unit, with the neutrals between them; neutrals around it and units of the paragraph's own direction stay
 * outside; a line break ends a run.
 */
function groupForeign(units: readonly InkUnit[], foreign: 'ltr' | 'rtl'): Run[] {
  const runs: Run[] = [];
  let outside: InkUnit[] = [];
  let inside: InkUnit[] = [];
  let pendingNeutral: InkUnit[] = [];
  const flushOutside = (): void => {
    if (outside.length > 0) runs.push({ isolate: false, units: outside });
    outside = [];
  };
  const closeInside = (): void => {
    if (inside.length > 0) {
      flushOutside();
      runs.push({ isolate: true, units: inside });
      inside = [];
    }
    outside.push(...pendingNeutral);
    pendingNeutral = [];
  };
  for (const unit of units) {
    if (unit.kind === 'break') {
      closeInside();
      outside.push(unit);
    } else if (unit.script === foreign) {
      if (inside.length === 0) {
        // The neutrals before the run (spaces) stay outside it.
        outside.push(...pendingNeutral);
        pendingNeutral = [];
      } else {
        inside.push(...pendingNeutral);
        pendingNeutral = [];
      }
      inside.push(unit);
    } else if (unit.script === 'neutral') {
      pendingNeutral.push(unit);
    } else {
      closeInside();
      outside.push(unit);
    }
  }
  closeInside();
  flushOutside();
  return runs;
}

export interface KeyedUnit {
  id: number;
  unit: InkUnit;
}

const same = (a: InkUnit, b: InkUnit): boolean => a.text === b.text && a.kind === b.kind;

/**
 * Gives the next units the identities of the previous ones that did not change (the common start and the common end), and
 * new identities to the rest. React then keeps the DOM node of every unit that was already on the page, so a glyph that
 * landed does not land again when the reader types after it or before it.
 */
export function diffUnits(
  previous: readonly KeyedUnit[],
  next: readonly InkUnit[],
  newId: () => number,
): KeyedUnit[] {
  let start = 0;
  while (start < previous.length && start < next.length) {
    const before = previous[start];
    const after = next[start];
    if (!before || !after || !same(before.unit, after)) break;
    start += 1;
  }
  let end = 0;
  while (end < previous.length - start && end < next.length - start) {
    const before = previous[previous.length - 1 - end];
    const after = next[next.length - 1 - end];
    if (!before || !after || !same(before.unit, after)) break;
    end += 1;
  }
  return next.map((unit, index) => {
    if (index < start) return { id: previous[index]?.id ?? newId(), unit };
    if (index >= next.length - end) {
      return { id: previous[previous.length - (next.length - index)]?.id ?? newId(), unit };
    }
    return { id: newId(), unit };
  });
}
