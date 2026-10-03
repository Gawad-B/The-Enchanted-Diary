import { ERROR_CODES, WARNING_CODES } from '@enchanted/shared';
import { describe, expect, it } from 'vitest';
import { STRINGS, format, type Language } from '../../src/i18n/strings';
import { createStringsContext, uiDirection } from '../../src/i18n/useStrings';

const LANGUAGES: Language[] = ['en', 'ar'];

/** Every string in a dictionary with its dotted path. */
function flatten(value: unknown, path = ''): [string, string][] {
  if (typeof value === 'string') return [[path, value]];
  if (Array.isArray(value)) return value.flatMap((item, index) => flatten(item, `${path}[${String(index)}]`));
  if (typeof value === 'object' && value !== null) {
    return Object.entries(value).flatMap(([key, item]) =>
      flatten(item, path === '' ? key : `${path}.${key}`),
    );
  }
  return [];
}

const placeholders = (text: string): string[] =>
  [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1] ?? '').sort();

describe('dictionaries', () => {
  it('have the same keys in English and Arabic', () => {
    expect(flatten(STRINGS.ar).map(([path]) => path)).toEqual(flatten(STRINGS.en).map(([path]) => path));
  });

  it('use the same placeholders in both languages', () => {
    const arabic = new Map(flatten(STRINGS.ar));
    for (const [path, english] of flatten(STRINGS.en)) {
      expect(placeholders(arabic.get(path) ?? ''), path).toEqual(placeholders(english));
    }
  });

  it('contain no empty strings and no leftover template or marker text', () => {
    for (const language of LANGUAGES) {
      for (const [path, text] of flatten(STRINGS[language])) {
        expect(text.trim(), `${language}:${path}`).not.toBe('');
        expect(text, `${language}:${path}`).not.toMatch(/TODO|FIXME|lorem/i);
      }
    }
  });

  it('write the Arabic interface in Arabic script', () => {
    const arabicLetters = /\p{Script=Arabic}/u;
    for (const [path, text] of flatten(STRINGS.ar)) expect(text, path).toMatch(arabicLetters);
  });

  it.each(LANGUAGES)(
    '%s: every error code the API or the browser can produce has an in-world line',
    (language) => {
      for (const code of [...ERROR_CODES, 'NETWORK'] as const) {
        expect(STRINGS[language].errors[code], code).toEqual(expect.any(String));
        expect(STRINGS[language].errors[code].length, code).toBeGreaterThan(10);
      }
      expect(Object.keys(STRINGS[language].errors).sort()).toEqual([...ERROR_CODES, 'NETWORK'].sort());
    },
  );

  it.each(LANGUAGES)('%s: every warning code has a line', (language) => {
    expect(Object.keys(STRINGS[language].warnings).sort()).toEqual([...WARNING_CODES].sort());
  });

  it.each(LANGUAGES)('%s: every ingestion stage and every experience phase has a line', (language) => {
    expect(Object.keys(STRINGS[language].ingestStage).sort()).toEqual(
      [
        'queued',
        'validating',
        'parsing',
        'ocr',
        'analyzing',
        'chunking',
        'embedding',
        'storing',
        'ready',
        'failed',
      ].sort(),
    );
    expect(Object.keys(STRINGS[language].live).sort()).toEqual(
      [
        'discovery',
        'opening',
        'awaiting',
        'uploading',
        'reading',
        'unveiling',
        'manuscript',
        'revealing',
        'memory',
        'closing',
      ].sort(),
    );
  });

  it('keeps the research wording for the key lines', () => {
    expect(STRINGS.en.progress.reading).toBe("Turning your manuscript's pages, one by one…");
    expect(STRINGS.en.ingestStage.ready).toBe('Your manuscript is bound between my covers. Ask anything.');
    expect(STRINGS.en.invitation.dropZone).toBe(
      'My pages are blank. Lay a manuscript here and I will remember it.',
    );
    expect(STRINGS.en.ask.notFound).toContain('I searched every page and found nothing written about that.');
    expect(STRINGS.en.ask.notCertain).toBe("I'm not certain. This is the closest thing the pages say.");
    expect(STRINGS.en.citation.footnote).toBe('From page {n} of your manuscript.');
    expect(STRINGS.en.memory.offer).toBe('But I can show you...');
    expect(STRINGS.en.preUpload).toHaveLength(3);
    expect(STRINGS.ar.progress.slow).toBe('أمهلني لحظة، فالحبر لم يجفّ بعد.');
    expect(STRINGS.ar.ask.notFound).toContain('قلّبتُ الصفحات كلها فلم أجد فيها شيئًا عن هذا.');
    expect(STRINGS.ar.errors.PDF_ENCRYPTED).toContain('أزِل قفلها ثم قدّمها لي من جديد.');
  });

  it("keeps the spec's stage lines (section 40)", () => {
    expect(STRINGS.en.ingestStage.validating).toMatch(/manuscript/i);
    expect(STRINGS.en.progress.upload).toBe('Opening the manuscript…');
    expect(STRINGS.en.ingestStage.parsing).toBe('Examining the pages…');
    expect(STRINGS.en.ingestStage.ocr).toBe('Reading the faded writing…');
    expect(STRINGS.en.ingestStage.embedding).toBe('Binding the words to memory…');
    expect(STRINGS.en.ask.retrieving).toBe('Searching the pages…');
    expect(STRINGS.en.ask.answering).toBe('Searching the diary…');
    expect(STRINGS.en.invitation.waiting).toBe('This book is waiting for a manuscript.');
    expect(STRINGS.en.invitation.placeDocument).toBe('Place your document within.');
  });

  describe("the spec's error lines (sections 13 and 53)", () => {
    /** The exact sentence from the spec, and its Arabic counterpart, for the code or key that carries it. */
    const SPEC_LINES: [key: string, english: string, arabic: string][] = [
      ['errors.PDF_MALFORMED', 'The manuscript could not be opened.', 'تعذّر فتح المخطوطة.'],
      ['errors.PDF_ENCRYPTED', 'The document is password protected.', 'المستند محمي بكلمة مرور.'],
      [
        'errors.FILE_TOO_LARGE',
        'This file exceeds the maximum size.',
        'هذا الملف يتجاوز الحجم الأقصى المسموح به.',
      ],
      [
        'errors.PDF_UNREADABLE',
        'The pages appear damaged or unreadable.',
        'تبدو الصفحات تالفة أو غير مقروءة.',
      ],
      [
        'warnings.OCR_UNAVAILABLE',
        'The faded pages could not be fully read.',
        'تعذّرت قراءة الصفحات الباهتة قراءةً كاملة.',
      ],
      [
        'ask.notFound',
        'The diary could not find that answer within this manuscript.',
        'لم تجد المذكّرة هذه الإجابة في هذه المخطوطة.',
      ],
      ['errors.NETWORK', 'The connection to the archive was interrupted.', 'انقطع الاتصال بالأرشيف.'],
      ['spell.failed', 'The spell failed.', 'تعثّرت التعويذة.'],
    ];

    const lookup = (language: Language, key: string): string => {
      const value = key
        .split('.')
        .reduce<unknown>((node, part) => (node as Record<string, unknown>)[part], STRINGS[language]);
      if (typeof value !== 'string') throw new Error(`${language}:${key} is not a string`);
      return value;
    };

    it.each(SPEC_LINES)('%s opens with the spec sentence in English and Arabic', (key, english, arabic) => {
      for (const [language, sentence] of [
        ['en', english],
        ['ar', arabic],
      ] as const) {
        const text = lookup(language, key);
        // The whole first sentence, never a paraphrase: the line is the spec's, any action text follows it.
        expect(text === sentence || text.startsWith(`${sentence} `), `${language}:${key} = ${text}`).toBe(
          true,
        );
      }
    });

    it('opens every other "spell failed" line with the same sentence', () => {
      for (const language of LANGUAGES) {
        const failed = STRINGS[language].spell.failed;
        expect(STRINGS[language].ingestStage.failed).toBe(failed);
        expect(STRINGS[language].errors.INTERNAL.startsWith(`${failed} `)).toBe(true);
      }
    });

    it('still tells the reader what to do next (research: an error line needs an action)', () => {
      expect(STRINGS.en.errors.PDF_MALFORMED).toMatch(/try another copy/i);
      expect(STRINGS.en.errors.PDF_ENCRYPTED).toMatch(/remove its lock/i);
      expect(STRINGS.en.errors.FILE_TOO_LARGE).toMatch(/offer a file under \{limit\}/i);
      expect(STRINGS.en.errors.NETWORK).toMatch(/try again/i);
    });
  });

  it('states that this is a fan concept and not an official product', () => {
    expect(STRINGS.en.app.fanDisclaimer).toMatch(/fan/i);
    expect(STRINGS.en.app.fanDisclaimer).toMatch(/not an official/i);
  });
});

