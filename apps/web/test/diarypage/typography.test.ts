import { describe, expect, it } from 'vitest';
import {
  BASELINE_IN_ROW,
  MARGIN_BINDING,
  MARGIN_BOTTOM,
  MARGIN_OUTER,
  MARGIN_TOP,
  PAGE_HEIGHT,
  PAGE_WIDTH,
  PITCH,
  ROWS,
  RULE_IN_ROW,
  baselineOf,
  columnOf,
  fontOf,
  fontsToLoad,
  rowTop,
} from '../../src/diarypage/typography';
import { PAGE_ASPECT } from '../../src/book/pageAspect';

describe('the design page', () => {
  it('has the proportions of a leaf of the book, so it lies on the 3D page without stretching', () => {
    expect(PAGE_HEIGHT / PAGE_WIDTH).toBeCloseTo(PAGE_ASPECT, 2);
  });

  it('holds whole rows of writing between its margins, and the last row ends above the bottom margin', () => {
    expect(ROWS).toBe(Math.floor((PAGE_HEIGHT - MARGIN_TOP - MARGIN_BOTTOM) / PITCH));
    expect(rowTop(ROWS)).toBeLessThanOrEqual(PAGE_HEIGHT - MARGIN_BOTTOM);
    expect(rowTop(ROWS - 1)).toBeLessThan(PAGE_HEIGHT - MARGIN_BOTTOM);
  });

  it('puts the baseline of a row above the ruling and both inside the row', () => {
    expect(baselineOf(3)).toBe(rowTop(3) + BASELINE_IN_ROW);
    expect(BASELINE_IN_ROW).toBeLessThan(RULE_IN_ROW);
    expect(RULE_IN_ROW).toBeLessThan(PITCH);
  });

  it('keeps the wider margin on the side of the binding: the left of a left-to-right book, the right of a right-to-left one', () => {
    const ltr = columnOf('ltr');
    const rtl = columnOf('rtl');
    expect(ltr.left).toBe(MARGIN_BINDING);
    expect(PAGE_WIDTH - ltr.right).toBe(MARGIN_OUTER);
    expect(rtl.left).toBe(MARGIN_OUTER);
    expect(PAGE_WIDTH - rtl.right).toBe(MARGIN_BINDING);
    expect(ltr.width).toBe(rtl.width);
  });
});

describe('the hands', () => {
  it('the diary answers in the very handwriting the question is written in: one hand for the question and the answer', () => {
    for (const faces of ['latin', 'arabic'] as const) {
      expect(fontOf('lead', faces)).toBe(fontOf('question', faces));
      expect(fontOf('fair', faces)).toBe(fontOf('question', faces));
    }
    expect(fontOf('question', 'latin')).toContain("'La Belle Aurore'");
    expect(fontOf('fair', 'arabic')).not.toContain('italic');
  });

  it('bold is a weight of the same hand', () => {
    expect(fontOf('fair', 'latin', true)).toContain('700');
    expect(fontOf('fair', 'latin', false)).not.toContain('700');
  });

  it('lists every hand of a script to load before text is measured', () => {
    expect(fontsToLoad('arabic')).toHaveLength(4);
    expect(fontsToLoad('latin').every(({ font, text }) => font.length > 0 && text.length > 0)).toBe(true);
  });
});
