import { describe, expect, it } from 'vitest';
import { RTL_LANGUAGES, directionForLanguage, dominantDirection } from '../src/index.js';

describe('directionForLanguage', () => {
  it.each(['ar', 'fa', 'ur', 'he', 'ps', 'sd', 'ug', 'yi', 'ckb'])('%s is rtl', (code) => {
    expect(directionForLanguage(code)).toBe('rtl');
  });

  it('lists the right-to-left languages', () => {
    expect(RTL_LANGUAGES).toEqual(['ar', 'fa', 'ur', 'he', 'ps', 'sd', 'ug', 'yi', 'ckb']);
  });

  it.each(['en', 'fr', 'es', 'de', 'it', 'pt', 'tr', 'zh', 'und', ''])('%j is ltr', (code) => {
    expect(directionForLanguage(code)).toBe('ltr');
  });

  it('understands region subtags, case and ISO 639-3 spellings', () => {
    expect(directionForLanguage('ar-EG')).toBe('rtl');
    expect(directionForLanguage('AR_sa')).toBe('rtl');
    expect(directionForLanguage('arb')).toBe('rtl');
    expect(directionForLanguage('fas')).toBe('rtl');
    expect(directionForLanguage('en-US')).toBe('ltr');
  });
});

describe('dominantDirection', () => {
  it('is rtl for Arabic, Persian, Urdu and Hebrew text', () => {
    expect(dominantDirection('مرحبا بالعالم')).toBe('rtl');
    expect(dominantDirection('سلام دنیا، این یک آزمایش است')).toBe('rtl');
    expect(dominantDirection('یہ ایک امتحان ہے')).toBe('rtl');
    expect(dominantDirection('שלום עולם')).toBe('rtl');
  });

  it('is ltr for English and French text', () => {
    expect(dominantDirection('Hello, world')).toBe('ltr');
    expect(dominantDirection("L'été dernier, nous avons visité Paris")).toBe('ltr');
  });

  it('follows the majority in mixed text', () => {
    expect(dominantDirection('هذه صفحة عن PDF و OCR في المكتبة')).toBe('rtl');
    expect(dominantDirection('This chapter quotes مرحبا once')).toBe('ltr');
  });

  it('is ltr when there are no strong characters', () => {
    expect(dominantDirection('')).toBe('ltr');
    expect(dominantDirection('12345 6789')).toBe('ltr');
    expect(dominantDirection('١٢٣٤٥ ... ؟!')).toBe('ltr');
  });

  it('ignores digits and punctuation when counting', () => {
    expect(dominantDirection('٢٠٢٦ - 2026 - مرحبا')).toBe('rtl');
  });
});
