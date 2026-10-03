import { createCanvas } from '@napi-rs/canvas';
import { PDFDocument, StandardFonts, type PDFFont, type PDFImage, type PDFPage } from 'pdf-lib';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { extractPage } from '../src/pdf/extract-page.js';
import {
  EXTRACTION_MAX_IMAGE_SIZE,
  PDF_DOCUMENT_OPTIONS,
  classifyPdfError,
  closePdf,
  loadPdf,
} from '../src/pdf/load.js';
import { assessPage, needsOcr } from '../src/pdf/quality.js';
import type { ExtractedPage } from '../src/pdf/types.js';
import { installPdfWarningSink, takeRemovedImages } from '../src/pdf/warnings.js';
import { extractFixture, flat, headingsOf, readFixture } from './fixtures.js';

function expectConsistentGeometry(page: ExtractedPage): void {
  for (const block of page.blocks) {
    expect(page.text.slice(block.charStart, block.charEnd)).toBe(block.text);
    expect(block.rects).toHaveLength(block.lines.length);
    for (const line of block.lines) {
      const slice = page.text.slice(line.charStart, line.charEnd);
      expect([line.text, line.text.replace(/[-\u2010]$/u, '')]).toContain(slice);
      const { x, y, w, h } = line.rect;
      expect(x).toBeGreaterThanOrEqual(0);
      expect(y).toBeGreaterThanOrEqual(0);
      expect(x + w).toBeLessThanOrEqual(1 + 1e-9);
      expect(y + h).toBeLessThanOrEqual(1 + 1e-9);
      expect(w).toBeGreaterThan(0);
      expect(h).toBeGreaterThan(0);
    }
  }
  // Reading order is top to bottom.
  const tops = page.blocks.map((block) => block.rects[0]?.y ?? 0);
  expect(tops).toEqual([...tops].sort((a, b) => a - b));
}

describe('pdf.js options', () => {
  it('pins the security options of global section L', () => {
    expect(PDF_DOCUMENT_OPTIONS).toMatchObject({
      isEvalSupported: false,
      disableFontFace: true,
      maxImageSize: 64e6,
      stopAtErrors: false,
      verbosity: 0,
      isOffscreenCanvasSupported: false,
      useSystemFonts: false,
    });
  });

  it('gives the extraction pass a much lower image limit than the 64 megapixel ceiling', () => {
    expect(EXTRACTION_MAX_IMAGE_SIZE).toBe(16e6);
    expect(EXTRACTION_MAX_IMAGE_SIZE).toBeLessThan(PDF_DOCUMENT_OPTIONS.maxImageSize);
  });

  it('loads PDFs from memory without consuming the caller bytes', async () => {
    const bytes = new Uint8Array(await readFixture('text-en.pdf'));
    const doc = await loadPdf(bytes);
    expect(doc.numPages).toBe(5);
    await closePdf(doc);
    expect(bytes.byteLength).toBeGreaterThan(1000);
  });

  it('classifies what pdf.js throws for the invalid fixtures', async () => {
    const failure = async (name: string): Promise<ReturnType<typeof classifyPdfError>> => {
      try {
        await loadPdf(new Uint8Array(await readFixture(name)));
      } catch (error) {
        return classifyPdfError(error);
      }
      throw new Error(`${name} unexpectedly opened`);
    };
    expect((await failure('encrypted.pdf')).code).toBe('PDF_ENCRYPTED');
    expect((await failure('malformed.pdf')).code).toBe('PDF_MALFORMED');
    expect((await failure('not-a-pdf.pdf')).code).toBe('PDF_MALFORMED');
  });
});

