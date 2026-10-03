import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { GlobalFonts, createCanvas, type SKRSContext2D } from '@napi-rs/canvas';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import {
  MIXED_SCANNED,
  SCANNED_AR,
  SCANNED_EN_PAGES,
  SCANNED_FR_PAGE,
  SCANNED_LARGE_TEXT,
  SCANNED_THREE_PAGES,
} from './scanned-text.js';

/*
 * Scanned fixtures: PDFs whose pages are only pictures, the way a flatbed scanner makes them. Text is drawn with a
 * bundled font (so the fixtures do not depend on what is installed), set slightly off true, paper-coloured and
 * speckled, then stored as JPEG: no page has a text layer, so the only way to read one is OCR.
 */

const POINTS_PER_INCH = 72;
const FONT_FAMILY = 'ScanSerif';
const PAPER_GRAY = 244;
const INK_GRAY = 28;

/** A small deterministic generator (mulberry32): the same fixtures every time. */
function seeded(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

let fontsRegistered = false;
function registerFonts(repoRoot: string): void {
  if (fontsRegistered) return;
  const file = path.join(
    repoRoot,
    'node_modules',
    '@fontsource',
    'eb-garamond',
    'files',
    'eb-garamond-latin-400-normal.woff2',
  );
  if (GlobalFonts.registerFromPath(file, FONT_FAMILY) === null) {
    throw new Error(`Could not register ${file} for the scanned fixtures`);
  }
  fontsRegistered = true;
}

export interface ScanPage {
  jpeg: Buffer;
  /** Pixels of the image. */
  width: number;
  height: number;
  /** Size of the PDF page in points. */
  pageWidth: number;
  pageHeight: number;
}

interface PageSpec {
  /** Page size in inches. */
  inches: [number, number];
  dpi: number;
  /** Font size in points at the page's size. */
  fontPt: number;
  headingPt?: number;
  heading?: string;
  paragraphs: string[];
  /** The whole page is turned by this many degrees, as a sheet put on the glass slightly off true. */
  rotationDeg: number;
  /** Peak speckle noise in gray levels. */
  noise: number;
  jpegQuality: number;
  seed: number;
}

function wrap(context: SKRSContext2D, text: string, maxWidth: number): string[] {
  const lines: string[] = [];
  let line = '';
  for (const word of text.split(' ')) {
    const candidate = line === '' ? word : `${line} ${word}`;
    if (context.measureText(candidate).width > maxWidth && line !== '') {
      lines.push(line);
      line = word;
    } else {
      line = candidate;
    }
  }
  if (line !== '') lines.push(line);
  return lines;
}

/** Draws the text, turns the sheet, speckles it, and encodes it as a JPEG. */
function renderScan(spec: PageSpec): ScanPage {
  const width = Math.round(spec.inches[0] * spec.dpi);
  const height = Math.round(spec.inches[1] * spec.dpi);
  const pxPerPt = spec.dpi / POINTS_PER_INCH;

  const sheet = createCanvas(width, height);
  const g = sheet.getContext('2d');
  g.fillStyle = `rgb(${String(PAPER_GRAY)},${String(PAPER_GRAY)},${String(PAPER_GRAY)})`;
  g.fillRect(0, 0, width, height);
  g.fillStyle = `rgb(${String(INK_GRAY)},${String(INK_GRAY)},${String(INK_GRAY)})`;
  g.textBaseline = 'alphabetic';
  const margin = Math.round(0.9 * spec.dpi);
  const maxWidth = width - 2 * margin;
  let y = margin;
  if (spec.heading !== undefined) {
    const size = (spec.headingPt ?? spec.fontPt * 1.6) * pxPerPt;
    g.font = `${String(size)}px ${FONT_FAMILY}`;
    y += size;
    g.fillText(spec.heading, margin, y);
    y += size * 1.1;
  }
  const size = spec.fontPt * pxPerPt;
  g.font = `${String(size)}px ${FONT_FAMILY}`;
  for (const paragraph of spec.paragraphs) {
    for (const line of wrap(g, paragraph, maxWidth)) {
      y += size * 1.35;
      g.fillText(line, margin, y);
    }
    y += size * 0.9;
  }

  const scan = createCanvas(width, height);
  const s = scan.getContext('2d');
  s.fillStyle = `rgb(${String(PAPER_GRAY - 6)},${String(PAPER_GRAY - 6)},${String(PAPER_GRAY - 6)})`; // the lid behind the sheet
  s.fillRect(0, 0, width, height);
  s.translate(width / 2, height / 2);
  s.rotate((spec.rotationDeg * Math.PI) / 180);
  s.drawImage(sheet, -width / 2, -height / 2);
  s.setTransform(1, 0, 0, 1, 0, 0);

  const image = s.getImageData(0, 0, width, height);
  const random = seeded(spec.seed);
  const { data } = image;
  for (let i = 0; i < data.length; i += 4) {
    const gray = Math.min(255, Math.max(0, (data[i] ?? 0) + (random() - 0.5) * 2 * spec.noise));
    data[i] = data[i + 1] = data[i + 2] = gray;
    data[i + 3] = 255;
  }
  for (let speck = 0; speck < Math.round((width * height) / 120_000); speck += 1) {
    const x = Math.floor(random() * width);
    const sy = Math.floor(random() * height);
    const at = (sy * width + x) * 4;
    const dark = 120 + Math.floor(random() * 60);
    data[at] = data[at + 1] = data[at + 2] = dark;
  }
  s.putImageData(image, 0, 0);
  return {
    jpeg: scan.toBuffer('image/jpeg', spec.jpegQuality),
    width,
    height,
    pageWidth: spec.inches[0] * POINTS_PER_INCH,
    pageHeight: spec.inches[1] * POINTS_PER_INCH,
  };
}

/** A PDF whose pages are exactly these pictures. */
export async function pdfOfScans(pages: readonly ScanPage[], textFirst?: string): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  if (textFirst !== undefined) {
    const font = await doc.embedFont(StandardFonts.TimesRoman);
    const page = doc.addPage([595, 842]);
    let y = 760;
    for (const line of textFirst.match(/.{1,80}(\s|$)/gu) ?? []) {
      page.drawText(line.trim(), { x: 72, y, size: 12, font, color: rgb(0, 0, 0) });
      y -= 18;
    }
  }
  for (const scan of pages) {
    const image = await doc.embedJpg(scan.jpeg);
    const page = doc.addPage([scan.pageWidth, scan.pageHeight]);
    page.drawImage(image, { x: 0, y: 0, width: scan.pageWidth, height: scan.pageHeight });
  }
  return doc.save();
}

