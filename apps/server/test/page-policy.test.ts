import { describe, expect, it } from 'vitest';
import { buildOcrPageText } from '../src/ocr/ocr-page.js';
import type { OcrResult } from '../src/ocr/types.js';
import { assessPage } from '../src/pdf/quality.js';
import type { ExtractedPage } from '../src/pdf/types.js';
import {
  LOW_OCR_CONFIDENCE,
  decidePage,
  extractedTextScore,
  type OcrOutcome,
} from '../src/ingest/page-policy.js';
import { extractFixture } from './fixtures.js';

/*
 * What becomes of a page once OCR has had its say: whose text wins, which warnings the page earns. The pages are real
 * extractions of the fixtures; the OCR text is built from a plain result (what the engine reads is tested elsewhere).
 */

const assess = (page: ExtractedPage) => assessPage(page, { minChars: 25 });
const pageOf = async (name: string, index = 0): Promise<ExtractedPage> => {
  const page = (await extractFixture(name))[index];
  if (page === undefined) throw new Error('no such page');
  return page;
};

/** An OCR read of `words` words at `confidence`. */
function read(words: number, confidence: number): OcrOutcome {
  const lines = Array.from({ length: Math.max(1, Math.ceil(words / 8)) }, (_, i) => ({
    text: Array.from({ length: Math.min(8, words - i * 8) }, (_w, j) => `word${String(i * 8 + j)}`).join(' '),
    confidence: 90,
    bbox: { x0: 200, y0: 300 + i * 60, x1: 1400, y1: 340 + i * 60 },
  }));
  const result: OcrResult = {
    text: lines.map((l) => l.text).join('\n'),
    confidence,
    lines: words === 0 ? [] : lines,
    languagesUsed: ['eng'],
  };
  return {
    kind: 'read',
    confidence,
    languages: ['eng'],
    text: buildOcrPageText(result, { pageWidth: 612, pageHeight: 792, imageWidth: 1700, imageHeight: 2200 }),
  };
}

/** An OCR read of exactly this text at `confidence`. */
function readText(text: string, confidence: number): OcrOutcome {
  const outcome = read(0, confidence);
  if (outcome.kind !== 'read') throw new Error('unreachable');
  const result: OcrResult = {
    text,
    confidence,
    languagesUsed: ['eng'],
    lines: [{ text, confidence: 90, bbox: { x0: 200, y0: 300, x1: 1400, y1: 340 } }],
  };
  return {
    ...outcome,
    text: buildOcrPageText(result, { pageWidth: 612, pageHeight: 792, imageWidth: 1700, imageHeight: 2200 }),
  };
}

/** `count` characters (spaces not counted) as words of up to five letters. */
const letters = (count: number): string => {
  const words: string[] = [];
  for (let left = count; left > 0; left -= 5) words.push('abcde'.slice(0, Math.min(5, left)));
  return words.join(' ');
};

/** A page that is a slide or an illustrated page: some clean text on a full-bleed picture. */
const slide = (chars: number) => ({
  charCount: chars,
  imageCoverage: 0.9,
  vectorPaths: 0,
  quality: cleanQuality(chars),
});

describe('extractedTextScore', () => {
  it('is 100 for clean text, 0 for text that is garbage, and falls with the share of lost glyphs', async () => {
    const clean = await pageOf('text-en.pdf');
    expect(extractedTextScore(clean, assess(clean))).toBe(100);
    const garbled = await pageOf('arabic-no-tounicode.pdf');
    expect(extractedTextScore(garbled, assess(garbled))).toBe(0);
    const damaged = await pageOf('arabic-damaged.pdf');
    const score = extractedTextScore(damaged, assess(damaged));
    // About 3.5% of the glyphs are lost, which damages roughly one word in six.
    expect(score).toBeGreaterThan(70);
    expect(score).toBeLessThan(95);
  });
});

