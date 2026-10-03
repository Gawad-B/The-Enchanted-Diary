import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium, type Browser } from '@playwright/test';
import { PDFDict, PDFDocument, PDFName } from 'pdf-lib';

/*
 * Fixtures produced by Chromium's page.pdf(): real shaped Arabic, mixed-direction text, and the producers'
 * known failure modes. All text is original.
 */

export interface ArabicSection {
  /** HTML inside one printed page. */
  html: string;
}

export const ARABIC_PAGES: ArabicSection[] = [
  {
    html: `<h1>مكتبة الأوراق القديمة</h1>
<p>تقع المكتبة في قلب المدينة القديمة، وقد بنيت قبل أكثر من ثلاثة قرون لتحفظ المخطوطات النادرة.</p>
<p>يزورها الباحثون من مختلف البلدان لقراءة الكتب والرسائل التي كتبها العلماء والتجار والرحالة.</p>`,
  },
  {
    html: `<h2>قصة المؤسس</h2>
<p>أسس المكتبة الرحالة يوسف القرطبي، وهو عالم جمع كتبه من الأسواق والموانئ البعيدة.</p>
<p>في عام ١٩٩٩ أعيد افتتاح المكتبة بعد ترميم طويل، وأصبحت مفتوحة للجميع كل يوم.</p>`,
  },
  {
    html: `<h2>الأرشيف المفقود</h2>
<p>يقال إن صندوقا صغيرا اختفى من الغرفة الشمالية في ليلة ممطرة، ولم يعثر عليه أحد حتى اليوم.</p>
<p>هل يمكن أن تكون الأوراق المفقودة مخبأة خلف الجدار؟ يرى الباحثون أن الإجابة قد تظهر يوما ما.</p>`,
  },
];

/**
 * Text for the Amiri print: it is full of the letter sequences (the article with kaf or jeem, as in
 * "الكبيرة", "الكربون", "الجيزة") that pdf.js cannot map from Chromium's Type 3 fonts, which become U+0000.
 */
export const DAMAGED_PAGES: ArabicSection[] = [
  {
    html: `<h1>الكربون في الطبيعة</h1>
<p>يوجد الكربون في الهواء والماء والتربة، وهو أساس الحياة على الأرض.</p>
<p>تعيش في الغابة الكبيرة حيوانات كثيرة تعتمد على الكربون الذي تنتجه النباتات.</p>`,
  },
  {
    html: `<h2>المدينة الكبيرة</h2>
<p>تقع المدينة الكبيرة قرب الجيزة، وفيها أسواق قديمة وبيوت صغيرة وحدائق واسعة.</p>
<p>يسكن الكبير والصغير في الحي نفسه ويتبادلون الزيارات كل أسبوع.</p>`,
  },
  {
    html: `<h2>بيت في الجيزة</h2>
<p>في الجيزة بيت قديم تحيط به أشجار كبيرة ويزوره الناس في الصيف.</p>
<p>يقول الجيران إن البيت الكبير يحفظ ذكريات كثيرة من الأيام الماضية.</p>`,
  },
];

export const MIXED_PAGES: ArabicSection[] = [
  {
    html: `<div class="en"><h1>Notes on the Archive</h1>
<p>The archive keeps letters, maps and receipts from three centuries. Visitors may read them in the reading room, and the keeper will gladly explain how the boxes are arranged on the shelves.</p>
<p>Every box has a short identifier, and the catalogue lists the contents of each one in plain language.</p></div>`,
  },
  {
    html: `<h1>ملاحظات عن الأرشيف</h1>
<p>يستخدم الأرشيف نظام Open Archive لحفظ الوثائق.</p>
<p>لكل صندوق رمز قصير مثل MS-4471 يسهل البحث عنه.</p>
<p>يمكن للزائر أن يسأل أمين الأرشيف عن أي وثيقة، وسيجد الجواب في الفهرس الجديد خلال دقائق قليلة.</p>`,
  },
];

