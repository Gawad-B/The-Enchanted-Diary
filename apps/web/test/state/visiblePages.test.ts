import { describe, expect, it } from 'vitest';
import { visiblePagesOf } from '../../src/state/visiblePages';

const base = {
  direction: 'ltr',
  pageCount: 10,
  hasDocument: true,
  spread: 2,
  focusSide: null,
  narrow: false,
  closely: false,
} as const;

describe('visiblePagesOf: the pages the reader sees, sent with each question', () => {
  it('a spread shows its two pages', () => {
    expect(visiblePagesOf({ ...base, spread: 2 })).toEqual([3, 4]);
    expect(visiblePagesOf({ ...base, spread: 1 })).toEqual([1, 2]);
  });

  it('is the same pair in a right-to-left book (the numbers are the pages, not the sides)', () => {
    expect(visiblePagesOf({ ...base, direction: 'rtl', spread: 2 })).toEqual([3, 4]);
  });

  it('the bookplate spread shows no page', () => {
    expect(visiblePagesOf({ ...base, spread: 0 })).toEqual([]);
  });

  it('leaves out the blank face past the last page', () => {
    expect(visiblePagesOf({ ...base, pageCount: 5, spread: 3 })).toEqual([5]);
  });

  it('a narrow screen shows one page: the one on the side in view', () => {
    expect(visiblePagesOf({ ...base, narrow: true, spread: 2, focusSide: 'left' })).toEqual([3]);
    expect(visiblePagesOf({ ...base, narrow: true, spread: 2, focusSide: 'right' })).toEqual([4]);
    expect(
      visiblePagesOf({ ...base, direction: 'rtl', narrow: true, spread: 2, focusSide: 'right' }),
    ).toEqual([3]);
  });

  it('"read closely" shows one page too', () => {
    expect(visiblePagesOf({ ...base, closely: true, spread: 2, focusSide: 'left' })).toEqual([3]);
  });

  it('no document, no pages', () => {
    expect(visiblePagesOf({ ...base, hasDocument: false, pageCount: 0 })).toEqual([]);
  });
});
