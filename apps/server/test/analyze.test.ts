import { describe, expect, it } from 'vitest';
import { analyzePages, type AnalyzablePage } from '../src/ingest/analyze.js';
import { collectWarnings, decidePage } from '../src/ingest/page-policy.js';
import { HEADING_MAX_CHARS } from '../src/pdf/layout.js';
import { assessPage } from '../src/pdf/quality.js';
import { extractFixture, flat } from './fixtures.js';

const CHUNKING = { targetChars: 1100, maxChars: 1600, minChars: 200, overlapChars: 150 };

describe('analyzePages (real fixtures)', () => {
  it('finds the planted sections and gives every chunk exact pages, offsets, section and highlights (text-en.pdf)', async () => {
    const pages = await extractFixture('text-en.pdf');
    const analysis = analyzePages(pages, { chunking: CHUNKING });
    expect(analysis.sections).toEqual([
      { title: 'A Brief History of Thornquist House', page: 1 },
      { title: 'The Founding', page: 2 },
      { title: 'The Lost Archive', page: 4 },
      { title: 'Conclusion', page: 5 },
    ]);
    expect(analysis.primaryLanguage).toBe('en');
    expect(analysis.direction).toBe('ltr');
    expect(analysis.languages.map((l) => l.code)).toEqual(['en']);
    expect(analysis.pages.map((p) => p.language)).toEqual(['en', 'en', 'en', 'en', 'en']);

    expect(analysis.chunks.map((chunk) => [chunk.pageStart, chunk.sectionTitle])).toEqual([
      [1, 'A Brief History of Thornquist House'],
      [2, 'The Founding'],
      [3, 'The Founding'], // carried across the page until the next heading
      [4, 'The Lost Archive'],
      [5, 'Conclusion'],
    ]);
    for (const chunk of analysis.chunks) {
      const text = pages[chunk.pageStart - 1]?.text ?? '';
      expect(text.slice(chunk.charStart, chunk.charEnd)).toBe(chunk.content.slice(chunk.overlapChars));
      expect(chunk.highlights[0]?.page).toBe(chunk.pageStart);
      expect(chunk.highlights[0]?.rects.length).toBeGreaterThan(0);
      expect(chunk.direction).toBe('ltr');
      expect(chunk.language).toBe('en');
    }
    const founding = analysis.chunks[1];
    expect(founding?.content).toContain('Alaric Thornquist');
    expect(founding?.content).toContain('14 March 1847');
    expect(founding?.searchText).toContain('14 march 1847');
    expect(analysis.chunks[3]?.searchText).toContain('ms 4471');
  });

  it('reads Arabic as right to left, Arabic and keeps the Arabic sentences whole (arabic.pdf)', async () => {
    const pages = await extractFixture('arabic.pdf');
    const analysis = analyzePages(pages, { chunking: CHUNKING });
    expect(analysis.primaryLanguage).toBe('ar');
    expect(analysis.direction).toBe('rtl');
    expect(analysis.pages.map((p) => [p.language, p.direction])).toEqual([
      ['ar', 'rtl'],
      ['ar', 'rtl'],
      ['ar', 'rtl'],
    ]);
    expect(analysis.sections.map((s) => s.title)).toEqual([
      'مكتبة الأوراق القديمة',
      'قصة المؤسس',
      'الأرشيف المفقود',
    ]);
    expect(analysis.chunks).toHaveLength(3);
    for (const chunk of analysis.chunks) {
      expect(chunk.direction).toBe('rtl');
      expect(chunk.language).toBe('ar');
    }
    expect(flat(analysis.chunks[1]?.content ?? '')).toContain('يوسف القرطبي');
    expect(flat(analysis.chunks[1]?.content ?? '')).toContain('١٩٩٩');
    // The Arabic-Indic year is searchable as 1999 (shared normaliser).
    expect(analysis.chunks[1]?.searchText).toContain('1999');
  });

  it('knows which page is English and which is Arabic in a bilingual document (mixed-ar-en.pdf)', async () => {
    const pages = await extractFixture('mixed-ar-en.pdf');
    const analysis = analyzePages(pages, { chunking: CHUNKING });
    expect(analysis.pages.map((p) => [p.language, p.direction])).toEqual([
      ['en', 'ltr'],
      ['ar', 'rtl'],
    ]);
    expect(analysis.languages.map((l) => l.code).sort()).toEqual(['ar', 'en']);
    expect(analysis.languages.reduce((sum, l) => sum + l.share, 0)).toBeCloseTo(1, 6);
    expect(analysis.chunks.map((c) => [c.pageStart, c.language, c.direction])).toEqual([
      [1, 'en', 'ltr'],
      [2, 'ar', 'rtl'],
    ]);
  });

  it('lets a PDF outline decide the sections (the heuristic headings are demoted)', async () => {
    const pages = await extractFixture('text-en.pdf');
    const analysis = analyzePages(pages, {
      chunking: CHUNKING,
      outline: [
        { title: 'The Founding', pageNumber: 2 },
        { title: 'Rules and Keepers', pageNumber: 3 }, // no heading on that page: the section starts at its first block
        { title: 'The Lost Archive', pageNumber: 4 },
      ],
    });
    expect(analysis.sections).toEqual([
      { title: 'The Founding', page: 2 },
      { title: 'Rules and Keepers', page: 3 },
      { title: 'The Lost Archive', page: 4 },
    ]);
    const bySection = analysis.chunks.map((chunk) => [chunk.pageStart, chunk.sectionTitle]);
    expect(bySection).toEqual([
      [1, null],
      [2, 'The Founding'],
      [3, 'Rules and Keepers'],
      [4, 'The Lost Archive'],
      [5, 'The Lost Archive'], // "Conclusion" was only a heuristic heading
    ]);
  });
});