/** Lines whose logical order is asserted exactly by the tests. */
export const MIXED_LINES = {
  arabicWithTerm: 'يعمل الباحث على مشروع Digital Archive منذ سنوات',
  arabicWithCode: 'رمز الصندوق المفقود هو MS-4471 في الغرفة الشمالية',
  arabicIndicYear: 'أعيد افتتاح المكتبة في عام ١٩٩٩ بعد الترميم',
  westernYear: 'ونشر الكتالوج الجديد في عام 1999 للمرة الأولى',
  englishWithArabic: 'The sign above the door says مرحبا بكم in Arabic',
  englishWithName: 'The keeper wrote يوسف القرطبي on the cover',
  // Paired punctuation: drawn mirrored in right-to-left text, so it must be put back.
  parentheses: 'قال الباحث (وهو أمين المكتبة) إن الصندوق كبير',
  guillemets: 'عنوان الكتاب «الأرشيف المفقود» مشهور جدا',
  codeInParentheses: 'الرمز (MS-4471) مكتوب على الصندوق',
  squareAndCurly: 'القائمة [الأولى] و{الثانية} و<الثالثة>',
  // The same characters in a left-to-right line must stay as they are.
  englishBrackets: 'The box (MS-4471) was found [in 1952] and «quoted».',
} as const;

export const MIXED_LINE_PAGE: ArabicSection = {
  html: `<p dir="rtl">${MIXED_LINES.arabicWithTerm}</p>
<p dir="rtl">${MIXED_LINES.arabicWithCode}</p>
<p dir="rtl">${MIXED_LINES.arabicIndicYear}</p>
<p dir="rtl">${MIXED_LINES.westernYear}</p>
<p dir="ltr">${MIXED_LINES.englishWithArabic}</p>
<p dir="ltr">${MIXED_LINES.englishWithName}</p>
<p dir="rtl">${MIXED_LINES.parentheses}</p>
<p dir="rtl">${MIXED_LINES.guillemets}</p>
<p dir="rtl">${MIXED_LINES.codeInParentheses}</p>
<p dir="rtl">${MIXED_LINES.squareAndCurly.replace('<', '&lt;').replace('>', '&gt;')}</p>
<p dir="ltr">${MIXED_LINES.englishBrackets}</p>`,
};

/** System fonts that give Chromium output without lost glyphs (global section N); the first one that does is used. */
const CLEAN_FONT_CANDIDATES = ['Droid Arabic Kufi', 'Vazirmatn'];

export interface RenderOptions {
  fontFamily: string;
  /** CSS placed before the page styles (an @font-face for a bundled font). */
  fontFaceCss?: string;
  dir?: 'rtl' | 'ltr';
  lang?: string;
  /** Latin text font; the Arabic font is first in the stack. */
  fontSize?: number;
}

function buildHtml(sections: readonly ArabicSection[], options: RenderOptions): string {
  const dir = options.dir ?? 'rtl';
  return `<!doctype html><html lang="${options.lang ?? 'ar'}" dir="${dir}"><head><meta charset="utf-8"><style>
${options.fontFaceCss ?? ''}
@page { size: A4; margin: 40px; }
body { font-family: ${options.fontFamily}; font-size: ${String(options.fontSize ?? 18)}px; line-height: 2; margin: 0; }
h1 { font-size: 28px; margin: 0 0 0.6em; }
h2 { font-size: 24px; margin: 0 0 0.6em; }
p { margin: 0 0 1em; }
section { page-break-after: always; }
section:last-child { page-break-after: auto; }
.en { direction: ltr; font-family: 'Liberation Serif', 'DejaVu Serif', serif; line-height: 1.5; }
</style></head><body>${sections.map((s) => `<section>${s.html}</section>`).join('\n')}</body></html>`;
}

export class Renderer {
  private browser: Browser | null = null;
  constructor(private readonly scratchDir: string) {}

  async open(): Promise<void> {
    await mkdir(this.scratchDir, { recursive: true });
    this.browser = await chromium.launch();
  }

  async close(): Promise<void> {
    await this.browser?.close();
    await rm(this.scratchDir, { recursive: true, force: true });
  }

  /** Prints the sections, one per page, to a PDF. The page is loaded from a file so that file:// fonts work. */
  async render(sections: readonly ArabicSection[], options: RenderOptions): Promise<Uint8Array> {
    if (this.browser === null) throw new Error('Renderer.open() was not called');
    const file = path.join(this.scratchDir, `page-${String(Math.random()).slice(2)}.html`);
    await writeFile(file, buildHtml(sections, options));
    const page = await this.browser.newPage();
    try {
      await page.goto(pathToFileURL(file).href);
      await page.evaluate(() => document.fonts.ready);
      return new Uint8Array(await page.pdf({ preferCSSPageSize: true, printBackground: false }));
    } finally {
      await page.close();
    }
  }