describe('format', () => {
  it('fills named placeholders', () => {
    expect(format('Page {n} of {total}', { n: 3, total: 40 })).toBe('Page 3 of 40');
    expect(format('{n} and {n}', { n: 'x' })).toBe('x and x');
  });

  it('leaves a placeholder without a value in place, so the gap is visible', () => {
    expect(format('Offer something under {limit}.', {})).toBe('Offer something under {limit}.');
  });

  it('does not treat other braces as placeholders', () => {
    expect(format('a {b c} d')).toBe('a {b c} d');
  });
});

describe('createStringsContext', () => {
  it('gives the interface direction for each language', () => {
    expect(uiDirection('en')).toBe('ltr');
    expect(uiDirection('ar')).toBe('rtl');
    expect(createStringsContext('ar').direction).toBe('rtl');
  });

  it('formats interface numbers with Western digits in English and Eastern Arabic digits in Arabic', () => {
    expect(createStringsContext('en').formatNumber(1234)).toBe('1,234');
    expect(createStringsContext('ar').formatNumber(42)).toBe('٤٢');
  });

  it('returns the dictionary of its language', () => {
    expect(createStringsContext('en').t).toBe(STRINGS.en);
    expect(createStringsContext('ar').t).toBe(STRINGS.ar);
  });
});
