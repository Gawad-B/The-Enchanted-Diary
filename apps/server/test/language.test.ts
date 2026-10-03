import { describe, expect, it } from 'vitest';
import {
  classifyArabicScript,
  detectLanguage,
  documentDirection,
  primaryLanguage,
  summarizeLanguages,
} from '../src/language/detect.js';

// Original sentences, two or three each.
const SAMPLES: Record<string, string> = {
  en: 'The old library stands at the end of the quiet street. Every morning the keeper opens the heavy doors and lights the lamps. Visitors come to read the letters that were written long ago.',
  ar: 'تقع المكتبة القديمة في نهاية الشارع الهادئ. كل صباح يفتح الحارس الأبواب الثقيلة ويشعل المصابيح. يأتي الزوار لقراءة الرسائل التي كتبت منذ زمن بعيد.',
  fr: 'La vieille bibliothèque se trouve au bout de la rue tranquille. Chaque matin, le gardien ouvre les lourdes portes et allume les lampes. Les visiteurs viennent lire les lettres écrites il y a longtemps.',
  es: 'La vieja biblioteca está al final de la calle tranquila. Cada mañana el guardián abre las pesadas puertas y enciende las lámparas. Los visitantes vienen a leer las cartas que se escribieron hace mucho tiempo.',
  de: 'Die alte Bibliothek steht am Ende der ruhigen Straße. Jeden Morgen öffnet der Wächter die schweren Türen und zündet die Lampen an. Die Besucher kommen, um die Briefe zu lesen, die vor langer Zeit geschrieben wurden.',
  it: 'La vecchia biblioteca si trova in fondo alla strada tranquilla. Ogni mattina il custode apre le pesanti porte e accende le lampade. I visitatori vengono a leggere le lettere scritte molto tempo fa.',
  pt: 'A velha biblioteca fica no fim da rua tranquila. Todas as manhãs o guarda abre as pesadas portas e acende as lâmpadas. Os visitantes vêm ler as cartas que foram escritas há muito tempo.',
  tr: 'Eski kütüphane sessiz sokağın sonunda duruyor. Her sabah bekçi ağır kapıları açıyor ve lambaları yakıyor. Ziyaretçiler çok uzun zaman önce yazılmış mektupları okumaya geliyor.',
  fa: 'کتابخانه قدیمی در انتهای خیابان آرام قرار دارد. هر روز صبح نگهبان درهای سنگین را باز می\u200Cکند و چراغ\u200Cها را روشن می\u200Cکند. بازدیدکنندگان می\u200Cآیند تا نامه\u200Cهایی را بخوانند که مدت\u200Cها پیش نوشته شده\u200Cاند.',
  ur: 'پرانی لائبریری خاموش گلی کے آخر میں واقع ہے۔ ہر صبح نگہبان بھاری دروازے کھولتا ہے اور چراغ جلاتا ہے۔ ملاقاتی ان خطوط کو پڑھنے آتے ہیں جو بہت پہلے لکھے گئے تھے۔',
};

describe('detectLanguage', () => {
  for (const [code, text] of Object.entries(SAMPLES)) {
    it(`recognises ${code}`, () => {
      const guess = detectLanguage(text);
      expect(guess.code).toBe(code);
      expect(guess.confidence).toBeGreaterThan(0.3);
    });
  }

  it('gives the direction of the language', () => {
    expect(detectLanguage(SAMPLES.ar ?? '').direction).toBe('rtl');
    expect(detectLanguage(SAMPLES.fa ?? '').direction).toBe('rtl');
    expect(detectLanguage(SAMPLES.ur ?? '').direction).toBe('rtl');
    expect(detectLanguage(SAMPLES.en ?? '').direction).toBe('ltr');
    expect(detectLanguage(SAMPLES.ar ?? '').script).toBe('arabic');
  });

  it('calls a mixed page with 70% Arabic Arabic and right-to-left', () => {
    const mixed = `${SAMPLES.ar ?? ''} ${SAMPLES.ar ?? ''} The library and the archive opened.`;
    const guess = detectLanguage(mixed);
    expect(guess.code).toBe('ar');
    expect(guess.direction).toBe('rtl');
  });

  it('keeps English as the language of a page with a short Arabic quotation', () => {
    const guess = detectLanguage(`${SAMPLES.en ?? ''} ${SAMPLES.en ?? ''} The inscription reads: مرحبا بكم`);
    expect(guess.code).toBe('en');
    expect(guess.direction).toBe('ltr');
  });

  it('answers und for texts that are too short, unless the script decides', () => {
    expect(detectLanguage('OK').code).toBe('und');
    expect(detectLanguage('Bonjour tout le monde').code).toBe('und');
    expect(detectLanguage('1999 2024 12 35').code).toBe('und');
    expect(detectLanguage('').code).toBe('und');
    expect(detectLanguage('مرحبا').code).toBe('ar');
    expect(detectLanguage('مرحبا').direction).toBe('rtl');
    expect(detectLanguage('ہے').code).toBe('ur');
    expect(detectLanguage('Привет').code).toBe('ru');
    expect(detectLanguage('Γειά σου').code).toBe('el');
    expect(detectLanguage('שלום').code).toBe('he');
    expect(detectLanguage('שלום').direction).toBe('rtl');
  });

  it('maps CJK scripts to their language', () => {
    expect(detectLanguage('这是一本很古老的书').code).toBe('zh');
    expect(detectLanguage('これはとても古い本です').code).toBe('ja');
    expect(detectLanguage('이것은 매우 오래된 책입니다').code).toBe('ko');
  });

  it('separates Persian and Urdu from Arabic by their letters, not by default', () => {
    expect(classifyArabicScript('كتب الطالب الدرس')).toBe('ar');
    expect(classifyArabicScript('چای')).toBe('fa');
    expect(classifyArabicScript('کتاب')).toBe('fa'); // Persian kaf
    expect(classifyArabicScript('ٹھنڈا')).toBe('ur');
  });
});

describe('summarizeLanguages', () => {
  it('counts a bilingual page for both languages and drops und', () => {
    const summary = summarizeLanguages([
      { text: SAMPLES.en ?? '' },
      { text: `${SAMPLES.ar ?? ''} ${SAMPLES.ar ?? ''}` },
      { text: '12' },
    ]);
    expect(summary.map((entry) => entry.code)).toEqual(['ar', 'en']);
    expect(summary.reduce((sum, entry) => sum + entry.share, 0)).toBeCloseTo(1, 6);
    expect(primaryLanguage(summary)).toBe('ar');
    expect(documentDirection(summary)).toBe('rtl');
  });

  it('does not count English terms inside Arabic prose as English', () => {
    const summary = summarizeLanguages([{ text: `${SAMPLES.ar ?? ''} (MS-4471 archive)` }]);
    expect(summary.map((entry) => entry.code)).toEqual(['ar']);
  });

  it('handles an empty document', () => {
    expect(summarizeLanguages([])).toEqual([]);
    expect(primaryLanguage([])).toBe('und');
    expect(documentDirection([], 'مرحبا')).toBe('rtl');
    expect(documentDirection([], '')).toBe('ltr');
  });

  it('splits the shares of an English-Arabic document by letters', () => {
    const summary = summarizeLanguages([
      { text: SAMPLES.en ?? '' },
      { text: SAMPLES.en ?? '' },
      { text: SAMPLES.ar ?? '' },
    ]);
    expect(summary[0]?.code).toBe('en');
    expect(summary[0]?.share).toBeGreaterThan(0.5);
    expect(summary[1]?.code).toBe('ar');
  });
});
