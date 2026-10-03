import { describe, expect, it } from 'vitest';
import { assembleLine, baseDirectionOf, edgeDirection, type LineItem } from '../src/pdf/assemble-line.js';
import { layoutPage } from '../src/pdf/layout.js';
import { mirrorPairedPunctuation } from '../src/pdf/mirror.js';
import type { PositionedItem } from '../src/pdf/types.js';

const SIZE = 10;
/** An item `width` wide whose left edge is at `x0`. */
const at = (text: string, x0: number, width = text.length * 5, fontSize = SIZE): LineItem => ({
  text,
  x0,
  x1: x0 + width,
  fontSize,
});

describe('assembleLine', () => {
  it('puts the words of a right-to-left line back in logical order (word-level items, visual left to right)', () => {
    // Logical "دفتر اليوميات المسحور": the first word is the right-most.
    const items = [at('المسحور', 0), at('اليوميات', 50), at('دفتر', 110)];
    expect(assembleLine(items, 'rtl')).toBe('دفتر اليوميات المسحور');
  });

  it('puts the glyphs of a word split into items back in order and adds no spaces inside words', () => {
    // Glyph-level producer, logical "كتب نص" drawn right to left: ك is the right-most glyph. Zero gaps inside a word.
    const items = [at('ص', 60, 4), at('ن', 64, 4), at('ب', 100, 4), at('ت', 104, 4), at('ك', 108, 4)];
    expect(assembleLine(items, 'rtl')).toBe('كتب نص');
  });

  it('keeps Latin terms and numbers as left-to-right runs inside a right-to-left line', () => {
    const items = [
      at('سنوات', 0),
      at('منذ', 30),
      at('Digital', 60),
      at('Archive', 100),
      at('مشروع', 140),
      at('على', 175),
      at('الباحث', 200),
      at('يعمل', 240),
    ];
    expect(assembleLine(items, 'rtl')).toBe('يعمل الباحث على مشروع Digital Archive منذ سنوات');
  });

  it('keeps "MS-4471" together: neutrals between two left-to-right items join their run', () => {
    const items = [
      at('الشمالية', 0),
      at('في', 45),
      at('MS', 65, 12),
      at('-', 77, 3),
      at('4471', 80, 20),
      at('هو', 110),
    ];
    expect(assembleLine(items, 'rtl')).toBe('هو MS-4471 في الشمالية');
  });

  it('puts Arabic-Indic digits in logical position', () => {
    const items = [at('بعد', 0), at('١٩٩٩', 25), at('عام', 60), at('في', 85)];
    expect(assembleLine(items, 'rtl')).toBe('في عام ١٩٩٩ بعد');
  });

  it('reads a left-to-right line with an Arabic phrase: the phrase runs right to left inside it', () => {
    // "The sign says مرحبا بكم in Arabic" drawn left to right; the two Arabic words appear reversed on the page.
    const items = [
      at('The', 0),
      at('sign', 20),
      at('says', 45),
      at('بكم', 70),
      at('مرحبا', 95),
      at('in', 130),
      at('Arabic', 145),
    ];
    expect(assembleLine(items, 'ltr')).toBe('The sign says مرحبا بكم in Arabic');
  });

  it('turns the brackets inside Arabic runs back into the characters that were typed', () => {
    // Typed "قال (وهو) إن". The brackets are drawn mirrored, so the file holds the other bracket at each place.
    const items = [at('إن', 0), at('(', 20, 3), at('وهو', 23), at(')', 38, 3), at('قال', 51)];
    expect(assembleLine(items, 'rtl')).toBe('قال (وهو) إن');
    const quotes = [at('جدا', 0), at('«', 20, 3), at('الأرشيف', 23), at('»', 58, 3), at('كتاب', 71)];
    expect(assembleLine(quotes, 'rtl')).toBe('كتاب «الأرشيف» جدا');
  });

  it('keeps the brackets of a left-to-right line as they are, and mirrors only the Arabic runs inside it', () => {
    const items = [at('The', 0), at('box', 20), at('(', 45, 3), at('MS-4471', 48, 35), at(')', 83, 3)];
    expect(assembleLine(items, 'ltr')).toBe('The box (MS-4471)');
    const mixed = [at('see', 0), at('(', 20, 3), at('قال', 23), at(')', 38, 3), at('now', 46)];
    // The Arabic run is a single word: neither bracket belongs to it, both stay as drawn.
    expect(assembleLine(mixed, 'ltr')).toBe('see (قال) now');
  });

  it('adds a space only for a real gap (more than a quarter of the font size) and never doubles one', () => {
    expect(assembleLine([at('ab', 0, 10), at('cd', 11, 10)], 'ltr')).toBe('abcd'); // 1-unit gap
    expect(assembleLine([at('ab', 0, 10), at('cd', 14, 10)], 'ltr')).toBe('ab cd'); // 4-unit gap
    expect(assembleLine([at('ab ', 0, 10), at('cd', 14, 10)], 'ltr')).toBe('ab cd');
    expect(assembleLine([at('ab', 0, 10), at(' ', 10, 3), at('cd', 13, 10)], 'ltr')).toBe('ab cd');
  });

  it('is a plain left-to-right join for Latin text', () => {
    expect(assembleLine([at('Hello', 0), at('world', 30)], 'ltr')).toBe('Hello world');
    expect(assembleLine([], 'ltr')).toBe('');
  });
});