describe('text-en.pdf', () => {
  let pages: ExtractedPage[];
  beforeAll(async () => {
    pages = await extractFixture('text-en.pdf');
  });

  it('has five pages with consistent geometry', () => {
    expect(pages).toHaveLength(5);
    for (const page of pages) {
      expect(page.width).toBe(612);
      expect(page.height).toBe(792);
      expectConsistentGeometry(page);
    }
  });

  it('finds exactly the planted headings, and none on the list-and-table page', () => {
    expect(pages.map(headingsOf)).toEqual([
      ['A Brief History of Thornquist House'],
      ['The Founding'],
      [],
      ['The Lost Archive'],
      ['Conclusion'],
    ]);
  });

  it('reads the planted facts in order', () => {
    const [, two, three, four] = pages;
    expect(flat(two?.text ?? '')).toContain('founded by Alaric Thornquist');
    expect(flat(two?.text ?? '')).toContain('completed on 14 March 1847');
    expect(flat(four?.text ?? '')).toContain('the identifier MS-4471 and contained letters');
    expect(three?.text).toContain(
      '1. Wash your hands before opening a book.\n2. Return every map to its own drawer.',
    );
    expect(three?.text).toContain('1893 Edda Lindqvist Library catalogue completed');
    // The table is one block, header first; it is not mistaken for a heading (the bold header would be, by font alone).
    expect(three?.blocks.some((block) => block.text.startsWith('Year Keeper Event\n1847 Alaric'))).toBe(true);
  });

  it('separates paragraphs into blocks and keeps each paragraph together', () => {
    const two = pages[1];
    expect(two?.blocks.map((block) => block.isHeading)).toEqual([true, false, false, false]);
    expect(two?.blocks[1]?.text.startsWith('The house was founded by Alaric Thornquist')).toBe(true);
    expect(two?.blocks[1]?.lines.length).toBeGreaterThan(1);
  });

  it('is left to right with no OCR need and clean quality', () => {
    for (const page of pages) {
      expect(page.blocks.every((block) => block.direction === 'ltr')).toBe(true);
      expect(needsOcr(page)).toBe(false);
      expect(page.quality.unmappedChars).toBe(0);
      expect(page.imageCoverage).toBe(0);
      expect(page.fontStats.bodyFontSize).toBeCloseTo(11, 0);
    }
  });
});

describe('arabic.pdf', () => {
  let pages: ExtractedPage[];
  beforeAll(async () => {
    pages = await extractFixture('arabic.pdf');
  });

  it('extracts without a single lost glyph and with consistent geometry', () => {
    expect(pages).toHaveLength(3);
    for (const page of pages) {
      expect(page.quality.unmappedChars).toBe(0);
      expect(page.text.includes(String.fromCharCode(0))).toBe(false);
      expect(page.blocks.every((block) => block.direction === 'rtl')).toBe(true);
      expect(needsOcr(page)).toBe(false);
      expectConsistentGeometry(page);
    }
  });

  it('reads whole sentences in logical order, never reversed', () => {
    const [one, two, three] = pages.map((page) => flat(page.text));
    expect(one).toContain('مكتبة الأوراق القديمة');
    expect(one).toContain(
      'تقع المكتبة في قلب المدينة القديمة، وقد بنيت قبل أكثر من ثلاثة قرون لتحفظ المخطوطات النادرة.',
    );
    expect(two).toContain('أسس المكتبة الرحالة يوسف القرطبي، وهو عالم جمع كتبه من الأسواق والموانئ البعيدة.');
    expect(two).toContain('في عام ١٩٩٩ أعيد افتتاح المكتبة بعد ترميم طويل');
    expect(three).toContain('هل يمكن أن تكون الأوراق المفقودة مخبأة خلف الجدار؟');
  });

  it('finds the headings of the three pages', () => {
    expect(pages.map(headingsOf)).toEqual([['مكتبة الأوراق القديمة'], ['قصة المؤسس'], ['الأرشيف المفقود']]);
  });
});