describe('headings and the outline', () => {
  /** A page of the given blocks, one line each, with the geometry the chunker needs. */
  function pageOf(pageNumber: number, blocks: { text: string; heading?: boolean }[]): AnalyzablePage {
    let text = '';
    const made = blocks.map((spec, index) => {
      if (index > 0) text += '\n\n';
      const charStart = text.length;
      text += spec.text;
      return {
        text: spec.text,
        charStart,
        charEnd: text.length,
        isHeading: spec.heading ?? false,
        direction: 'ltr' as const,
        fontSize: 11,
        language: undefined,
        lines: [
          {
            text: spec.text,
            charStart,
            charEnd: text.length,
            rect: { x: 0.1, y: 0.1 + index * 0.05, w: 0.8, h: 0.02 },
            direction: 'ltr' as const,
            baseline: 0.1,
            fontSize: 11,
            tabular: false,
          },
        ],
        rects: [],
      };
    });
    return { pageNumber, text, blocks: made as unknown as AnalyzablePage['blocks'] };
  }

  const RUN_IN =
    '1.2 Background The house was founded in the spring of 1847 by a man who kept a diary, and the diary names every keeper of the archive in order.';

  it('never makes a heading of a long run-in paragraph that merely starts with an outline title', () => {
    expect(RUN_IN.length).toBeGreaterThan(HEADING_MAX_CHARS);
    const pages = [
      pageOf(1, [{ text: 'Preface', heading: true }, { text: 'A short opening paragraph for the preface.' }]),
      pageOf(2, [
        { text: RUN_IN },
        { text: 'A second paragraph that follows the run-in one on the same page.' },
      ]),
    ];
    const analysis = analyzePages(pages, {
      chunking: { ...CHUNKING, maxChars: 300, targetChars: 250, minChars: 50, overlapChars: 0 },
      outline: [
        { title: 'Preface', pageNumber: 1 },
        { title: '1.2 Background', pageNumber: 2 },
      ],
    });
    expect(pages[1]?.blocks[0]?.isHeading).toBe(false); // not promoted: it is a paragraph
    expect(pages[0]?.blocks[0]?.isHeading).toBe(true); // a short block that is the title is
    expect(analysis.sections).toEqual([
      { title: 'Preface', page: 1 },
      { title: '1.2 Background', page: 2 },
    ]);
    // The section still starts in the run-in paragraph, and no chunk is longer than the maximum.
    expect(analysis.chunks.some((chunk) => chunk.sectionTitle === '1.2 Background')).toBe(true);
    for (const chunk of analysis.chunks) expect(chunk.content.length).toBeLessThanOrEqual(300);
  });

  it('splits a long heading block that the heuristic took (a heading never lets a chunk exceed the maximum)', () => {
    const long = `${RUN_IN} ${RUN_IN}`;
    const pages = [pageOf(1, [{ text: long, heading: true }, { text: 'Body text after the long heading.' }])];
    const analysis = analyzePages(pages, {
      chunking: { ...CHUNKING, maxChars: 300, targetChars: 250, minChars: 50, overlapChars: 0 },
    });
    for (const chunk of analysis.chunks) expect(chunk.content.length).toBeLessThanOrEqual(300);
    expect(analysis.chunks.length).toBeGreaterThan(1);
  });
});

