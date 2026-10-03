import { describe, expect, it } from 'vitest';
import { pageNumberFormat } from '../../src/ui/reader/numerals';
import { indicatorModel, pagingState, parsePageInput, type Position } from '../../src/ui/reader/paging';

const base: Position = { spread: 1, pageCount: 40, direction: 'ltr', focusSide: null, single: false };

describe('pagingState', () => {
  it('puts "next" on the unturned side: the right for LTR, the left for RTL', () => {
    expect(pagingState(base)).toMatchObject({ nextSide: 'right', prevSide: 'left' });
    expect(pagingState({ ...base, direction: 'rtl' })).toMatchObject({ nextSide: 'left', prevSide: 'right' });
  });

  it('wide: next is possible until the last spread; previous until the bookplate spread', () => {
    expect(pagingState({ ...base, spread: 0 })).toMatchObject({ canNext: true, canPrev: false });
    expect(pagingState({ ...base, spread: 1 })).toMatchObject({ canNext: true, canPrev: true });
    expect(pagingState({ ...base, spread: 20 })).toMatchObject({ canNext: false, canPrev: true });
    expect(pagingState({ ...base, pageCount: 39, spread: 20 })).toMatchObject({ canNext: false });
  });

  it('single page: walks page by page, so the last page is the end (LTR left page, then right page, then the next spread)', () => {
    const single = { ...base, single: true };
    expect(pagingState({ ...single, spread: 1, focusSide: 'left' })).toMatchObject({
      canNext: true,
      canPrev: true,
    });
    expect(pagingState({ ...single, spread: 20, focusSide: 'left' })).toMatchObject({ canNext: true }); // page 39 -> 40
    expect(pagingState({ ...single, spread: 20, focusSide: 'right' })).toMatchObject({ canNext: false }); // page 40
    expect(pagingState({ ...single, pageCount: 39, spread: 20, focusSide: 'left' })).toMatchObject({
      canNext: false,
    }); // page 39 is last
  });

  it('nothing to turn without a document', () => {
    expect(pagingState({ ...base, pageCount: 0, spread: 0 })).toMatchObject({
      canNext: false,
      canPrev: false,
    });
  });
});

describe('indicatorModel', () => {
  it('is the bookplate at spread 0, a pair of pages in the middle, and the last page alone when the count is odd', () => {
    expect(indicatorModel({ ...base, spread: 0 })).toEqual({ kind: 'bookplate' });
    expect(indicatorModel({ ...base, spread: 1 })).toEqual({ kind: 'pages', from: 1, to: 2, total: 40 });
    expect(indicatorModel({ ...base, spread: 2 })).toEqual({ kind: 'pages', from: 3, to: 4, total: 40 });
    expect(indicatorModel({ ...base, spread: 20 })).toEqual({ kind: 'pages', from: 39, to: 40, total: 40 });
    expect(indicatorModel({ ...base, pageCount: 39, spread: 20 })).toEqual({
      kind: 'page',
      page: 39,
      total: 39,
    });
  });

  it('names the page in view when one page is shown, on either side, either direction', () => {
    expect(indicatorModel({ ...base, single: true, spread: 2, focusSide: 'left' })).toEqual({
      kind: 'page',
      page: 3,
      total: 40,
    });
    expect(indicatorModel({ ...base, single: true, spread: 2, focusSide: 'right' })).toEqual({
      kind: 'page',
      page: 4,
      total: 40,
    });
    // RTL: the turned side is the right one
    expect(
      indicatorModel({ ...base, direction: 'rtl', single: true, spread: 2, focusSide: 'right' }),
    ).toEqual({ kind: 'page', page: 3, total: 40 });
    expect(indicatorModel({ ...base, direction: 'rtl', single: true, spread: 2, focusSide: 'left' })).toEqual(
      { kind: 'page', page: 4, total: 40 },
    );
  });
});

describe('parsePageInput', () => {
  it('reads Western, Arabic-Indic and Persian digits, and nothing else', () => {
    expect(parsePageInput('12')).toBe(12);
    expect(parsePageInput(' ٣٤ ')).toBe(34);
    expect(parsePageInput('۱۲۳')).toBe(123);
    for (const bad of ['', 'abc', '1.5', '-3', '12 13', '1e3']) expect(parsePageInput(bad), bad).toBeNaN();
  });
});

describe('pageNumberFormat (ruling R2: UI-chrome numerals follow the interface language, not the manuscript)', () => {
  it('an Arabic interface writes Arabic-Indic digits', () => {
    expect(pageNumberFormat('ar')(34)).toBe('٣٤');
  });

  it('an English interface writes Western digits, even over an Arabic manuscript', () => {
    expect(pageNumberFormat('en')(34)).toBe('34');
  });

  it('has no grouping separators in a page number', () => {
    expect(pageNumberFormat('en')(1200)).toBe('1200');
    expect(pageNumberFormat('ar')(1200)).toBe('١٢٠٠');
  });
});