describe('mixed-direction lines', () => {
  it('keeps every Arabic and Latin run in logical order (arabic-mixed-line.pdf)', async () => {
    const [page] = await extractFixture('arabic-mixed-line.pdf');
    const lines = (page?.lines ?? []).map((line) => line.text);
    expect(lines).toContain('يعمل الباحث على مشروع Digital Archive منذ سنوات');
    expect(lines).toContain('رمز الصندوق المفقود هو MS-4471 في الغرفة الشمالية');
    expect(lines).toContain('أعيد افتتاح المكتبة في عام ١٩٩٩ بعد الترميم');
    expect(lines).toContain('ونشر الكتالوج الجديد في عام 1999 للمرة الأولى');
    expect(lines).toContain('The sign above the door says مرحبا بكم in Arabic');
    expect(lines).toContain('The keeper wrote يوسف القرطبي on the cover');
    const byText = new Map((page?.lines ?? []).map((line) => [line.text, line.direction]));
    expect(byText.get('رمز الصندوق المفقود هو MS-4471 في الغرفة الشمالية')).toBe('rtl');
    expect(byText.get('The keeper wrote يوسف القرطبي on the cover')).toBe('ltr');
  });

  it('writes paired punctuation around Arabic text the way it was typed, not mirrored (arabic-mixed-line.pdf)', async () => {
    const [page] = await extractFixture('arabic-mixed-line.pdf');
    const lines = (page?.lines ?? []).map((line) => line.text);
    // pdf.js writes the glyph that is drawn, so a bracket inside an Arabic run comes out as its mirror image;
    // reconstruction turns it back into the character in the logical text.
    expect(lines).toContain('قال الباحث (وهو أمين المكتبة) إن الصندوق كبير');
    expect(lines).toContain('عنوان الكتاب «الأرشيف المفقود» مشهور جدا');
    expect(lines).toContain('الرمز (MS-4471) مكتوب على الصندوق');
    expect(lines).toContain('القائمة [الأولى] و{الثانية} و<الثالثة>');
    // A left to right line keeps its brackets as they are.
    expect(lines).toContain('The box (MS-4471) was found [in 1952] and «quoted».');
    for (const line of lines) {
      expect(line.split('(').length, line).toBe(line.split(')').length);
      expect(line.split('«').length, line).toBe(line.split('»').length);
    }
  });

  it('gives an English page and an Arabic page with embedded English (mixed-ar-en.pdf)', async () => {
    const [english, arabic] = await extractFixture('mixed-ar-en.pdf');
    expect(english?.blocks.every((block) => block.direction === 'ltr')).toBe(true);
    expect(headingsOf(english!)).toEqual(['Notes on the Archive']);
    expect(arabic?.blocks.every((block) => block.direction === 'rtl')).toBe(true);
    expect(flat(arabic?.text ?? '')).toContain('يستخدم الأرشيف نظام Open Archive لحفظ الوثائق.');
    expect(flat(arabic?.text ?? '')).toContain('لكل صندوق رمز قصير مثل MS-4471 يسهل البحث عنه.');
    expect(headingsOf(arabic!)).toEqual(['ملاحظات عن الأرشيف']);
  });
});

describe('the quality gate', () => {
  it('sends the damaged Amiri print to OCR because pdf.js lost glyphs (arabic-damaged.pdf)', async () => {
    const pages = await extractFixture('arabic-damaged.pdf');
    expect(pages).toHaveLength(3);
    for (const page of pages) {
      expect(page.quality.unmappedRatio).toBeGreaterThan(0.005);
      expect([0, 0xfffd].some((code) => page.text.includes(String.fromCharCode(code)))).toBe(false);
      const assessment = assessPage(page, { minChars: 25 });
      expect(assessment.needsOcr).toBe(true);
      expect(assessment.lowTextQuality).toBe(true);
      expect(assessment.reasons).toContain('unmapped-glyphs');
      // Most of the text is right: it still counts for the document's language, direction and headings.
      expect(assessment.unreliable).toBe(false);
      // The text that survived is kept (global section N): the page is not dropped.
      expect(page.charCount).toBeGreaterThan(50);
    }
  });

  it('sends a PDF without ToUnicode maps to OCR: garbled text, not Arabic (arabic-no-tounicode.pdf)', async () => {
    const pages = await extractFixture('arabic-no-tounicode.pdf');
    expect(pages).toHaveLength(3);
    for (const page of pages) {
      const assessment = assessPage(page, { minChars: 25 });
      expect(assessment.needsOcr, `page ${String(page.pageNumber)}`).toBe(true);
      expect(assessment.lowTextQuality).toBe(true);
      // Mojibake and an Arabic font without Arabic letters: the text says nothing about the document.
      expect(assessment.unreliable).toBe(true);
      expect(page.quality.arabicLetterShare).toBeLessThan(0.05);
    }
  });

  it('does not flag the clean Arabic print or the English file', async () => {
    for (const name of ['arabic.pdf', 'text-en.pdf', 'mixed-ar-en.pdf', 'arabic-mixed-line.pdf']) {
      for (const page of await extractFixture(name)) {
        expect(assessPage(page, { minChars: 25 }), `${name} page ${String(page.pageNumber)}`).toEqual({
          needsOcr: false,
          lowTextQuality: false,
          unreliable: false,
          reasons: [],
        });
      }
    }
  });

  it('flags a blank page as having too little text', async () => {
    const [page] = await extractFixture('empty.pdf');
    expect(page?.charCount).toBe(0);
    expect(page?.blocks).toEqual([]);
    expect(assessPage(page!, { minChars: 25 }).reasons).toEqual(['few-characters']);
  });
});

