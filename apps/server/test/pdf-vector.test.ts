import { describe, expect, it } from 'vitest';
import { pdfjs } from '../src/pdf/load.js';
import { BLANK_PAGE_MAX_VECTOR_PATHS, assessPage, isBlankPage, needsOcr } from '../src/pdf/quality.js';
import { vectorFillCount } from '../src/pdf/vector-paths.js';
import { extractFixture } from './fixtures.js';

const { OPS } = pdfjs;

/** A constructPath operation as pdf.js 6 reports it: [the painting operator, [the flat path data], bounding box]. */
const path = (paint: number, values: number): [number, number[][], number[]] => [
  paint,
  [new Array<number>(values).fill(1)],
  [0, 0, 1, 1],
];

describe('vectorFillCount', () => {
  it('counts the filled paths of a page: a glyph outline is a few, whatever the fill rule', () => {
    const fns = [OPS.constructPath, OPS.constructPath, OPS.constructPath, OPS.constructPath];
    const args = [
      path(OPS.fill, 100),
      path(OPS.eoFill, 100),
      path(OPS.fillStroke, 100),
      path(OPS.eoFillStroke, 100),
    ];
    expect(vectorFillCount(fns, args)).toBeGreaterThanOrEqual(4);
  });

  it('does not count clipping paths, strokes or anything that is not a path', () => {
    const fns = [OPS.constructPath, OPS.constructPath, OPS.save, OPS.showText];
    const args = [path(OPS.endPath, 13), path(OPS.stroke, 13), null, null];
    expect(vectorFillCount(fns, args)).toBe(0);
  });

  it('counts a thousand outlines merged into one path by its length, not as one', () => {
    // One path of 30,000 values: a page of text whose glyphs were joined into a single path.
    expect(vectorFillCount([OPS.constructPath], [path(OPS.fill, 30_000)])).toBeGreaterThan(
      BLANK_PAGE_MAX_VECTOR_PATHS,
    );
  });

  it('counts a rectangle (a rule, a shaded cell) as one', () => {
    expect(vectorFillCount([OPS.constructPath], [path(OPS.fill, 13)])).toBe(1);
  });

  it('survives operations it does not understand', () => {
    expect(vectorFillCount([OPS.constructPath, OPS.constructPath], [[], 'x'])).toBe(0);
  });
});

describe('isBlankPage', () => {
  const page = (charCount: number, imageCoverage: number, vectorPaths: number) => ({
    charCount,
    imageCoverage,
    vectorPaths,
  });

  it('is a page with no text, no image and next to no vector drawing', () => {
    expect(BLANK_PAGE_MAX_VECTOR_PATHS).toBe(20);
    expect(isBlankPage(page(0, 0, 0))).toBe(true);
    expect(isBlankPage(page(0, 0, BLANK_PAGE_MAX_VECTOR_PATHS - 1))).toBe(true); // a rule, a border, a shaded cell
  });

  it('is not a page with text, an image, or a lot of vector drawing (text turned into outlines)', () => {
    expect(isBlankPage(page(1, 0, 0))).toBe(false);
    expect(isBlankPage(page(0, 0.01, 0))).toBe(false);
    expect(isBlankPage(page(0, 0, BLANK_PAGE_MAX_VECTOR_PATHS))).toBe(false);
  });
});

describe('vector paths of real pages', () => {
  it('finds hundreds of them on pages whose text was turned into outlines (gs -dNoOutputFonts)', async () => {
    for (const name of ['outlined-en.pdf', 'outlined-ar.pdf']) {
      const [page] = await extractFixture(name);
      if (page === undefined) throw new Error(`${name} has no page`);
      expect(page.charCount, name).toBe(0);
      expect(page.imageCoverage, name).toBe(0);
      expect(page.vectorPaths, name).toBeGreaterThan(100);
      expect(isBlankPage(page), name).toBe(false);
      expect(needsOcr(page), name).toBe(true);
    }
  });

  it('finds none on a blank page, which stays blank (the gate still asks for OCR; the pipeline skips blank pages)', async () => {
    const [page] = await extractFixture('empty.pdf');
    if (page === undefined) throw new Error('no page');
    expect(page.vectorPaths).toBe(0);
    expect(isBlankPage(page)).toBe(true);
    expect(assessPage(page, { minChars: 25 }).needsOcr).toBe(true);
  });

  it('finds almost none on pages that have text: the clipping rectangle of the Arabic fixture does not count', async () => {
    for (const page of await extractFixture('arabic.pdf')) {
      expect(page.vectorPaths).toBeLessThan(BLANK_PAGE_MAX_VECTOR_PATHS);
    }
    // Pages with 200 characters or more are not even looked at: the operator list is only read for the sparse ones.
    for (const page of await extractFixture('text-en.pdf')) expect(page.vectorPaths).toBe(0);
  });

  it('does not count a picture page or a text page as blank', async () => {
    const [scan] = await extractFixture('scanned-three.pdf');
    const [text] = await extractFixture('text-en.pdf');
    if (scan === undefined || text === undefined) throw new Error('no page');
    expect(scan.imageCoverage).toBeGreaterThan(0.5);
    expect(isBlankPage(scan)).toBe(false);
    expect(isBlankPage(text)).toBe(false);
  });
});
