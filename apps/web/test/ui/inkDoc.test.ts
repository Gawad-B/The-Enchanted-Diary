import { describe, expect, it } from 'vitest';
import { parseAnswer } from '../../src/ui/diary/format';
import { buildInkDoc, leadUnitCount, revealedDoc, type InkDoc } from '../../src/ui/diary/inkDoc';

const doc = (text: string): InkDoc => buildInkDoc(parseAnswer(text, false));
/** The text that is on the page at a given reveal count. */
const shown = (d: InkDoc, count: number): string =>
  revealedDoc(d, count)
    .map((paragraph) =>
      paragraph.items
        .map((item) => (item.kind === 'br' ? '\n' : item.units.map((unit) => unit.text).join('')))
        .join(''),
    )
    .join('\n\n');

describe('inkDoc: an answer as the pieces of ink the pen writes', () => {
  it('counts glyphs and words, not spaces or line breaks', () => {
    expect(doc('ab c').total).toBe(3);
    expect(doc('مرحبا بكم').total).toBe(2);
    expect(doc('One.\nTwo.\n\nThree').total).toBe('One.Two.Three'.length);
  });

  it('reveals up to the n-th piece of ink, together with the white space that follows it', () => {
    const d = doc('ab cd');
    expect(shown(d, 0)).toBe('');
    expect(shown(d, 1)).toBe('a');
    expect(shown(d, 2)).toBe('ab ');
    expect(shown(d, 3)).toBe('ab c');
    expect(shown(d, 4)).toBe('ab cd');
    expect(shown(d, 99)).toBe('ab cd');
  });

  it('reveals Arabic a whole word at a time', () => {
    const d = doc('من أسّس المدرسة');
    expect(shown(d, 1)).toBe('من ');
    expect(shown(d, 2)).toBe('من أسّس ');
  });

  it('reveals paragraphs one after another, keeping bold and breaks', () => {
    const d = doc('A **b** c\nd\n\nE');
    expect(shown(d, d.total)).toBe('A b c\nd\n\nE');
    expect(revealedDoc(d, 3)[0]?.items.some((item) => item.kind === 'text' && item.bold)).toBe(true);
    // a paragraph none of whose ink is revealed yet is not on the page
    expect(revealedDoc(d, 4)).toHaveLength(1);
    expect(revealedDoc(d, 5)).toHaveLength(2);
  });

  it('tells how many pieces of ink the lead (the first sentence) takes', () => {
    const d = doc('It was founded. And then the rest.');
    expect(leadUnitCount(d, 'It was founded.'.length)).toBe('Itwasfounded.'.length);
    expect(leadUnitCount(d, 0)).toBe(0);
    expect(leadUnitCount(d, 10_000)).toBe(d.total);
  });

  it('pieces that are fully shown keep their identity from one count to the next, so a renderer can skip them', () => {
    const d = doc('Hello world\n\nSecond');
    const before = revealedDoc(d, 12)[0]?.items[0];
    const after = revealedDoc(d, 14)[0]?.items[0];
    expect(before).toBeDefined();
    expect(after).toBe(before);
  });
});