describe('decidePage with OCR', () => {
  it('leaves a page that does not need OCR alone', async () => {
    const page = await pageOf('text-en.pdf');
    expect(decidePage(page, assess(page), read(50, 90))).toEqual({
      extraction: 'text',
      warnings: [],
      keepText: true,
    });
  });

  it('takes the OCR text of a page without text', async () => {
    const page = await pageOf('empty.pdf');
    const outcome = read(40, 91);
    const decision = decidePage(page, assess(page), outcome);
    expect(decision).toMatchObject({ extraction: 'ocr', warnings: [], keepText: true, ocrConfidence: 91 });
    expect(decision.ocrText).toBe(outcome.kind === 'read' ? outcome.text : undefined);
  });

  it('flags OCR text the engine was not sure of, but still keeps it', async () => {
    expect(LOW_OCR_CONFIDENCE).toBe(40);
    const page = await pageOf('empty.pdf');
    expect(decidePage(page, assess(page), read(40, LOW_OCR_CONFIDENCE - 1))).toMatchObject({
      extraction: 'ocr',
      warnings: ['LOW_TEXT_QUALITY'],
      keepText: true,
    });
    expect(decidePage(page, assess(page), read(40, LOW_OCR_CONFIDENCE))).toMatchObject({ warnings: [] });
  });

  it('records a scanned page OCR found nothing on as empty, with LOW_TEXT_QUALITY', async () => {
    // An image page may hold text OCR cannot read: it is not known to be blank.
    const page = { ...(await pageOf('empty.pdf')), imageCoverage: 1 };
    expect(decidePage(page, assess(page), read(0, 0))).toEqual({
      extraction: 'empty',
      warnings: ['LOW_TEXT_QUALITY'],
      keepText: false,
    });
  });

  it('records a blank page (no text, no image, nothing for OCR to read) as empty without a warning', async () => {
    const page = await pageOf('empty.pdf');
    expect(page.imageCoverage).toBe(0);
    expect(decidePage(page, assess(page), read(0, 0))).toEqual({
      extraction: 'empty',
      warnings: [],
      keepText: false,
    });
  });

  it('lets OCR replace text that is garbage (no ToUnicode map), whatever its confidence', async () => {
    const page = await pageOf('arabic-no-tounicode.pdf');
    expect(decidePage(page, assess(page), read(30, 70))).toMatchObject({
      extraction: 'ocr',
      warnings: [],
      ocrConfidence: 70,
    });
    expect(decidePage(page, assess(page), read(30, 12))).toMatchObject({
      extraction: 'ocr',
      warnings: ['LOW_TEXT_QUALITY'],
    });
  });

  it('keeps extracted text that lost a few glyphs unless OCR reads the page better, and flags it', async () => {
    const page = await pageOf('arabic-damaged.pdf');
    const worse = decidePage(page, assess(page), read(30, 65));
    expect(worse).toMatchObject({ extraction: 'text', warnings: ['LOW_TEXT_QUALITY'], keepText: true });
    expect(worse.ocrText).toBeUndefined();
    expect(worse.ocrConfidence).toBeUndefined();
    const better = decidePage(page, assess(page), read(30, 97));
    expect(better).toMatchObject({ extraction: 'ocr', warnings: [], ocrConfidence: 97 });
  });

  it('keeps the cleaned text when OCR read nothing from a page that has text', async () => {
    const page = await pageOf('arabic-damaged.pdf');
    expect(decidePage(page, assess(page), read(0, 0))).toMatchObject({
      extraction: 'text',
      warnings: ['LOW_TEXT_QUALITY'],
      keepText: true,
    });
  });

  it('prefers OCR to the few characters of a page that is a scan with a page number on it', () => {
    const sparse = { charCount: 8, imageCoverage: 0.95, vectorPaths: 0, quality: cleanQuality(8) };
    const decision = decidePage(sparse, assess(sparse as ExtractedPage), read(60, 88));
    expect(decision).toMatchObject({ extraction: 'ocr', ocrConfidence: 88 });
    // ...but not when OCR found no more than the page already has.
    const same = decidePage(sparse, assess(sparse as ExtractedPage), read(1, 88));
    expect(same.extraction).toBe('text');
    expect(same.warnings).toEqual([]);
  });
});

