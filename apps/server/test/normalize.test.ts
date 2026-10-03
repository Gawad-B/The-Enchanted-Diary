import { describe, expect, it } from 'vitest';
import { joinLines, normalizeExtractedText, normalizeLine } from '../src/text/normalize.js';

describe('normalizeLine', () => {
  it('folds Arabic presentation forms and the lam-alef ligature into base letters (NFKC)', () => {
    expect(normalizeLine('\uFEE3\uFEAE\uFEA3\uFE92\uFE8E')).toBe('مرحبا');
    expect(normalizeLine('\uFEFB')).toBe('\u0644\u0627');
  });

  it('removes the soft hyphen, zero-width and bidi control characters but keeps ZWJ and ZWNJ', () => {
    expect(normalizeLine('co\u00ADoper\u200Bate')).toBe('cooperate');
    expect(normalizeLine('\u202Aabc\u202C \u2066def\u2069 \u200Eg\u200F')).toBe('abc def g');
    expect(normalizeLine('می\u200Cخواهم')).toBe('می\u200Cخواهم'); // ZWNJ is spelling in Persian
    expect(normalizeLine('a\u200Db')).toBe('a\u200Db');
  });

  it('removes tag characters that hide text', () => {
    const tagged = 'visible' + String.fromCodePoint(0xe0041, 0xe0042, 0xe007f);
    expect(normalizeLine(tagged)).toBe('visible');
  });

  it('strips tashkeel, tatweel and unmapped glyphs, and collapses spaces', () => {
    expect(normalizeLine('الك\u064Fت\u064Fب')).toBe('الكتب');
    expect(normalizeLine('مـــرحبا')).toBe('مرحبا');
    expect(normalizeLine('a\u0000b\uFFFDc')).toBe('abc');
    expect(normalizeLine('  many   spaces\t here\u00A0 ')).toBe('many spaces here');
  });
});

describe('normalizeExtractedText', () => {
  it('undoes Latin line-break hyphenation when the next line starts lower-case', () => {
    expect(normalizeExtractedText('the informa-\ntion archive')).toBe('the information archive');
    expect(normalizeExtractedText('a well-\nKnown name')).toBe('a well-\nKnown name');
    expect(normalizeExtractedText('end of 1999-\nthe next')).toBe('end of 1999-\nthe next');
  });

  it('leaves Arabic hyphenation-like endings alone', () => {
    expect(normalizeExtractedText('كلمة-\nأخرى')).toBe('كلمة-\nأخرى');
  });

  it('keeps line structure and one blank line between blocks', () => {
    expect(normalizeExtractedText('one\ntwo\n\n\n\nthree\r\nfour\n')).toBe('one\ntwo\n\nthree\nfour');
    expect(normalizeExtractedText('\n\n  \n')).toBe('');
  });

  it('is idempotent', () => {
    const once = normalizeExtractedText('Hy-\nphen  and\u00AD soft\n\nمرحبا');
    expect(normalizeExtractedText(once)).toBe(once);
  });
});

describe('joinLines', () => {
  it('reports where every line sits in the joined text, also after dehyphenation', () => {
    const lines = ['the informa-', 'tion archive', 'and more'];
    const joined = joinLines(lines);
    expect(joined.text).toBe('the information archive\nand more');
    expect(joined.ranges.map((r) => joined.text.slice(r.start, r.end))).toEqual([
      'the informa',
      'tion archive',
      'and more',
    ]);
  });
});