const A4: [number, number] = [8.27, 11.69];
const A5: [number, number] = [5.83, 8.27];

/** `scanned-en.pdf`: two A4 pages at 200 DPI, turned by less than a degree, speckled. */
export async function scannedEnglish(repoRoot: string): Promise<Uint8Array> {
  registerFonts(repoRoot);
  return pdfOfScans(
    SCANNED_EN_PAGES.map((page, index) =>
      renderScan({
        inches: A4,
        dpi: 200,
        fontPt: 13,
        heading: page.heading,
        paragraphs: page.paragraphs,
        rotationDeg: index === 0 ? 0.6 : -0.4,
        noise: 9,
        jpegQuality: 55,
        seed: 1001 + index,
      }),
    ),
  );
}

/** `scanned-three.pdf`: three A5 pages, one paragraph each. */
export async function scannedThree(repoRoot: string): Promise<Uint8Array> {
  registerFonts(repoRoot);
  return pdfOfScans(
    SCANNED_THREE_PAGES.map((paragraph, index) =>
      renderScan({
        inches: A5,
        dpi: 200,
        fontPt: 13,
        paragraphs: [paragraph],
        rotationDeg: [0.3, -0.5, 0.2][index] ?? 0,
        noise: 8,
        jpegQuality: 55,
        seed: 2001 + index,
      }),
    ),
  );
}

