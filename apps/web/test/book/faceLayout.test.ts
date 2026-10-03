import { describe, expect, it } from 'vitest';
import {
  bookplateModel,
  fitText,
  sanitizeFilename,
  significantLanguages,
  wrapWords,
} from '../../src/book/faceLayout';
import { STRINGS } from '../../src/i18n/strings';

describe('sanitizeFilename', () => {
  it('keeps an ordinary name', () => {
    expect(sanitizeFilename('Annual report 2024.pdf')).toBe('Annual report 2024.pdf');
  });

  it('keeps only the last path segment', () => {
    expect(sanitizeFilename('C:\\Users\\me\\secret\\plan.pdf')).toBe('plan.pdf');
    expect(sanitizeFilename('../../etc/passwd.pdf')).toBe('passwd.pdf');
  });

  it('strips control characters, bidi controls, tag characters and zero-width marks', () => {
    const hostile = `a\u0000b\u202ec\u202dd\u2066e\u2069f\u200eg\u200fh\u061ci\u{e0041}j\ufeffk\u2028l.pdf`;
    expect(sanitizeFilename(hostile)).toBe('abcdefghijkl.pdf');
  });

  it('collapses whitespace and trims', () => {
    expect(sanitizeFilename('  a \t\n  b  .pdf ')).toBe('a b .pdf');
  });

  it('shortens to at most 120 characters, ending in an ellipsis', () => {
    const cleaned = sanitizeFilename('x'.repeat(300));
    expect(Array.from(cleaned)).toHaveLength(120);
    expect(cleaned.endsWith('\u2026')).toBe(true);
  });

  it('leaves Arabic letters and their joining alone', () => {
    expect(sanitizeFilename('تقرير سنوي 2024.pdf')).toBe('تقرير سنوي 2024.pdf');
  });

  it('an empty or all-control name becomes an empty string', () => {
    expect(sanitizeFilename('')).toBe('');
    expect(sanitizeFilename('\u0001\u0002')).toBe('');
  });
});

describe('text fitting', () => {
  const measure = (text: string) => Array.from(text).length * 10;

  it('fitText leaves short text alone and ends long text with an ellipsis that fits', () => {
    expect(fitText('abc', 100, measure)).toBe('abc');
    const fitted = fitText('abcdefghijklmnop', 80, measure);
    expect(fitted.endsWith('\u2026')).toBe(true);
    expect(measure(fitted)).toBeLessThanOrEqual(80);
    expect(fitText('abcdef', 5, measure)).toBe('\u2026');
  });

  it('wrapWords breaks greedily at the width and keeps an over-long word whole', () => {
    expect(wrapWords('one two three four', 80, measure)).toEqual(['one two', 'three', 'four']);
    expect(wrapWords('supercalifragilistic is', 50, measure)).toEqual(['supercalifragilistic', 'is']);
    expect(wrapWords('', 80, measure)).toEqual([]);
  });
});

describe('bookplateModel', () => {
  const document = {
    filename: 'تقرير سنوي.pdf',
    pageCount: 42,
    languages: [
      { code: 'ar', share: 0.86 },
      { code: 'en', share: 0.12 },
      { code: 'fr', share: 0.02 },
    ],
    primaryLanguage: 'ar',
    createdAt: '2026-03-14T09:30:00.000Z',
  };

  it('names the file, the pages, the languages and the day, in the interface language', () => {
    const en = bookplateModel(document, STRINGS.en.scene.bookplate, 'en');
    expect(en.heading).toBe('Bound within');
    expect(en.title).toBe('تقرير سنوي.pdf');
    expect(en.pages).toBe('42 pages');
    expect(en.languages).toBe('Written in Arabic, English');
    expect(en.bound).toBe('Bound March 14, 2026');
    const ar = bookplateModel(document, STRINGS.ar.scene.bookplate, 'ar');
    expect(ar.heading).toBe(STRINGS.ar.scene.bookplate.heading);
    expect(ar.pages).toContain('42');
    expect(ar.languages).toContain('، ');
  });

  it('draws an Arabic title right to left and a Latin title left to right (browser bidi, never reversed by hand)', () => {
    expect(bookplateModel(document, STRINGS.en.scene.bookplate, 'en').titleDirection).toBe('rtl');
    expect(
      bookplateModel({ ...document, filename: 'Annual report.pdf' }, STRINGS.en.scene.bookplate, 'en')
        .titleDirection,
    ).toBe('ltr');
  });

  it('uses the singular for one page', () => {
    expect(bookplateModel({ ...document, pageCount: 1 }, STRINGS.en.scene.bookplate, 'en').pages).toBe(
      '1 page',
    );
  });

  it('sanitises the title it will draw', () => {
    expect(
      bookplateModel({ ...document, filename: 'a\u202eb.pdf' }, STRINGS.en.scene.bookplate, 'en').title,
    ).toBe('ab.pdf');
  });

  it('has no languages line when none is known, and no date when the date is invalid', () => {
    const model = bookplateModel(
      { ...document, languages: [], primaryLanguage: 'und', createdAt: 'not a date' },
      STRINGS.en.scene.bookplate,
      'en',
    );
    expect(model.languages).toBeNull();
    expect(model.bound).toBe('');
  });

  it('falls back to the primary language when no language reaches a tenth of the text', () => {
    expect(significantLanguages([{ code: 'de', share: 0.05 }], 'de')).toEqual(['de']);
    expect(significantLanguages([], 'und')).toEqual([]);
    expect(
      significantLanguages(
        [
          { code: 'a', share: 0.4 },
          { code: 'b', share: 0.3 },
          { code: 'c', share: 0.2 },
          { code: 'd', share: 0.1 },
        ],
        'a',
      ),
    ).toEqual(['a', 'b', 'c']);
  });
});