describe('line direction', () => {
  it('uses the letters of a group: digits alone are neutral', () => {
    expect(baseDirectionOf([{ text: 'مرحبا بكم' }])).toBe('rtl');
    expect(baseDirectionOf([{ text: 'Hello world' }])).toBe('ltr');
    expect(baseDirectionOf([{ text: '1999' }])).toBeNull();
  });

  it('trusts the ends of a line when they agree, whatever the letter counts say', () => {
    // An English sentence quoting a long Arabic phrase: more Arabic letters than Latin, but it is English.
    const english = [at('Say', 0), at('عبارة عربية طويلة جدا', 20), at('now', 120)];
    expect(edgeDirection(english)).toBe('ltr');
    const arabic = [at('يعمل', 0), at('Digital Archive', 30), at('منذ', 120)];
    expect(edgeDirection(arabic)).toBe('rtl');
  });

  it('abstains when the ends disagree or there are no letters', () => {
    expect(edgeDirection([at('Open', 0), at('رمز', 30)])).toBeNull();
    expect(edgeDirection([at('1999', 0), at('-', 30)])).toBeNull();
  });
});

describe('headings', () => {
  const size = 10;
  let top = 0;
  /** An item for a line whose baseline is at `baseline`. */
  const line = (text: string, baseline: number, options: Partial<PositionedItem> = {}): PositionedItem => {
    const fontSize = options.fontSize ?? size;
    top += 1;
    return {
      text,
      x0: options.x0 ?? 50,
      x1: (options.x0 ?? 50) + text.length * fontSize * 0.5,
      top: baseline - fontSize * 0.9,
      bottom: baseline + fontSize * 0.2,
      baseline,
      fontSize,
      fontName: `f${String(top)}`,
      bold: false,
      horizontal: true,
      ...options,
    };
  };
  /** Twelve body lines (leading 12) with the given extra items. */
  const page = (extra: PositionedItem[]): PositionedItem[] => [
    ...Array.from({ length: 12 }, (_, i) =>
      line(`Body text line number ${String(i)} of the page`, 300 + i * 12),
    ),
    ...extra,
  ];
  const headingsOf = (items: PositionedItem[]): string[] =>
    layoutPage(items, { pageWidth: 600, pageHeight: 800 })
      .blocks.filter((block) => block.isHeading)
      .map((block) => block.text);

  it('takes a line of at least 1.2 times the body size', () => {
    expect(headingsOf(page([line('Big heading', 200, { fontSize: 12 })]))).toEqual(['Big heading']);
    expect(headingsOf(page([line('Almost big', 200, { fontSize: 11.5 })]))).toEqual([]);
  });

  it('takes a bold line with at least 1.5 line heights above it, but not a bold line right under text', () => {
    expect(headingsOf(page([line('Bold heading', 250, { bold: true })]))).toEqual(['Bold heading']);
    expect(headingsOf(page([line('Bold remark', 296, { bold: true })]))).toEqual([]);
    expect(headingsOf(page([line('Plain gap', 250)]))).toEqual([]);
  });

  it('takes "Chapter", "Part", "الفصل" and "مقدمة" lines at body size, and cuts them out of their paragraph', () => {
    const items = [
      line('Chapter 3: The Return', 100),
      line(
        'Body text follows right below with normal spacing and runs a lot wider than the chapter line above it does.',
        112,
        { x0: 50 },
      ),
      line('الفصل الأول', 150, { x0: 400 }),
      line('نص عادي يأتي بعد العنوان مباشرة وهو أطول بكثير من سطر العنوان الذي قبله', 162, { x0: 50 }),
      line('مقدمة', 230, { x0: 500 }),
    ];
    const headings = layoutPage(page(items), { pageWidth: 600, pageHeight: 800 })
      .blocks.filter((b) => b.isHeading)
      .map((b) => b.text);
    expect(headings).toEqual(['Chapter 3: The Return', 'الفصل الأول', 'مقدمة']);
  });

  it('keeps a paragraph that merely starts with "Section 4 of the law" together: its first line is full width', () => {
    const paragraph = [
      line('Section 4 of the agreement states that the keeper must log every visit in writing', 100),
      line('and that the log must be kept for as long as the house stays open to visitors, which', 112),
      line('is the reason the green notebooks are still on the shelf today.', 124),
    ];
    const layout = layoutPage(page(paragraph), { pageWidth: 600, pageHeight: 800 });
    expect(layout.blocks.filter((block) => block.isHeading)).toEqual([]);
    expect(
      layout.blocks.some(
        (block) => block.text.startsWith('Section 4 of the agreement') && block.lines.length === 3,
      ),
    ).toBe(true);
  });

  it('never takes more than two lines or 120 characters', () => {
    const threeLines = [
      line('Chapter one has a very long title', 200, { fontSize: 14 }),
      line('that continues on a second line', 216, { fontSize: 14 }),
      line('and then on a third one', 232, { fontSize: 14 }),
    ];
    expect(headingsOf(page(threeLines))).toEqual([]);
    expect(headingsOf(page([line('x'.repeat(130), 200, { fontSize: 14 })]))).toEqual([]);
  });

  it('never takes list items or table rows', () => {
    const list = [
      line('1. First item', 200, { fontSize: 13 }),
      line('2. Second item', 230, { fontSize: 13 }),
    ];
    expect(headingsOf(page(list))).toEqual([]);
    const table = [
      line('Year', 200, { fontSize: 13, bold: true, x0: 50 }),
      line('Keeper', 200, { fontSize: 13, bold: true, x0: 200 }),
      line('Event', 200, { fontSize: 13, bold: true, x0: 350 }),
    ];
    expect(headingsOf(page(table))).toEqual([]);
    expect(headingsOf(page([line('1. Introduction', 200, { fontSize: 13 })]))).toEqual(['1. Introduction']);
  });
});

