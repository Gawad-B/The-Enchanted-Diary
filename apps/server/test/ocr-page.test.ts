import { describe, expect, it } from 'vitest';
import { buildOcrPageText, MIN_LINE_CONFIDENCE } from '../src/ocr/ocr-page.js';
import type { OcrLine, OcrResult } from '../src/ocr/types.js';

/** A 1700 x 2200 pixel render of a 612 x 792 point page (200 DPI). */
const GEOMETRY = { pageWidth: 612, pageHeight: 792, imageWidth: 1700, imageHeight: 2200 };

const line = (text: string, x0: number, y0: number, x1: number, y1: number, confidence = 92): OcrLine => ({
  text,
  confidence,
  bbox: { x0, y0, x1, y1 },
});

const resultOf = (lines: OcrLine[], confidence = 90): OcrResult => ({
  text: lines.map((l) => l.text).join('\n'),
  confidence,
  lines,
  languagesUsed: ['eng'],
});

/** Lines 40 px high on a 60 px pitch, starting at y = 300. */
const column = (texts: string[], x0 = 200, firstTop = 300, pitch = 60): OcrLine[] =>
  texts.map((text, i) => line(text, x0, firstTop + i * pitch, x0 + 1200, firstTop + i * pitch + 40));

describe('buildOcrPageText', () => {
  it('turns the lines of a paragraph into one block, with the page text and offsets that match it', () => {
    const page = buildOcrPageText(
      resultOf(column(['The house was founded by', 'a cartographer in the spring', 'of the year 1847.'])),
      GEOMETRY,
    );
    expect(page.text).toBe('The house was founded by\na cartographer in the spring\nof the year 1847.');
    expect(page.blocks).toHaveLength(1);
    const block = page.blocks[0];
    expect(block?.text).toBe(page.text);
    expect([block?.charStart, block?.charEnd]).toEqual([0, page.text.length]);
    expect(block?.lines.map((l) => page.text.slice(l.charStart, l.charEnd))).toEqual([
      'The house was founded by',
      'a cartographer in the spring',
      'of the year 1847.',
    ]);
    expect(block?.isHeading).toBe(false);
    expect(page.charCount).toBe(page.text.replace(/\s/gu, '').length);
  });

  it('normalises each line rectangle by the size of the image (the render covers the whole page)', () => {
    const page = buildOcrPageText(resultOf([line('Hello world', 170, 220, 850, 330)]), GEOMETRY);
    const first = page.blocks[0]?.lines[0];
    expect(first?.rect.x).toBeCloseTo(170 / 1700, 10);
    expect(first?.rect.y).toBeCloseTo(220 / 2200, 10);
    expect(first?.rect.w).toBeCloseTo(680 / 1700, 10);
    expect(first?.rect.h).toBeCloseTo(110 / 2200, 10);
    expect(page.blocks[0]?.rects).toEqual([first?.rect]);
    // The point coordinates of the line are in the page's own units.
    expect(first?.x0).toBeCloseTo(170 * (612 / 1700), 6);
    expect(first?.bottom).toBeCloseTo(330 * (792 / 2200), 6);
  });

  it('starts a new block where the vertical gap is larger than the usual line spacing', () => {
    const lines = [
      ...column(['First paragraph line one', 'First paragraph line two'], 200, 300),
      ...column(['Second paragraph line one', 'Second paragraph line two'], 200, 300 + 2 * 60 + 60),
    ];
    const page = buildOcrPageText(resultOf(lines), GEOMETRY);
    expect(page.blocks.map((b) => b.text)).toEqual([
      'First paragraph line one\nFirst paragraph line two',
      'Second paragraph line one\nSecond paragraph line two',
    ]);
    expect(page.text).toBe(`${page.blocks[0]?.text ?? ''}\n\n${page.blocks[1]?.text ?? ''}`);
    for (const block of page.blocks) expect(page.text.slice(block.charStart, block.charEnd)).toBe(block.text);
    for (const l of page.blocks.flatMap((b) => b.lines))
      expect(page.text.slice(l.charStart, l.charEnd)).toBe(l.text);
  });

  it('does not split a paragraph because its last, short line has a smaller box (the box follows the ink)', () => {
    const lines = [
      line(
        'Ships passing the headland could see the beam for twelve miles, and the harbour master praised',
        188,
        496,
        1480,
        544,
      ),
      line('its steady light.', 188, 546, 387, 582),
    ];
    const page = buildOcrPageText(resultOf(lines), GEOMETRY);
    expect(page.blocks).toHaveLength(1);
    expect(page.text).toBe(
      'Ships passing the headland could see the beam for twelve miles, and the harbour master praised\nits steady light.',
    );
  });

  it('keeps the reading order Tesseract gives and starts a block when the next line jumps back up (a second column)', () => {
    const left = column(['Left column line one', 'Left column line two', 'Left column line three'], 150);
    const right = column(['Right column line one', 'Right column line two'], 900);
    const page = buildOcrPageText(resultOf([...left, ...right]), GEOMETRY);
    expect(page.blocks.map((b) => b.text)).toEqual([
      'Left column line one\nLeft column line two\nLeft column line three',
      'Right column line one\nRight column line two',
    ]);
  });

  it('joins a word hyphenated at a line end when the next line continues in lower case', () => {
    const page = buildOcrPageText(
      resultOf(column(['the informa-', 'tion was lost', 'in the fire.'])),
      GEOMETRY,
    );
    expect(page.text).toBe('the information was lost\nin the fire.');
    const [first, second] = page.blocks[0]?.lines ?? [];
    // Each line keeps the part of the word that sits on it, so its rectangle still covers what it holds.
    expect(page.text.slice(first?.charStart, first?.charEnd)).toBe('the informa');
    expect(page.text.slice(second?.charStart, second?.charEnd)).toBe('tion was lost');
  });

  it('drops lines that are noise: no letters or digits, or a confidence below the floor', () => {
    expect(MIN_LINE_CONFIDENCE).toBe(15);
    const lines = [
      line('A real line of text', 200, 300, 1400, 340),
      line('Another real line', 200, 360, 1400, 400),
      line('— | .', 200, 420, 400, 460),
      line('xq zv', 200, 480, 400, 520, MIN_LINE_CONFIDENCE - 1),
    ];
    const page = buildOcrPageText(resultOf(lines), GEOMETRY);
    expect(page.text).toBe('A real line of text\nAnother real line');
  });

  it('cleans each line like extracted text: marks, invisible characters and spacing', () => {
    const page = buildOcrPageText(resultOf([line('  Founded  in   1847​ ', 200, 300, 900, 340)]), GEOMETRY);
    expect(page.text).toBe('Founded in 1847');
  });

  it('gives Arabic lines and blocks the right-to-left direction', () => {
    const page = buildOcrPageText(
      resultOf(column(['تقع المكتبة في قلب المدينة', 'القديمة منذ ثلاثة قرون']), 99),
      GEOMETRY,
    );
    expect(page.blocks[0]?.direction).toBe('rtl');
    expect(page.blocks[0]?.lines.every((l) => l.direction === 'rtl')).toBe(true);
  });

  it('describes an empty page: no text, no blocks', () => {
    const page = buildOcrPageText(resultOf([], 0), GEOMETRY);
    expect(page).toMatchObject({ text: '', blocks: [], charCount: 0 });
  });

  it('reports the body size of the page and clean quality evidence', () => {
    const page = buildOcrPageText(resultOf(column(['one line of text', 'two lines of text'])), GEOMETRY);
    expect(page.fontStats.bodyFontSize).toBeGreaterThan(0);
    expect(page.fontStats.medianLeading).toBeGreaterThan(page.fontStats.bodyFontSize * 0.9);
    expect(page.quality).toMatchObject({ unmappedChars: 0, mojibakeRatio: 0, scriptScatter: false });
  });

  it("reports the confidence of the lines it kept, weighted by their characters, not the engine's mean over the specks it dropped", () => {
    const lines = [
      line('twenty characters!!', 200, 300, 1400, 340, 100), // 18 characters at 100
      line('short', 200, 360, 600, 400, 20), // 5 characters at 20
      line('xq zv', 200, 420, 400, 460, MIN_LINE_CONFIDENCE - 1), // dropped
      line('— | .', 200, 480, 400, 520, 3), // dropped
    ];
    const page = buildOcrPageText(resultOf(lines, 41), GEOMETRY);
    expect(page.text).toBe('twenty characters!!\nshort');
    expect(page.confidence).toBeCloseTo((18 * 100 + 5 * 20) / 23, 6);
    expect(buildOcrPageText(resultOf([], 77), GEOMETRY).confidence).toBe(0);
  });
});

