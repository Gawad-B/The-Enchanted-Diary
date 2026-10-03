/*
 * npm run fixtures
 *
 * Writes the test PDFs of the server (and the end-to-end tests) to fixtures/. Everything here is original text.
 * Needs Playwright's Chromium (page.pdf()), Ghostscript (the encrypted file) and, for the clean Arabic files, a
 * system Arabic font that Chromium embeds without lost glyphs (Droid Arabic Kufi or Vazirmatn).
 *
 * The generator checks what it makes and fails loudly: arabic.pdf must have 0 unmapped glyphs, arabic-damaged.pdf
 * must have a measurable share of them (it exists to test the quality gate), and every valid file must open with
 * the page count it promises.
 *
 * Chromium needs about 0.4 GB: run it under the heavy lock (global section M).
 *
 * `npm run fixtures -- --only=scanned` writes just the scanned files (scanned-*.pdf, mixed-scanned.pdf) and leaves the
 * other files untouched; `--only=outlined` writes just the outlined-text files (outlined-*.pdf, mixed-outlined.pdf: text
 * turned into vector outlines with Ghostscript, no Chromium needed); `--only=locked` writes just scanned-ar-locked.pdf (the
 * Arabic scan encrypted with an owner password only, made from the scanned-ar.pdf already in fixtures/, no Chromium needed);
 * `--only=injection` writes just injection.pdf and injection-spoof.pdf (the prompt-injection fixtures of the RAG tests).
 */