describe('decidePage when OCR could not read the page', () => {
  it.each<[string, OcrOutcome]>([
    ['failed', { kind: 'failed' }],
    ['skipped (beyond OCR_MAX_PAGES)', { kind: 'skipped' }],
  ])('flags OCR_PARTIAL (%s) and keeps the text that exists', async (_name, outcome) => {
    const damaged = await pageOf('arabic-damaged.pdf');
    expect(decidePage(damaged, assess(damaged), outcome)).toEqual({
      extraction: 'text',
      warnings: ['OCR_PARTIAL', 'LOW_TEXT_QUALITY'],
      keepText: true,
    });
    // A picture without text: unread, and said so.
    const picture = { ...(await pageOf('empty.pdf')), imageCoverage: 1 };
    expect(decidePage(picture, assess(picture), outcome)).toEqual({
      extraction: 'empty',
      warnings: ['OCR_PARTIAL'],
      keepText: false,
    });
    // Page numbers and the like (a few characters on a picture) may hide a scan: unread, and said so.
    const little = { charCount: 8, imageCoverage: 0.95, vectorPaths: 0, quality: cleanQuality(8) };
    expect(decidePage(little, assess(little as ExtractedPage), outcome)).toEqual({
      extraction: 'text',
      warnings: ['OCR_PARTIAL'],
      keepText: true,
    });
  });

  it('does not flag a page whose clean text is all there is to read, whatever became of OCR (a slide, not a scan)', () => {
    const page = slide(150);
    for (const outcome of [
      { kind: 'failed' },
      { kind: 'skipped' },
      { kind: 'unavailable' },
      undefined,
    ] as const) {
      expect(decidePage(page, assess(page as ExtractedPage), outcome)).toEqual({
        extraction: 'text',
        warnings: [],
        keepText: true,
      });
    }
  });

  it('flags OCR_UNAVAILABLE when there is no engine, as before OCR existed', async () => {
    const picture = { ...(await pageOf('empty.pdf')), imageCoverage: 1 };
    expect(decidePage(picture, assess(picture), { kind: 'unavailable' })).toEqual(
      decidePage(picture, assess(picture)),
    );
    expect(decidePage(picture, assess(picture))).toEqual({
      extraction: 'empty',
      warnings: ['OCR_UNAVAILABLE'],
      keepText: false,
    });
  });

  it('flags nothing on a blank page (no text, no image): there is nothing to read, with or without an engine', async () => {
    const blank = await pageOf('empty.pdf');
    expect(blank.imageCoverage).toBe(0);
    for (const outcome of [
      { kind: 'failed' },
      { kind: 'skipped' },
      { kind: 'unavailable' },
      undefined,
    ] as const) {
      expect(decidePage(blank, assess(blank), outcome)).toEqual({
        extraction: 'empty',
        warnings: [],
        keepText: false,
      });
    }
  });
});

describe('decidePage for text drawn as vector outlines (no text layer, no image, hundreds of filled paths)', () => {
  const outlined = async () => ({ ...(await pageOf('empty.pdf')), vectorPaths: 300 });

  it('is not a blank page: OCR reads it, and its text is taken', async () => {
    const page = await outlined();
    expect(decidePage(page, assess(page), read(40, 92))).toMatchObject({
      extraction: 'ocr',
      warnings: [],
      keepText: true,
      ocrConfidence: 92,
    });
  });

  it('is flagged, never silent, when OCR cannot read it: OCR_PARTIAL if it failed or was skipped, OCR_UNAVAILABLE without an engine', async () => {
    const page = await outlined();
    for (const outcome of [{ kind: 'failed' }, { kind: 'skipped' }] as const) {
      expect(decidePage(page, assess(page), outcome)).toEqual({
        extraction: 'empty',
        warnings: ['OCR_PARTIAL'],
        keepText: false,
      });
    }
    expect(decidePage(page, assess(page), { kind: 'unavailable' })).toEqual({
      extraction: 'empty',
      warnings: ['OCR_UNAVAILABLE'],
      keepText: false,
    });
    expect(decidePage(page, assess(page))).toEqual({
      extraction: 'empty',
      warnings: ['OCR_UNAVAILABLE'],
      keepText: false,
    });
  });

  it('is a drawing OCR found no text in, which is worth a warning, unlike a blank page', async () => {
    const page = await outlined();
    expect(decidePage(page, assess(page), read(0, 0))).toEqual({
      extraction: 'empty',
      warnings: ['LOW_TEXT_QUALITY'],
      keepText: false,
    });
  });

  it('is still blank with a rule or a border on it (a few paths)', async () => {
    const page = { ...(await pageOf('empty.pdf')), vectorPaths: 5 };
    expect(decidePage(page, assess(page), { kind: 'unavailable' })).toEqual({
      extraction: 'empty',
      warnings: [],
      keepText: false,
    });
  });
});