describe('rotated.pdf', () => {
  it('reads upright text on a /Rotate 90 page in display order, with rectangles on the displayed page', async () => {
    const [page] = await extractFixture('rotated.pdf');
    expect(page?.rotation).toBe(90);
    expect(page?.width).toBe(842); // 595 x 842 rotated
    expect(page?.height).toBe(595);
    expect(headingsOf(page!)).toEqual(['The Rotated Page']);
    expect(flat(page?.text ?? '')).toContain(
      'This page is stored sideways but is displayed upright, so its text must be read in the order',
    );
    const title = page?.lines[0]?.rect;
    // Title baseline at 90 pt from the top and 72 pt from the left of the displayed page.
    expect(title?.x).toBeCloseTo(72 / 842, 1);
    expect(title?.y).toBeGreaterThan(0.08);
    expect(title?.y).toBeLessThan(0.17);
    expect(title?.w).toBeGreaterThan(0.15);
    expect(page?.lines.every((line) => line.rect.x + line.rect.w <= 1 + 1e-9)).toBe(true);
    expectConsistentGeometry(page!);
  });
});

describe('image coverage', () => {
  async function pdfWith(
    draw: (page: PDFPage, image: PDFImage, font: PDFFont) => void,
  ): Promise<ExtractedPage> {
    const canvas = createCanvas(200, 300);
    const context = canvas.getContext('2d');
    context.fillStyle = '#887766';
    context.fillRect(0, 0, 200, 300);
    const doc = await PDFDocument.create();
    const image = await doc.embedPng(canvas.toBuffer('image/png'));
    const font = await doc.embedFont(StandardFonts.TimesRoman);
    draw(doc.addPage([400, 600]), image, font);
    const pdf = await loadPdf(await doc.save());
    try {
      return await extractPage(pdf, 1);
    } finally {
      await closePdf(pdf);
    }
  }

  it('measures a full-page scan as covering the page, and asks for OCR', async () => {
    const page = await pdfWith((p, image) => p.drawImage(image, { x: 0, y: 0, width: 400, height: 600 }));
    expect(page.imageCoverage).toBe(1);
    expect(page.charCount).toBe(0);
    expect(assessPage(page, { minChars: 25 }).reasons).toEqual(['few-characters', 'image-page']);
  });

  it('measures a half-page image by area and honours the transform', async () => {
    const page = await pdfWith((p, image) => p.drawImage(image, { x: 0, y: 0, width: 400, height: 300 }));
    expect(page.imageCoverage).toBeCloseTo(0.5, 2);
  });

  it('asks for OCR for an image-dominated page with a little text, but not for a page with real text', async () => {
    const caption = await pdfWith((p, image, font) => {
      p.drawImage(image, { x: 0, y: 0, width: 400, height: 600 });
      p.drawText('Figure 1: the archive door in the morning light, photographed in 1952.', {
        x: 20,
        y: 580,
        size: 9,
        font,
      });
    });
    expect(caption.charCount).toBeGreaterThanOrEqual(25);
    expect(caption.imageCoverage).toBe(1);
    expect(assessPage(caption, { minChars: 25 }).reasons).toEqual(['image-page']);

    const body = await pdfWith((p, image, font) => {
      p.drawImage(image, { x: 0, y: 0, width: 400, height: 600 });
      for (let i = 0; i < 12; i += 1) {
        p.drawText('This line of body text is one of many that make up a page which is mostly text.', {
          x: 10,
          y: 580 - i * 14,
          size: 9,
          font,
        });
      }
    });
    expect(body.charCount).toBeGreaterThan(200);
    // Not measured at all for a page with this much text (the operator list is not even built).
    expect(body.imageCoverage).toBe(0);
    expect(needsOcr(body)).toBe(false);
  });
});