import { execFile } from 'node:child_process';
import { copyFile, mkdir, readFile, readdir, rename, rm, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { createCanvas } from '@napi-rs/canvas';
import { REPO_ROOT } from '../apps/server/src/config.js';
import { extractPage } from '../apps/server/src/pdf/extract-page.js';
import { closePdf, loadPdf } from '../apps/server/src/pdf/load.js';
import {
  ARABIC_PAGES,
  DAMAGED_PAGES,
  MIXED_LINE_PAGE,
  MIXED_PAGES,
  Renderer,
  renderCleanArabic,
  renderDamagedArabic,
  withoutToUnicode,
} from './fixtures/arabic.js';
import { blankPage, numberedPages, rotatedPage, textEnglish } from './fixtures/english.js';
import { hostileImagesPdf, oversizedImagePdf } from './fixtures/hostile.js';
import { injectionPdf } from './fixtures/injection.js';
import { injectionSpoofPdf } from './fixtures/injection-spoof.js';
import { ownerLocked } from './fixtures/locked.js';
import { outlinePages, textThenOutlined } from './fixtures/outlined.js';
import {
  A5_CSS,
  arabicScanHtml,
  mixedScanned,
  rtlScanHtml,
  scannedArabic,
  scannedEnglish,
  scannedFrench,
  scannedLarge,
  scannedPng,
  scannedThree,
} from './fixtures/scanned.js';
import { SCANNED_FA, SCANNED_UR } from './fixtures/scanned-text.js';

const run = promisify(execFile);
const OUT_DIR = path.join(REPO_ROOT, 'fixtures');
const SCRATCH_DIR = path.join(REPO_ROOT, '.data', 'tmp', `fixtures-${String(process.pid)}`);
/** Everything is generated here first; fixtures/ is only touched once all of it has been made and checked. */
const STAGE_DIR = path.join(SCRATCH_DIR, 'out');
const SIZE_BUDGET_BYTES = 3 * 1024 * 1024;
/**
 * Fixtures that are committed as they are, not generated: a real document the evals ask questions of. The generator never
 * writes or deletes them and counts them towards the budget. `tips-hindawi-university.pdf` is the Tips Hindawi University
 * information sheet of the course's Lab 2 (a 4-page English PDF), used by the live RAG evals.
 */
const STATIC_FIXTURES: readonly string[] = ['tips-hindawi-university.pdf'];

interface RawStats {
  pages: number;
  unmapped: number;
  total: number;
}

/** What pdf.js hands back before any cleaning: page count and how many characters are U+0000 / U+FFFD. */
async function rawStats(bytes: Uint8Array): Promise<RawStats> {
  const doc = await loadPdf(bytes);
  try {
    let unmapped = 0;
    let total = 0;
    for (let n = 1; n <= doc.numPages; n += 1) {
      const page = await doc.getPage(n);
      const content = await page.getTextContent();
      for (const item of content.items) {
        if (!('str' in item)) continue;
        total += item.str.length;
        // eslint-disable-next-line no-control-regex -- counting NUL glyphs is the point
        unmapped += item.str.match(/[\u0000\uFFFD]/gu)?.length ?? 0;
      }
      page.cleanup();
    }
    return { pages: doc.numPages, unmapped, total };
  } finally {
    await closePdf(doc);
  }
}

const written: { name: string; bytes: number; note: string }[] = [];

async function write(name: string, bytes: Uint8Array | Buffer, note: string): Promise<void> {
  await writeFile(path.join(STAGE_DIR, name), bytes);
  written.push({ name, bytes: bytes.byteLength, note });
}

async function expectPages(name: string, bytes: Uint8Array, pages: number): Promise<RawStats> {
  const stats = await rawStats(bytes);
  if (stats.pages !== pages)
    throw new Error(`${name}: expected ${String(pages)} pages, pdf.js sees ${String(stats.pages)}`);
  return stats;
}

function pngBytes(): Buffer {
  const canvas = createCanvas(96, 64);
  const context = canvas.getContext('2d');
  context.fillStyle = '#e9dcc0';
  context.fillRect(0, 0, 96, 64);
  context.fillStyle = '#3b2a1e';
  context.fillRect(8, 8, 80, 8);
  context.fillRect(8, 28, 60, 8);
  context.fillRect(8, 48, 40, 8);
  return canvas.toBuffer('image/png');
}

const onlyScanned = process.argv.includes('--only=scanned');
const onlyInjection = process.argv.includes('--only=injection');
const onlyOutlined = process.argv.includes('--only=outlined');
const onlyLocked = process.argv.includes('--only=locked');
/** With `--only` the files not generated stay as they are. */
const partial = onlyScanned || onlyInjection || onlyOutlined || onlyLocked;

/** The prompt-injection fixture: ordinary facts, then visible, white and invisible instructions (see fixtures/injection.ts). */
async function generateInjectionFixture(): Promise<void> {
  const renderer = new Renderer(path.join(SCRATCH_DIR, 'chromium-injection'));
  await renderer.open();
  try {
    const injection = await injectionPdf(renderer, rawStats);
    await expectPages('injection.pdf', injection, 2);
    await write(
      'injection.pdf',
      injection,
      '2 pages: ordinary facts, then English / Arabic / white / invisible instructions',
    );
  } finally {
    await renderer.close();
  }
  const spoof = await injectionSpoofPdf();
  await expectPages('injection-spoof.pdf', spoof, 1);
  await write(
    'injection-spoof.pdf',
    spoof,
    '1 page: two facts, then a fake end of the excerpt block, a copy of the app’s own line and a forged excerpt',
  );
}

/** Every file except the scanned ones: text PDFs, Arabic and mixed-direction files, invalid and hostile files. */
async function generateTextFixtures(): Promise<void> {
  // --- English and synthetic files (pdf-lib) ---
  const english = await textEnglish();
  await expectPages('text-en.pdf', english, 5);
  await write(
    'text-en.pdf',
    english,
    '5 pages: title, "The Founding", list + table, "The Lost Archive", conclusion',
  );

  const long = await numberedPages(40, 'Long manuscript');
  await expectPages('multi-page-long.pdf', long, 40);
  await write('multi-page-long.pdf', long, '40 pages of distinct numbered paragraphs');

  const twelve = await numberedPages(12, 'Twelve pages', 2);
  await expectPages('twelve-pages.pdf', twelve, 12);
  await write('twelve-pages.pdf', twelve, '12 pages (TOO_MANY_PAGES with MAX_PAGES=10)');

  const blank = await blankPage();
  await expectPages('empty.pdf', blank, 1);
  await write('empty.pdf', blank, 'one blank page (no readable text)');

  const rotated = await rotatedPage();
  await expectPages('rotated.pdf', rotated, 1);
  await write('rotated.pdf', rotated, 'one page with /Rotate 90, text upright on screen');

  // --- invalid files ---
  const truncated = english.subarray(0, Math.floor(english.length * 0.6));
  const garbage = Buffer.from(
    '\n%garbage garbage garbage \u0000\u0001\u0002 endobj stream xref trailer << /Root 99 0 R >> startxref 0 %%EOF\n',
  );
  await write(
    'malformed.pdf',
    Buffer.concat([truncated, garbage]),
    'a valid PDF truncated to 60% plus garbage',
  );
  await write('not-a-pdf.pdf', pngBytes(), 'PNG bytes with a .pdf name');

  const plain = path.join(SCRATCH_DIR, 'plain.pdf');
  await mkdir(SCRATCH_DIR, { recursive: true });
  await writeFile(plain, english);
  const encryptedPath = path.join(STAGE_DIR, 'encrypted.pdf');
  await run('gs', [
    '-q',
    '-dNOPAUSE',
    '-dBATCH',
    '-sDEVICE=pdfwrite',
    '-sOwnerPassword=owner-secret',
    '-sUserPassword=user-secret',
    `-sOutputFile=${encryptedPath}`,
    plain,
  ]);
  written.push({
    name: 'encrypted.pdf',
    bytes: (await stat(encryptedPath)).size,
    note: 'Ghostscript, user password required',
  });

  // --- Arabic and mixed-direction files (Chromium) ---
  const renderer = new Renderer(path.join(SCRATCH_DIR, 'chromium'));
  await renderer.open();
  try {
    const clean = await renderCleanArabic(renderer, ARABIC_PAGES, rawStats);
    const arabicStats = await expectPages('arabic.pdf', clean.pdf, 3);
    if (arabicStats.unmapped !== 0)
      throw new Error(`arabic.pdf has ${String(arabicStats.unmapped)} NUL glyphs`);
    await write(
      'arabic.pdf',
      clean.pdf,
      `3 pages, ${clean.font}, 0 unmapped glyphs of ${String(arabicStats.total)}`,
    );

    const cleanFamily = `'${clean.font}', 'Liberation Sans', sans-serif`;
    const mixed = await renderer.render(MIXED_PAGES, { fontFamily: cleanFamily });
    const mixedStats = await expectPages('mixed-ar-en.pdf', mixed, 2);
    await write(
      'mixed-ar-en.pdf',
      mixed,
      `2 pages: English, then Arabic with English terms (${String(mixedStats.unmapped)} unmapped)`,
    );

    const mixedLine = await renderer.render([MIXED_LINE_PAGE], { fontFamily: cleanFamily });
    const lineStats = await expectPages('arabic-mixed-line.pdf', mixedLine, 1);
    if (lineStats.unmapped !== 0)
      throw new Error(`arabic-mixed-line.pdf has ${String(lineStats.unmapped)} NUL glyphs`);
    await write('arabic-mixed-line.pdf', mixedLine, 'lines mixing Arabic, Latin, MS-4471, ١٩٩٩ and 1999');

    const damaged = await renderDamagedArabic(renderer, REPO_ROOT, DAMAGED_PAGES);
    const damagedStats = await expectPages('arabic-damaged.pdf', damaged, 3);
    const damagedShare = damagedStats.unmapped / damagedStats.total;
    if (damagedShare < 0.005) {
      throw new Error(
        `arabic-damaged.pdf only has ${(damagedShare * 100).toFixed(2)}% unmapped glyphs: it would not trigger the quality gate`,
      );
    }
    await write(
      'arabic-damaged.pdf',
      damaged,
      `Chromium + Amiri, ${(damagedShare * 100).toFixed(1)}% unmapped glyphs`,
    );

    const noToUnicode = await withoutToUnicode(clean.pdf);
    await expectPages('arabic-no-tounicode.pdf', noToUnicode, 3);
    await write(
      'arabic-no-tounicode.pdf',
      noToUnicode,
      'arabic.pdf with every /ToUnicode map removed (garbled extraction)',
    );
  } finally {
    await renderer.close();
  }

  // --- hostile files ---
  const hostileImages = await hostileImagesPdf();
  await write('hostile-images.pdf', hostileImages.bytes, hostileImages.note);
  const oversized = await oversizedImagePdf();
  await write('oversized-image.pdf', oversized.bytes, oversized.note);
}

/** PDFs whose pages are pictures only (no text layer at all): the way to read them is OCR. */
async function generateScannedFixtures(): Promise<void> {
  const check = async (name: string, bytes: Uint8Array, pages: number, textPages = 0): Promise<void> => {
    await expectPages(name, bytes, pages);
    // The text layer is checked page by page: only the first `textPages` pages may have text.
    const doc = await loadPdf(bytes);
    try {
      for (let n = 1; n <= doc.numPages; n += 1) {
        const page = await doc.getPage(n);
        const chars = (await page.getTextContent()).items.reduce(
          (sum, item) => sum + ('str' in item ? item.str.length : 0),
          0,
        );
        page.cleanup();
        if (n <= textPages ? chars === 0 : chars > 0)
          throw new Error(`${name} page ${String(n)} has ${String(chars)} text characters`);
      }
    } finally {
      await closePdf(doc);
    }
  };

  const english = await scannedEnglish(REPO_ROOT);
  await check('scanned-en.pdf', english, 2);
  await write('scanned-en.pdf', english, '2 image-only A4 pages, 200 DPI, rotated under a degree, speckled');

  const three = await scannedThree(REPO_ROOT);
  await check('scanned-three.pdf', three, 3);
  await write('scanned-three.pdf', three, '3 image-only A5 pages, one paragraph each');

  const mixed = await mixedScanned(REPO_ROOT);
  await check('mixed-scanned.pdf', mixed, 2, 1);
  await write('mixed-scanned.pdf', mixed, 'page 1 has a text layer, page 2 is image-only');

  const large = await scannedLarge(REPO_ROOT);
  await check('scanned-large.pdf', large, 1);
  await write(
    'scanned-large.pdf',
    large,
    'one image-only page of 4320 x 4320 pixels (18.7 megapixels, 600 DPI)',
  );

  const french = await scannedFrench(REPO_ROOT);
  await check('scanned-fr.pdf', french, 1);
  await write('scanned-fr.pdf', french, 'one image-only A5 page of French');

  const renderer = new Renderer(path.join(SCRATCH_DIR, 'chromium-scan'));
  await renderer.open();
  try {
    const png = await renderer.screenshot(arabicScanHtml(REPO_ROOT), { width: 827, height: 1170 });
    const arabic = await scannedArabic(png);
    await check('scanned-ar.pdf', arabic, 1);
    await write('scanned-ar.pdf', arabic, 'one image-only page: a screenshot of shaped Arabic text (Amiri)');

    // Persian and Urdu (A5): scripts the `ara` pack cannot read.
    for (const [name, lang, content, note] of [
      ['scanned-fa.pdf', 'fa', SCANNED_FA, 'Persian (Amiri screenshot)'],
      ['scanned-ur.pdf', 'ur', SCANNED_UR, 'Urdu (Amiri screenshot)'],
    ] as const) {
      const shot = await renderer.screenshot(rtlScanHtml(REPO_ROOT, { lang, ...content }, A5_CSS), A5_CSS);
      const pdf = await scannedPng(shot, 420, 595);
      await check(name, pdf, 1);
      await write(name, pdf, `one image-only A5 page: ${note}`);
    }
  } finally {
    await renderer.close();
  }
}

/** A fixture as it is in this run (staged if it was just generated) or as it is in fixtures/. */
async function sourceFixture(name: string): Promise<Uint8Array> {
  const staged = path.join(STAGE_DIR, name);
  const bytes = await readFile(staged).catch(() => readFile(path.join(OUT_DIR, name)));
  return new Uint8Array(bytes);
}

/** PDFs whose text is drawn as vector outlines: no text layer, no images, hundreds of filled paths. */
async function generateOutlinedFixtures(): Promise<void> {
  const check = async (name: string, bytes: Uint8Array, pages: number, textPages = 0): Promise<void> => {
    await expectPages(name, bytes, pages);
    const doc = await loadPdf(bytes);
    try {
      for (let n = 1; n <= doc.numPages; n += 1) {
        const page = await extractPage(doc, n);
        if (n <= textPages) {
          if (page.charCount === 0) throw new Error(`${name} page ${String(n)} has no text layer`);
        } else if (page.charCount !== 0 || page.imageCoverage !== 0 || page.vectorPaths < 100) {
          throw new Error(
            `${name} page ${String(n)} is not outlined text: ${String(page.charCount)} characters, ` +
              `image coverage ${String(page.imageCoverage)}, ${String(page.vectorPaths)} vector paths`,
          );
        }
      }
    } finally {
      await closePdf(doc);
    }
  };
  const scratch = path.join(SCRATCH_DIR, 'outline');
  const english = await outlinePages(await sourceFixture('text-en.pdf'), { first: 2, last: 2 }, scratch);
  await check('outlined-en.pdf', english, 1);
  await write(
    'outlined-en.pdf',
    english,
    'text-en.pdf page 2 with every glyph a filled path (gs -dNoOutputFonts)',
  );
  const arabic = await outlinePages(await sourceFixture('arabic.pdf'), { first: 1, last: 1 }, scratch);
  await check('outlined-ar.pdf', arabic, 1);
  await write(
    'outlined-ar.pdf',
    arabic,
    'arabic.pdf page 1 with every glyph a filled path (gs -dNoOutputFonts)',
  );
  const mixed = await textThenOutlined(await sourceFixture('text-en.pdf'), arabic);
  await check('mixed-outlined.pdf', mixed, 2, 1);
  await write('mixed-outlined.pdf', mixed, 'page 1 has a text layer, page 2 is Arabic text as outlines');
}

/** The Arabic scan encrypted with an owner password only (a "permissions-only" PDF: readable by everyone). */
async function generateLockedFixtures(): Promise<void> {
  const locked = await ownerLocked(await sourceFixture('scanned-ar.pdf'), path.join(SCRATCH_DIR, 'lock'));
  await expectPages('scanned-ar-locked.pdf', locked, 1);
  // It opens without a password, its page is still the picture, and its bytes say it is encrypted.
  const doc = await loadPdf(locked);
  try {
    const page = await extractPage(doc, 1);
    if (page.charCount !== 0 || page.imageCoverage === 0)
      throw new Error('scanned-ar-locked.pdf is not an image-only page');
  } finally {
    await closePdf(doc);
  }
  if (!Buffer.from(locked).includes('/Encrypt')) throw new Error('scanned-ar-locked.pdf is not encrypted');
  await write(
    'scanned-ar-locked.pdf',
    locked,
    'scanned-ar.pdf encrypted with an owner password only (gs, RC4 128)',
  );
}

async function main(): Promise<void> {
  await rm(SCRATCH_DIR, { recursive: true, force: true });
  await mkdir(STAGE_DIR, { recursive: true });
  if (!partial) await generateTextFixtures();
  if (!onlyInjection && !onlyOutlined && !onlyLocked) await generateScannedFixtures();
  if (!onlyInjection && !onlyScanned && !onlyLocked) await generateOutlinedFixtures();
  if (!partial || onlyScanned || onlyLocked) await generateLockedFixtures();
  if (!onlyScanned && !onlyOutlined && !onlyLocked) await generateInjectionFixture();

  const fresh = new Set(written.map((file) => file.name));
  await mkdir(OUT_DIR, { recursive: true });
  // With --only the other files stay as they are; they still count towards the budget, and so do the static fixtures.
  let kept = 0;
  for (const name of await readdir(OUT_DIR)) {
    if (name.endsWith('.pdf') && !fresh.has(name) && (partial || STATIC_FIXTURES.includes(name))) {
      kept += (await stat(path.join(OUT_DIR, name))).size;
    }
  }
  const total = written.reduce((sum, file) => sum + file.bytes, 0);
  for (const file of written) {
    console.log(`${file.name.padEnd(26)} ${String(file.bytes).padStart(9)} bytes  ${file.note}`);
  }
  console.log(`${'total'.padEnd(26)} ${String(total + kept).padStart(9)} bytes`);
  if (total + kept > SIZE_BUDGET_BYTES)
    throw new Error(
      `fixtures are ${String(total + kept)} bytes, over the ${String(SIZE_BUDGET_BYTES)} budget`,
    );

  // Only now does fixtures/ change: new files replace the old ones, and PDFs no longer generated are removed.
  if (!partial) {
    for (const name of await readdir(OUT_DIR)) {
      if (name.endsWith('.pdf') && !fresh.has(name) && !STATIC_FIXTURES.includes(name)) {
        await unlink(path.join(OUT_DIR, name));
      }
    }
  }
  for (const name of fresh) {
    const target = path.join(OUT_DIR, name);
    try {
      await rename(path.join(STAGE_DIR, name), target);
    } catch {
      await copyFile(path.join(STAGE_DIR, name), target); // another file system
    }
  }
  await rm(SCRATCH_DIR, { recursive: true, force: true });
}

main()
  .finally(() => rm(SCRATCH_DIR, { recursive: true, force: true })) // also after a failure: fixtures/ is untouched then
  .then(
    () => process.exit(0),
    (error: unknown) => {
      console.error(error);
      process.exit(1);
    },
  );