describe('decidePage on a picture page with a few characters (a page number, a stamp)', () => {
  it.each([2, 20])(
    'takes a long read of the page whatever the engine is sure of, and flags it when it is not sure (%i characters on it)',
    (chars) => {
      const page = {
        charCount: chars,
        imageCoverage: 0.95,
        vectorPaths: 0,
        quality: cleanQuality(chars),
      };
      const assessment = assess(page as ExtractedPage);
      expect(assessment.reasons).toContain('few-characters');
      // 400 characters at a confidence of 35: Tesseract averages that low on a poor scan, and it is still the page.
      expect(decidePage(page, assessment, readText(letters(400), 35))).toMatchObject({
        extraction: 'ocr',
        warnings: ['LOW_TEXT_QUALITY'],
        keepText: true,
        ocrConfidence: 35,
      });
      expect(decidePage(page, assessment, readText(letters(400), 85))).toMatchObject({
        extraction: 'ocr',
        warnings: [],
      });
      // Not much more than the page already has: the characters on it stay.
      expect(decidePage(page, assessment, readText(letters(Math.floor(1.4 * chars)), 85)).extraction).toBe(
        'text',
      );
    },
  );

  it('still keeps a clean slide against a long read it is unsure of, which is what the floor is for', () => {
    const page = slide(150);
    expect(decidePage(page, assess(page as ExtractedPage), readText(letters(400), 35)).extraction).toBe(
      'text',
    );
  });
});

describe('decidePage never replaces good text with a partial or doubtful read', () => {
  it('keeps the text of a page that lost a few glyphs when OCR read only a fragment of it, however sure it is', async () => {
    // arabic-damaged.pdf page 1: 135 characters, mostly right. A 22-character read at 90 is a quarter of the page.
    const page = await pageOf('arabic-damaged.pdf');
    expect(page.charCount).toBeGreaterThan(100);
    const decision = decidePage(page, assess(page), readText(letters(22), 90));
    expect(decision).toMatchObject({ extraction: 'text', warnings: ['LOW_TEXT_QUALITY'], keepText: true });
    expect(decision.ocrText).toBeUndefined();
    // Reading nearly all of it (80%) at a confidence above the text's own score does replace it.
    const nearly = Math.ceil(0.8 * page.charCount);
    expect(decidePage(page, assess(page), readText(letters(nearly), 97))).toMatchObject({
      extraction: 'ocr',
    });
    expect(decidePage(page, assess(page), readText(letters(nearly - 2), 97))).toMatchObject({
      extraction: 'text',
    });
  });

  it('still replaces the garbage of a page whose text is worthless with a partial read (there is nothing to lose)', async () => {
    const page = await pageOf('arabic-no-tounicode.pdf');
    expect(decidePage(page, assess(page), readText(letters(22), 90))).toMatchObject({ extraction: 'ocr' });
  });

  it('keeps the clean text of a slide against a doubtful read of about the same length (the numbers of the review)', () => {
    const page = slide(150);
    const decision = decidePage(page, assess(page as ExtractedPage), readText(letters(154), 20));
    expect(decision).toEqual({ extraction: 'text', warnings: [], keepText: true });
    // A confident read that finds no more than the page has changes nothing either.
    expect(decidePage(page, assess(page as ExtractedPage), readText(letters(154), 90)).extraction).toBe(
      'text',
    );
  });

  it('takes the OCR text of a picture page that holds substantially more text than its caption, if the read is confident', () => {
    const caption = slide(150);
    const wins = decidePage(caption, assess(caption as ExtractedPage), readText(letters(400), 85));
    expect(wins).toMatchObject({ extraction: 'ocr', warnings: [], ocrConfidence: 85 });
    // The same amount of text read at low confidence is not worth giving the caption up for.
    expect(decidePage(caption, assess(caption as ExtractedPage), readText(letters(400), 30)).extraction).toBe(
      'text',
    );
    // Nor is a read that is only a little longer.
    expect(decidePage(caption, assess(caption as ExtractedPage), readText(letters(200), 85)).extraction).toBe(
      'text',
    );
  });
});