describe('garbled pages are no evidence', () => {
  it('leaves the language, sections and direction to the readable pages (arabic-no-tounicode.pdf next to text-en.pdf)', async () => {
    const english = await extractFixture('text-en.pdf');
    const garbled = await extractFixture('arabic-no-tounicode.pdf');
    const flags = garbled.map((page) => {
      const assessment = assessPage(page, { minChars: 25 });
      expect(assessment.unreliable).toBe(true);
      return { garbled: true, ...(page.quality.arabicFontNames ? { directionHint: 'rtl' as const } : {}) };
    });
    const pages = [
      ...english.slice(0, 2),
      ...garbled.map((page, index) => Object.assign(page, flags[index])),
    ];
    const analysis = analyzePages(pages, { chunking: CHUNKING });
    expect(analysis.languages.map((l) => l.code)).toEqual(['en']);
    expect(analysis.primaryLanguage).toBe('en');
    expect(analysis.direction).toBe('ltr');
    // No heading is taken from mojibake.
    expect(analysis.sections.map((section) => section.page)).toEqual([1, 2]);
    expect(garbled.every((page) => page.blocks.every((block) => !block.isHeading))).toBe(true);
    // The garbled pages still have chunks (their text is kept for search), with the direction their fonts suggest.
    const chunksOfGarbled = analysis.chunks.filter((chunk) => chunk.pageStart > 2);
    expect(chunksOfGarbled.length).toBeGreaterThan(0);
    expect(chunksOfGarbled.every((chunk) => chunk.direction === 'rtl')).toBe(true);
  });

  it('reads a document that is nothing but garbled Arabic-font pages as right to left, with no language and no sections', async () => {
    const garbled = await extractFixture('arabic-no-tounicode.pdf');
    const pages = garbled.map((page) =>
      Object.assign(page, {
        garbled: true,
        ...(page.quality.arabicFontNames ? { directionHint: 'rtl' as const } : {}),
      }),
    );
    expect(pages.every((page) => page.quality.arabicFontNames)).toBe(true);
    const analysis = analyzePages(pages, { chunking: CHUNKING });
    expect(analysis.direction).toBe('rtl');
    expect(analysis.languages).toEqual([]);
    expect(analysis.sections).toEqual([]);
    expect(analysis.pages.every((page) => page.language === 'und' && page.direction === 'rtl')).toBe(true);
    for (const chunk of analysis.chunks) expect(chunk.sectionTitle).toBeNull();
  });
});

describe('page policy', () => {
  const pageOf = async (name: string, index: number) => {
    const page = (await extractFixture(name))[index];
    if (page === undefined) throw new Error('no such page');
    return page;
  };

  it('keeps the text of a clean page and flags nothing', async () => {
    const page = await pageOf('text-en.pdf', 0);
    expect(decidePage(page, assessPage(page, { minChars: 25 }))).toEqual({
      extraction: 'text',
      warnings: [],
      keepText: true,
    });
  });

  it('records a blank page as empty and flags nothing: there is nothing on it to read', async () => {
    const page = await pageOf('empty.pdf', 0);
    expect(decidePage(page, assessPage(page, { minChars: 25 }))).toEqual({
      extraction: 'empty',
      warnings: [],
      keepText: false,
    });
  });

  it('records a picture without text as empty with OCR_UNAVAILABLE when there is no OCR engine', async () => {
    const page = { ...(await pageOf('empty.pdf', 0)), imageCoverage: 1 };
    expect(decidePage(page, assessPage(page, { minChars: 25 }))).toEqual({
      extraction: 'empty',
      warnings: ['OCR_UNAVAILABLE'],
      keepText: false,
    });
  });

  it('keeps the cleaned text of a garbled page and flags it (never drops text that exists)', async () => {
    const page = await pageOf('arabic-damaged.pdf', 0);
    const decision = decidePage(page, assessPage(page, { minChars: 25 }));
    expect(decision).toEqual({
      extraction: 'text',
      warnings: ['OCR_UNAVAILABLE', 'LOW_TEXT_QUALITY'],
      keepText: true,
    });
  });

  it('groups warnings per code with sorted pages', () => {
    expect(
      collectWarnings([
        { pageNumber: 3, warnings: ['LOW_TEXT_QUALITY', 'OCR_UNAVAILABLE'] },
        { pageNumber: 1, warnings: ['OCR_UNAVAILABLE'] },
        { pageNumber: 2, warnings: [] },
      ]),
    ).toEqual([
      { code: 'OCR_UNAVAILABLE', pages: [1, 3] },
      { code: 'LOW_TEXT_QUALITY', pages: [3] },
    ]);
    expect(collectWarnings([])).toEqual([]);
  });
});
