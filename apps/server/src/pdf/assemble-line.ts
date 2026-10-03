import type { Direction } from '@enchanted/shared';
import { mirrorPairedPunctuation } from './mirror.js';

/*
 * Turning the text items of ONE visual line into logical text.
 *
 * What pdf.js gives us (verified against Chromium, LibreOffice and legacy producers, see the tech-verification
 * report): the characters INSIDE an item are already in logical order, but the ITEMS arrive in the order the
 * producer drew them, which is visual left-to-right. Word-level producers therefore give an Arabic line with its
 * words reversed, glyph-level producers (Droid, Vazirmatn) split a word into several items in visual order.
 * This module puts the items back in logical order: it never reverses a string, it only decides in which order
 * the items are emitted and where the spaces go.
 */

export interface LineItem {
  text: string;
  /** Left and right edge on the page, left to right, in any consistent unit. */
  x0: number;
  x1: number;
  fontSize: number;
}

type Class = 'R' | 'L' | 'N';

const RTL_LETTER = /[\p{Script=Arabic}\p{Script=Hebrew}\p{Script=Syriac}\p{Script=Thaana}\p{Script=Nko}]/gu;
const ANY_LETTER = /\p{L}/gu;
const DIGIT = /\p{Nd}/gu;

/** A space is inserted where two items are further apart than this share of the font size. */
export const WORD_GAP_EM = 0.25;

/** Letters of a text that read right to left and left to right, and its digits (of any script). */
export function directionalCounts(text: string): { rtl: number; ltr: number; digits: number } {
  const rtl = text.match(RTL_LETTER)?.length ?? 0;
  const letters = text.match(ANY_LETTER)?.length ?? 0;
  return { rtl, ltr: letters - rtl, digits: text.match(DIGIT)?.length ?? 0 };
}

/** R or L by the letters of the text; numbers alone are L (they are written left to right); N without either. */
function classify(text: string): Class {
  const { rtl, ltr, digits } = directionalCounts(text);
  if (rtl === 0 && ltr === 0) return digits > 0 ? 'L' : 'N';
  return rtl > ltr ? 'R' : 'L';
}

/**
 * The paragraph direction of a group of items: whichever direction has more letters. Digits do not decide, so
 * a line of numbers alone has no direction (null) and takes the one of its block or page.
 */
export function baseDirectionOf(items: readonly { text: string }[]): Direction | null {
  let rtl = 0;
  let ltr = 0;
  for (const item of items) {
    const counts = directionalCounts(item.text);
    rtl += counts.rtl;
    ltr += counts.ltr;
  }
  if (rtl === 0 && ltr === 0) return null;
  return rtl > ltr ? 'rtl' : 'ltr';
}

/**
 * The direction a line is written in when its two visual ends agree: the leftmost and the rightmost item that
 * contain letters (numbers and punctuation do not count) are both right-to-left or both left-to-right. Such a
 * line is a paragraph of that direction whatever its letter counts say (an English sentence quoting a long
 * Arabic phrase, an Arabic sentence with a long English term inside). When the ends disagree (a left-to-right
 * term at one end of an Arabic line) it returns null and the caller falls back to the surrounding block.
 */
export function edgeDirection(items: readonly LineItem[]): Direction | null {
  const lettered = [...items]
    .filter((item) => item.text !== '')
    .map((item) => ({ item, cls: lettersClass(item.text) }))
    .filter((entry) => entry.cls !== null)
    .sort((a, b) => a.item.x0 - b.item.x0);
  const left = lettered[0]?.cls;
  const right = lettered[lettered.length - 1]?.cls;
  if (left === undefined || right === undefined || left !== right) return null;
  return left === 'R' ? 'rtl' : 'ltr';
}

/** R or L by the letters of the text only (digits do not decide); null without letters. */
function lettersClass(text: string): 'R' | 'L' | null {
  const { rtl, ltr } = directionalCounts(text);
  if (rtl === 0 && ltr === 0) return null;
  return rtl > ltr ? 'R' : 'L';
}