/** A read of exactly this text by an engine that reports no confidence (Gemini): text only, the page as one rectangle. */
function readPlain(text: string): OcrOutcome {
  const result: OcrResult = { text, confidence: null, lines: [], languagesUsed: [], layout: 'page' };
  return {
    kind: 'read',
    confidence: null,
    languages: [],
    text: buildOcrPageText(result, { pageWidth: 612, pageHeight: 792, imageWidth: 612, imageHeight: 792 }),
  };
}

describe('decidePage for an engine that reports no confidence (Gemini)', () => {
  it('takes the text of a page without any, with no confidence and no warning', async () => {
    const page = await pageOf('empty.pdf');
    const decision = decidePage(page, assess(page), readPlain(letters(200)));
    expect(decision).toMatchObject({ extraction: 'ocr', warnings: [], keepText: true, ocrConfidence: null });
    expect(decision.ocrText?.confidence).toBeNull();
  });

  it('still records a picture page the model found no text on as empty, with LOW_TEXT_QUALITY', async () => {
    const page = { ...(await pageOf('empty.pdf')), imageCoverage: 1 };
    expect(decidePage(page, assess(page), readPlain(''))).toEqual({
      extraction: 'empty',
      warnings: ['LOW_TEXT_QUALITY'],
      keepText: false,
    });
  });

  it('decides a page that lost glyphs by coverage only: at least 80% of its characters replaces it, less does not', async () => {
    const page = await pageOf('arabic-damaged.pdf');
    const nearly = Math.ceil(0.8 * page.charCount);
    expect(decidePage(page, assess(page), readPlain(letters(nearly)))).toMatchObject({
      extraction: 'ocr',
      ocrConfidence: null,
    });
    expect(decidePage(page, assess(page), readPlain(letters(nearly - 2))).extraction).toBe('text');
    // The garbage of a page whose text is worthless goes to any read.
    const garbage = await pageOf('arabic-no-tounicode.pdf');
    expect(decidePage(garbage, assess(garbage), readPlain(letters(22))).extraction).toBe('ocr');
  });

  it('decides a picture page by how much more it reads than the page has, with no floor of confidence', () => {
    const caption = slide(150);
    expect(decidePage(caption, assess(caption as ExtractedPage), readPlain(letters(400)))).toMatchObject({
      extraction: 'ocr',
      warnings: [],
      ocrConfidence: null,
    });
    expect(decidePage(caption, assess(caption as ExtractedPage), readPlain(letters(200))).extraction).toBe(
      'text',
    );
    const stamp = { charCount: 2, imageCoverage: 0.95, vectorPaths: 0, quality: cleanQuality(2) };
    expect(decidePage(stamp, assess(stamp as ExtractedPage), readPlain(letters(400)))).toMatchObject({
      extraction: 'ocr',
      warnings: [],
    });
  });
});

function cleanQuality(rawChars = 8): ExtractedPage['quality'] {
  return {
    rawChars,
    unmappedChars: 0,
    unmappedRatio: 0,
    garbageRatio: 0,
    mojibakeRatio: 0,
    sandwichedAscii: 0,
    arabicLetterShare: 0,
    scriptScatter: false,
    arabicFontNames: false,
  };
}