  /** A PNG screenshot of an HTML document, at twice the pixel density (loaded from a file so that file:// fonts work). */
  async screenshot(html: string, size: { width: number; height: number }): Promise<Buffer> {
    if (this.browser === null) throw new Error('Renderer.open() was not called');
    const file = path.join(this.scratchDir, `shot-${String(Math.random()).slice(2)}.html`);
    await writeFile(file, html);
    const context = await this.browser.newContext({ viewport: size, deviceScaleFactor: 2 });
    try {
      const page = await context.newPage();
      await page.goto(pathToFileURL(file).href);
      await page.evaluate(() => document.fonts.ready);
      return await page.screenshot({ type: 'png', clip: { x: 0, y: 0, ...size } });
    } finally {
      await context.close();
    }
  }
}

/** Counts how many characters pdf.js returns as U+0000 / U+FFFD, over the whole document. */
export type NulMeter = (pdf: Uint8Array) => Promise<{ unmapped: number; total: number }>;

/**
 * Renders `sections` with the first candidate font that comes out of Chromium and pdf.js without a single lost
 * glyph, and fails loudly when none does (the fixture would not test what it claims to).
 */
export async function renderCleanArabic(
  renderer: Renderer,
  sections: readonly ArabicSection[],
  meter: NulMeter,
  extra: Partial<RenderOptions> = {},
): Promise<{ pdf: Uint8Array; font: string }> {
  const failures: string[] = [];
  for (const font of CLEAN_FONT_CANDIDATES) {
    const pdf = await renderer.render(sections, {
      fontFamily: `'${font}', 'Liberation Sans', sans-serif`,
      ...extra,
    });
    const { unmapped, total } = await meter(pdf);
    if (unmapped === 0 && total > 0) return { pdf, font };
    failures.push(`${font}: ${String(unmapped)} of ${String(total)} characters unmapped`);
  }
  throw new Error(
    `No installed Arabic font produces a PDF without NUL glyphs (${failures.join('; ')}). Install Droid Arabic Kufi or Vazirmatn.`,
  );
}

/** Chromium with the bundled Amiri face: Type 3 fonts, from which pdf.js loses ligature glyphs (about 3% NUL). */
export async function renderDamagedArabic(
  renderer: Renderer,
  repoRoot: string,
  sections: readonly ArabicSection[],
): Promise<Uint8Array> {
  const files = path.join(repoRoot, 'node_modules', '@fontsource', 'amiri', 'files');
  const url = (name: string): string => pathToFileURL(path.join(files, name)).href;
  const fontFaceCss = `
@font-face { font-family: AmiriPrint; src: url(${url('amiri-arabic-400-normal.woff2')}) format('woff2');
  unicode-range: U+0600-06FF, U+0750-077F, U+FB50-FDFF, U+FE70-FEFC, U+200C-200E; }
@font-face { font-family: AmiriPrint; src: url(${url('amiri-latin-400-normal.woff2')}) format('woff2');
  unicode-range: U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+2000-206F; }`;
  return renderer.render(sections, { fontFamily: 'AmiriPrint, serif', fontFaceCss });
}

/**
 * The same PDF with every /ToUnicode map removed from its fonts: what a producer that "forgot" them gives. pdf.js
 * can then only guess characters from glyph ids, and returns control characters, Latin-1 letters and random
 * scripts for Arabic text.
 */
export async function withoutToUnicode(pdf: Uint8Array): Promise<Uint8Array> {
  const doc = await PDFDocument.load(pdf);
  let removed = 0;
  for (const [, object] of doc.context.enumerateIndirectObjects()) {
    if (
      object instanceof PDFDict &&
      object.get(PDFName.of('Type')) === PDFName.of('Font') &&
      object.has(PDFName.of('ToUnicode'))
    ) {
      object.delete(PDFName.of('ToUnicode'));
      removed += 1;
    }
  }
  if (removed === 0) throw new Error('The PDF has no /ToUnicode maps to remove');
  return doc.save();
}