describe('what the operator list is built for', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** Counts getOperatorList calls on the pages of `bytes` while `run` extracts them. */
  async function operatorListCalls(bytes: Uint8Array): Promise<{ calls: number; pages: ExtractedPage[] }> {
    const pdf = await loadPdf(bytes);
    try {
      const prototype = Object.getPrototypeOf(await pdf.getPage(1)) as {
        getOperatorList: (...args: unknown[]) => Promise<unknown>;
      };
      const spy = vi.spyOn(prototype, 'getOperatorList');
      const pages: ExtractedPage[] = [];
      for (let n = 1; n <= pdf.numPages; n += 1) pages.push(await extractPage(pdf, n));
      return { calls: spy.mock.calls.length, pages };
    } finally {
      await closePdf(pdf);
    }
  }

  const BODY =
    'This paragraph is ordinary body text that runs on for a while, long enough to wrap, so that it is plainly not a heading of any kind.';

  async function twoPartPage(lead: string, sentenceEnd: boolean): Promise<Uint8Array> {
    const doc = await PDFDocument.create();
    const body = await doc.embedFont(StandardFonts.TimesRoman);
    const bold = await doc.embedFont(StandardFonts.TimesRomanBold);
    const page = doc.addPage([612, 792]);
    let y = 700;
    const paragraph = (text: string, font: PDFFont): void => {
      page.drawText(text, { x: 72, y, size: 11, font, maxWidth: 468, lineHeight: 14 });
      y -= text === BODY ? 70 : 40;
    };
    paragraph(BODY, body);
    paragraph(BODY, body);
    paragraph(lead + (sentenceEnd ? '.' : ''), bold);
    paragraph(BODY, body);
    paragraph(BODY, body);
    return doc.save();
  }

  it('is not built for a text page: the text decides, not the font names (text-en.pdf)', async () => {
    const { calls, pages } = await operatorListCalls(new Uint8Array(await readFixture('text-en.pdf')));
    expect(pages).toHaveLength(5);
    expect(calls).toBe(0);
  });

  it('is built once for a short line set apart whose bold face could make it a heading', async () => {
    const { calls, pages } = await operatorListCalls(await twoPartPage('Keepers of the Archive', false));
    expect(calls).toBe(1);
    expect(headingsOf(pages[0]!)).toEqual(['Keepers of the Archive']);
  });

  it('is not built when the line ends a sentence: that is a paragraph whatever its font', async () => {
    const { calls, pages } = await operatorListCalls(await twoPartPage('Keepers of the Archive', true));
    expect(calls).toBe(0);
    expect(headingsOf(pages[0]!)).toEqual([]);
  });
});

describe('images the extraction limit refuses', () => {
  let uninstall: (() => void) | undefined;
  afterEach(() => {
    uninstall?.();
    uninstall = undefined;
    takeRemovedImages();
  });

  it('are counted as removed and make the page an image page (oversized-image.pdf)', async () => {
    uninstall = installPdfWarningSink();
    const pdf = await loadPdf(new Uint8Array(await readFixture('oversized-image.pdf')), { extraction: true });
    try {
      const page = await extractPage(pdf, 1);
      expect(page.removedImages).toBe(1);
      expect(page.imageCoverage).toBe(1);
      expect(page.charCount).toBe(0);
      expect(assessPage(page, { minChars: 25 }).reasons).toEqual(['few-characters', 'image-page']);
    } finally {
      await closePdf(pdf);
    }
  });
});