/** `mixed-scanned.pdf`: page 1 has a text layer, page 2 is a scan. */
export async function mixedScanned(repoRoot: string): Promise<Uint8Array> {
  registerFonts(repoRoot);
  const scan = renderScan({
    inches: [8.27, 11.69],
    dpi: 200,
    fontPt: 13,
    paragraphs: [MIXED_SCANNED.scan],
    rotationDeg: -0.5,
    noise: 8,
    jpegQuality: 55,
    seed: 3001,
  });
  // The text layer page is A4 as well (595 x 842 points), like the scan.
  return pdfOfScans([{ ...scan, pageWidth: 595, pageHeight: 842 }], MIXED_SCANNED.text);
}

/** `scanned-large.pdf`: a 7.2 inch square page scanned at 600 DPI: 4320 x 4320 pixels, 18.7 million, above the 16 million of extraction. */
export async function scannedLarge(repoRoot: string): Promise<Uint8Array> {
  registerFonts(repoRoot);
  return pdfOfScans([
    renderScan({
      inches: [7.2, 7.2],
      dpi: 600,
      fontPt: 13,
      paragraphs: [SCANNED_LARGE_TEXT],
      rotationDeg: 0.3,
      noise: 7,
      jpegQuality: 45,
      seed: 4001,
    }),
  ]);
}

/** One right-to-left page as HTML: a heading and paragraphs of Amiri text on a paper-grey sheet. */
export interface RtlScanContent {
  lang: string;
  heading: string;
  paragraphs: readonly string[];
}

/** CSS pixels of an A4 sheet at 96 DPI / 2 (the screenshot is taken at twice the density: 200 DPI). */
export const A4_CSS = { width: 827, height: 1170 } as const;
/** The same for A5. */
export const A5_CSS = { width: 583, height: 827 } as const;

export function rtlScanHtml(
  repoRoot: string,
  content: RtlScanContent,
  size: { width: number; height: number } = A4_CSS,
): string {
  const font = pathToFileURL(
    path.join(repoRoot, 'node_modules', '@fontsource', 'amiri', 'files', 'amiri-arabic-400-normal.woff2'),
  ).href;
  const css = `
@font-face { font-family: AmiriScan; src: url(${font}) format('woff2');
  unicode-range: U+0600-06FF, U+0750-077F, U+FB50-FDFF, U+FE70-FEFC, U+200C-200E; }
body { margin: 0; background: #f4f4f4; }
.sheet { box-sizing: border-box; width: ${String(size.width)}px; height: ${String(size.height)}px; padding: 110px 90px; direction: rtl;
  font-family: AmiriScan, serif; color: #1c1c1c; background: #f4f4f4; }
h1 { font-size: 46px; margin: 0 0 40px; font-weight: normal; }
p { font-size: 32px; line-height: 2.1; margin: 0 0 28px; }`;
  const body = content.paragraphs.map((paragraph) => `<p>${paragraph}</p>`).join('');
  return `<!doctype html><html lang="${content.lang}" dir="rtl"><head><meta charset="utf-8"><style>${css}</style></head><body><div class="sheet"><h1>${content.heading}</h1>${body}</div></body></html>`;
}

export const arabicScanHtml = (repoRoot: string): string =>
  rtlScanHtml(repoRoot, { lang: 'ar', ...SCANNED_AR });

/** A PDF page that is exactly this PNG, `pageWidth` x `pageHeight` points. */
export async function scannedPng(png: Buffer, pageWidth = 595, pageHeight = 842): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const image = await doc.embedPng(png);
  const page = doc.addPage([pageWidth, pageHeight]);
  page.drawImage(image, { x: 0, y: 0, width: pageWidth, height: pageHeight });
  return doc.save();
}

/** `scanned-ar.pdf`: one A4 page that is the screenshot of shaped Arabic text (Amiri), at 2x: 1654 x 2340 pixels. */
export const scannedArabic = (png: Buffer): Promise<Uint8Array> => scannedPng(png);

/** `scanned-fr.pdf`: one A5 page of French (accents and the typographic apostrophe), 200 DPI. */
export async function scannedFrench(repoRoot: string): Promise<Uint8Array> {
  registerFonts(repoRoot);
  return pdfOfScans([
    renderScan({
      inches: A5,
      dpi: 200,
      fontPt: 13,
      paragraphs: SCANNED_FR_PAGE,
      rotationDeg: 0.4,
      noise: 8,
      jpegQuality: 55,
      seed: 5001,
    }),
  ]);
}