describe('buildOcrPageText for text without boxes (Gemini)', () => {
  const plain = (text: string): OcrResult => ({
    text,
    confidence: null,
    lines: [],
    languagesUsed: [],
    layout: 'page',
  });
  const PAGE = { pageWidth: 612, pageHeight: 792, imageWidth: 612, imageHeight: 792 };

  it('makes a block of each run of lines between blank lines, with no confidence', () => {
    const page = buildOcrPageText(
      plain('The Founding\n\nThe house was founded by\na cartographer in the spring\n\nof the year 1847.'),
      PAGE,
    );
    expect(page.confidence).toBeNull();
    expect(page.blocks.map((block) => block.text)).toEqual([
      'The Founding',
      'The house was founded by\na cartographer in the spring',
      'of the year 1847.',
    ]);
    expect(page.text).toBe(page.blocks.map((block) => block.text).join('\n\n'));
    expect(page.charCount).toBe(page.text.replace(/\s/gu, '').length);
    for (const block of page.blocks) {
      expect(page.text.slice(block.charStart, block.charEnd)).toBe(block.text);
      for (const lineOfBlock of block.lines) {
        expect(page.text.slice(lineOfBlock.charStart, lineOfBlock.charEnd)).toBe(lineOfBlock.text);
      }
    }
  });

  it('highlights the whole page: every line and block rectangle is the page', () => {
    const page = buildOcrPageText(plain('one line\n\nanother line'), PAGE);
    const rects = page.blocks.flatMap((block) => [...block.lines.map((l) => l.rect), ...block.rects]);
    expect(rects.length).toBeGreaterThan(0);
    for (const rect of rects) expect(rect).toEqual({ x: 0, y: 0, w: 1, h: 1 });
  });

  it('drops lines with no letter or digit, and reads Arabic as right to left', () => {
    const page = buildOcrPageText(plain('* * *\n\nمرحبا بالعالم الكبير\n---'), PAGE);
    expect(page.blocks).toHaveLength(1);
    expect(page.blocks[0]?.direction).toBe('rtl');
    expect(page.text).toBe('مرحبا بالعالم الكبير');
  });

  it('gives a page with no text no blocks and no characters', () => {
    const page = buildOcrPageText(plain(''), PAGE);
    expect(page).toMatchObject({ text: '', blocks: [], charCount: 0, confidence: null });
  });
});