interface Run {
  cls: 'R' | 'L';
  items: LineItem[];
  x0: number;
  x1: number;
}

/**
 * Logical text of a visual line.
 *
 *  1. Items are sorted by x ascending (the order they appear on the page, left to right).
 *  2. Each item is classified right-to-left (R), left-to-right (L: Latin letters, digits of either kind) or
 *     neutral (spaces, punctuation). A neutral item between two items of the same direction takes that
 *     direction, otherwise the paragraph direction: so "MS-4471" or a two-word English term stays one run.
 *  3. Items of equal direction form runs. Runs are emitted in reading order: right to left in a right-to-left
 *     paragraph, left to right in a left-to-right one. Inside a run, right-to-left items are emitted
 *     right-to-left (their strings are already logical), left-to-right items left to right.
 *  4. A space is added only where the geometric gap between consecutive items exceeds a quarter of the font
 *     size and neither side already has whitespace there.
 */
export function assembleLine(items: readonly LineItem[], base: Direction): string {
  const sorted = [...items].filter((item) => item.text !== '').sort((a, b) => a.x0 - b.x0 || a.x1 - b.x1);
  if (sorted.length === 0) return '';
  const baseClass: 'R' | 'L' = base === 'rtl' ? 'R' : 'L';

  const classes: Class[] = sorted.map((item) => classify(item.text));
  const resolved: ('R' | 'L')[] = classes.map(() => baseClass);
  let previousStrong: 'R' | 'L' | null = null;
  const previousStrongAt: ('R' | 'L' | null)[] = [];
  for (const cls of classes) {
    if (cls !== 'N') previousStrong = cls;
    previousStrongAt.push(previousStrong);
  }
  let nextStrong: 'R' | 'L' | null = null;
  for (let i = classes.length - 1; i >= 0; i -= 1) {
    const cls = classes[i] ?? 'N';
    if (cls !== 'N') {
      resolved[i] = cls;
      nextStrong = cls;
    } else {
      const before = previousStrongAt[i] ?? null;
      resolved[i] = before !== null && before === nextStrong ? before : baseClass;
    }
  }

  const runs: Run[] = [];
  sorted.forEach((item, i) => {
    const cls = resolved[i] ?? baseClass;
    const last = runs[runs.length - 1];
    if (last?.cls === cls) {
      last.items.push(item);
      last.x0 = Math.min(last.x0, item.x0);
      last.x1 = Math.max(last.x1, item.x1);
    } else {
      runs.push({ cls, items: [item], x0: item.x0, x1: item.x1 });
    }
  });

  const ordered = base === 'rtl' ? [...runs].reverse() : runs;
  let text = '';
  let previous: { item: LineItem; run: Run } | null = null;
  for (const run of ordered) {
    const emission = run.cls === 'R' ? [...run.items].reverse() : run.items;
    for (const item of emission) {
      if (previous !== null) {
        const gap = gapBetween(previous, { item, run }, base);
        const spaceNeeded = gap > WORD_GAP_EM * Math.max(previous.item.fontSize, item.fontSize);
        if (spaceNeeded && !/\s$/u.test(text) && !/^\s/u.test(item.text)) text += ' ';
      }
      // Brackets in a right-to-left run were drawn mirrored: put them back (see mirror.ts).
      text += run.cls === 'R' ? mirrorPairedPunctuation(item.text) : item.text;
      previous = { item, run };
    }
  }
  return text;
}

/**
 * The visual distance between two consecutively emitted items. Inside a run it is the distance between the
 * facing edges of the two items; between runs it is the distance between the facing edges of the two runs
 * (the items on both sides of the join are not the ones that touch on the page).
 */
function gapBetween(
  previous: { item: LineItem; run: Run },
  next: { item: LineItem; run: Run },
  base: Direction,
): number {
  if (previous.run === next.run) {
    return previous.run.cls === 'R' ? previous.item.x0 - next.item.x1 : next.item.x0 - previous.item.x1;
  }
  return base === 'rtl' ? previous.run.x0 - next.run.x1 : next.run.x0 - previous.run.x1;
}