describe('layoutPage', () => {
  it('numbers characters consistently and merges a hyphenated word across lines', () => {
    const mk = (text: string, baseline: number): PositionedItem => ({
      text,
      x0: 50,
      x1: 50 + text.length * 5,
      top: baseline - 9,
      bottom: baseline + 2,
      baseline,
      fontSize: 10,
      fontName: 'f',
      bold: false,
      horizontal: true,
    });
    const layout = layoutPage(
      [mk('the informa-', 100), mk('tion archive', 112), mk('Second paragraph here', 160)],
      {
        pageWidth: 600,
        pageHeight: 800,
      },
    );
    expect(layout.text).toBe('the information archive\n\nSecond paragraph here');
    expect(layout.blocks.map((block) => block.text)).toEqual([
      'the information archive',
      'Second paragraph here',
    ]);
    for (const block of layout.blocks)
      expect(layout.text.slice(block.charStart, block.charEnd)).toBe(block.text);
  });
});

describe('mirrorPairedPunctuation', () => {
  it('swaps every bracket and quotation mark with its partner and leaves other characters alone', () => {
    expect(mirrorPairedPunctuation(')وهو(')).toBe('(وهو)');
    expect(mirrorPairedPunctuation('»الأرشيف«')).toBe('«الأرشيف»');
    expect(mirrorPairedPunctuation(']a[ }b{ >c<')).toBe('[a] {b} <c>');
    expect(mirrorPairedPunctuation('plain, text: 12-34 \u061F')).toBe('plain, text: 12-34 \u061F');
  });

  it('is its own inverse', () => {
    const text = 'قال (وهو) [x] {y} <z> «w» \u2039v\u203A \u300Au\u300B';
    expect(mirrorPairedPunctuation(mirrorPairedPunctuation(text))).toBe(text);
    expect(mirrorPairedPunctuation(text)).not.toBe(text);
  });
});
