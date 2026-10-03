import type { Direction } from '@enchanted/shared';
import type { Paragraph } from './format';
import { firstStrongDirection } from './language';
import { segmentInk, type InkUnit } from './segment';

/*
 * An answer as the pen writes it: paragraphs of runs of ink units (see segment.ts). The pen's progress is a count of the
 * pieces of ink that carry weight (glyphs, and whole words in Arabic and other joined scripts); white space and line breaks
 * ride along with the piece before them, so a space never costs a pause of its own.
 */

export type InkItem = { kind: 'br' } | { kind: 'text'; bold: boolean; units: InkUnit[] };

export interface InkParagraph {
  items: InkItem[];
}

export interface InkDoc {
  paragraphs: InkParagraph[];
  /** Number of pieces of ink (glyphs and words) in the whole answer. */
  total: number;
}

export const weighs = (unit: InkUnit): boolean => unit.kind === 'glyph' || unit.kind === 'word';

export function buildInkDoc(paragraphs: readonly Paragraph[]): InkDoc {
  let total = 0;
  const built = paragraphs.map<InkParagraph>((paragraph) => ({
    items: paragraph.inlines.map<InkItem>((inline) => {
      if (inline.kind === 'br') return { kind: 'br' };
      const units = segmentInk(inline.text);
      total += units.filter(weighs).length;
      return { kind: 'text', bold: inline.bold, units };
    }),
  }));
  return { paragraphs: built, total };
}

/**
 * The part of the answer on the page when the pen has written `count` pieces of ink: up to the count-th piece and the white
 * space after it. Pieces that are fully shown keep their identity from one call to the next (same text, same objects), so
 * a renderer can skip them.
 */
export function revealedDoc(doc: InkDoc, count: number): InkParagraph[] {
  const out: InkParagraph[] = [];
  let left = count;
  for (const paragraph of doc.paragraphs) {
    if (left <= 0) break;
    const items: InkItem[] = [];
    for (const item of paragraph.items) {
      if (item.kind === 'br') {
        if (left > 0) items.push(item);
        continue;
      }
      if (left <= 0) break;
      const total = item.units.filter(weighs).length;
      if (left >= total) {
        items.push(item);
        left -= total;
        continue;
      }
      let end = 0;
      let seen = 0;
      while (end < item.units.length) {
        const unit = item.units[end];
        if (unit && weighs(unit)) {
          if (seen === left) break;
          seen += 1;
        }
        end += 1;
      }
      // White space right after the last revealed piece rides along with it.
      for (let unit = item.units[end]; unit && !weighs(unit); unit = item.units[end]) end += 1;
      items.push({ kind: 'text', bold: item.bold, units: item.units.slice(0, end) });
      left = 0;
    }
    if (items.length > 0) out.push({ items });
  }
  return out;
}

/** How many pieces of ink the first `leadChars` characters of the answer (as plain text) take. */
export function leadUnitCount(doc: InkDoc, leadChars: number): number {
  let characters = 0;
  let pieces = 0;
  for (const [index, paragraph] of doc.paragraphs.entries()) {
    if (index > 0) characters += 2;
    for (const item of paragraph.items) {
      if (item.kind === 'br') {
        characters += 1;
        continue;
      }
      for (const unit of item.units) {
        if (characters + unit.text.length > leadChars && weighs(unit)) return pieces;
        characters += unit.text.length;
        if (weighs(unit)) pieces += 1;
      }
    }
  }
  return pieces;
}

/** For each paragraph: its direction (that of its first letter with one, as dir="auto" decides) and where each item's pieces of ink start in the whole answer. */
export function paragraphLayout(doc: InkDoc): { direction: Direction; starts: number[] }[] {
  let count = 0;
  return doc.paragraphs.map((paragraph) => {
    const text = paragraph.items
      .map((item) => (item.kind === 'text' ? item.units.map((unit) => unit.text).join('') : ''))
      .join('');
    const starts = paragraph.items.map((item) => {
      const start = count;
      if (item.kind === 'text') count += item.units.filter(weighs).length;
      return start;
    });
    return { direction: firstStrongDirection(text), starts };
  });
}

/** Which piece of the answer each unit is, from `start` (-1 for white space). */
export function pieceIndexes(units: readonly InkUnit[], start: number): number[] {
  let piece = start;
  return units.map((unit) => (weighs(unit) ? piece++ : -1));
}
