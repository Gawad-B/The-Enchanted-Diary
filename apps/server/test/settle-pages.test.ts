import { describe, expect, it } from 'vitest';
import { settlePages } from '../src/ingest/settle-pages.js';
import type { OcrOutcome } from '../src/ingest/page-policy.js';
import type { ParseResult } from '../src/ingest/worker/host.js';
import type { SerializedPage } from '../src/ingest/worker/protocol.js';
import { buildOcrPageText } from '../src/ocr/ocr-page.js';
import { assessPage } from '../src/pdf/quality.js';
import { extractFixture } from './fixtures.js';

const serialise = (pages: Awaited<ReturnType<typeof extractFixture>>): SerializedPage[] =>
  pages.map(({ items: _items, lines: _lines, ...rest }) => rest);

/** The pages of empty.pdf as pictures: no text, an image covering the page (a scan OCR has to read). */
const pictures = async (): Promise<SerializedPage[]> =>
  serialise(await extractFixture('empty.pdf')).map((page) => ({ ...page, imageCoverage: 1 }));

const parsed = (
  pages: SerializedPage[],
  failures: ParseResult['failures'] = [],
  count?: number,
): ParseResult => ({
  pageCount: count ?? pages.length + failures.length,
  pages,
  failures,
  outline: [],
});

const readOutcome = (text: string, confidence = 90): OcrOutcome => ({
  kind: 'read',
  confidence,
  languages: ['eng'],
  text: buildOcrPageText(
    {
      text,
      confidence,
      languagesUsed: ['eng'],
      lines: text === '' ? [] : [{ text, confidence: 90, bbox: { x0: 100, y0: 100, x1: 900, y1: 140 } }],
    },
    { pageWidth: 612, pageHeight: 792, imageWidth: 1700, imageHeight: 2200 },
  ),
});

const settle = (
  result: ParseResult,
  outcomes: Map<number, OcrOutcome> = new Map(),
  ocrAvailable: boolean | null = null,
) =>
  settlePages({
    parsed: result,
    assessments: new Map(result.pages.map((p) => [p.pageNumber, assessPage(p, { minChars: 25 })])),
    outcomes,
    ocrAvailable,
    ocrConfigured: true,
  });

describe('settlePages', () => {
  it('keeps the pages of a text document as they are', async () => {
    const pages = serialise(await extractFixture('text-en.pdf'));
    const settled = settle(parsed(pages));
    expect(settled.failure).toBeNull();
    expect(settled.kept).toHaveLength(5);
    expect(
      [...settled.decisions.values()].every((d) => d.extraction === 'text' && d.warnings.length === 0),
    ).toBe(true);
    expect(settled.evidence.size).toBe(0);
    expect(settled.pages.get(1)).toBe(pages[0]);
  });

  it('replaces the text of a page with the OCR text where OCR won, keeping the rest of the page', async () => {
    const [text] = serialise((await extractFixture('text-en.pdf')).slice(0, 1));
    const [blank] = await pictures();
    if (text === undefined || blank === undefined) throw new Error('fixtures');
    const settled = settle(
      parsed([text, { ...blank, pageNumber: 2 }]),
      new Map([[2, readOutcome('The scanned page says something worth reading here.')]]),
      true,
    );
    const second = settled.pages.get(2);
    expect(second?.text).toBe('The scanned page says something worth reading here.');
    expect(second?.charCount).toBeGreaterThan(30);
    expect(second?.width).toBe(blank.width);
    expect(second?.pageNumber).toBe(2);
    expect(settled.decisions.get(2)).toMatchObject({ extraction: 'ocr', ocrConfidence: 90 });
    expect(settled.kept.map((p) => p.pageNumber)).toEqual([1, 2]);
    expect(settled.failure).toBeNull();
  });

  it('does not let OCR text the engine was unsure of stand for the language or direction of the document', async () => {
    const [blank] = await pictures();
    if (blank === undefined) throw new Error('fixture');
    const [text] = serialise((await extractFixture('text-en.pdf')).slice(0, 1));
    if (text === undefined) throw new Error('fixture');
    const settled = settle(
      parsed([text, { ...blank, pageNumber: 2 }]),
      new Map([[2, readOutcome('xqzv wkjh', 25)]]),
      true,
    );
    expect(settled.evidence.get(2)).toEqual({ garbled: true });
    expect(settled.evidence.has(1)).toBe(false);
  });

  it('keeps garbled extracted text as no evidence and tells which way the Arabic font reads (OCR did not replace it)', async () => {
    const pages = serialise(await extractFixture('arabic-no-tounicode.pdf'));
    const settled = settle(parsed(pages), new Map(), false);
    expect(settled.evidence.get(1)).toEqual({ garbled: true, directionHint: 'rtl' });
    // Once OCR has read the page that evidence is the OCR text's own.
    const read = settle(parsed(pages), new Map([[1, readOutcome('نص عربي مقروء بوضوح تام هنا', 80)]]), true);
    expect(read.evidence.has(1)).toBe(false);
  });

  it('takes OCR text with no confidence (Gemini) as the language evidence it is: it has not said it is unsure', async () => {
    const [blank] = await pictures();
    const [text] = serialise((await extractFixture('text-en.pdf')).slice(0, 1));
    if (blank === undefined || text === undefined) throw new Error('fixtures');
    const read = readOutcome('The scanned page says something worth reading here.');
    if (read.kind !== 'read') throw new Error('unreachable');
    const noConfidence: OcrOutcome = { ...read, confidence: null };
    const settled = settle(parsed([text, { ...blank, pageNumber: 2 }]), new Map([[2, noConfidence]]), true);
    expect(settled.decisions.get(2)).toMatchObject({ extraction: 'ocr', ocrConfidence: null, warnings: [] });
    expect(settled.evidence.has(2)).toBe(false);
  });

  it('keeps a document whose pages the daily quota left unread when some page has text, flagging those pages OCR_PARTIAL', async () => {
    const [blank] = await pictures();
    const [text] = serialise((await extractFixture('text-en.pdf')).slice(0, 1));
    if (blank === undefined || text === undefined) throw new Error('fixtures');
    const settled = settle(
      parsed([text, { ...blank, pageNumber: 2 }]),
      new Map([[2, { kind: 'failed', detail: 'daily quota reached' }]]),
      true,
    );
    expect(settled.failure).toBeNull();
    expect(settled.decisions.get(2)).toEqual({
      extraction: 'empty',
      warnings: ['OCR_PARTIAL'],
      keepText: false,
    });
  });

  it('fails a document nothing of which could be read because of the daily quota as RATE_LIMITED, not as damaged', async () => {
    const outcomes = new Map<number, OcrOutcome>([[1, { kind: 'failed', detail: 'daily quota reached' }]]);
    const settled = settle(parsed(await pictures()), outcomes, true);
    expect(settled.failure?.code).toBe('RATE_LIMITED');
    expect(settled.failure?.detail).toContain('daily quota reached');
    // An engine failure that is not the quota is still PDF_UNREADABLE.
    const broken = settle(
      parsed(await pictures()),
      new Map<number, OcrOutcome>([[1, { kind: 'failed' }]]),
      true,
    );
    expect(broken.failure?.code).toBe('PDF_UNREADABLE');
  });

  it('fails a scan the model service could not read as "try again later" (LLM_UNAVAILABLE), not as damaged', async () => {
    const outcomes = new Map<number, OcrOutcome>([
      [1, { kind: 'failed', detail: 'model service unavailable' }],
    ]);
    const settled = settle(parsed(await pictures()), outcomes, true);
    expect(settled.failure?.code).toBe('LLM_UNAVAILABLE');
    expect(settled.failure?.message).toContain('upload the document again in a moment');
    expect(settled.failure?.detail).toBe('model service unavailable (OCR_PARTIAL)');
    expect(settled.failure?.code).not.toBe('PDF_UNREADABLE');
  });

  it('fails a scan whose time ran out before any page was read as "try again", not as damaged', async () => {
    const outcomes = new Map<number, OcrOutcome>([
      [1, { kind: 'failed', detail: 'time allowed for OCR used up' }],
    ]);
    const settled = settle(parsed(await pictures()), outcomes, true);
    expect(settled.failure?.code).toBe('LLM_UNAVAILABLE');
    expect(settled.failure?.message).toContain('took longer than the time allowed');
    expect(settled.failure?.detail).toBe('time allowed for OCR used up (OCR_PARTIAL)');
    // a document that has text is still kept, its unread page OCR_PARTIAL
    const [text] = serialise((await extractFixture('text-en.pdf')).slice(0, 1));
    const [blank] = await pictures();
    if (text === undefined || blank === undefined) throw new Error('fixtures');
    const kept = settle(
      parsed([text, { ...blank, pageNumber: 2 }]),
      new Map(outcomes).set(2, outcomes.get(1) ?? { kind: 'skipped' }),
      true,
    );
    expect(kept.failure).toBeNull();
  });

  it.each([
    ['the key was rejected'],
    ['model not found'],
    ['the model refuses every request (check OCR_MODEL)'],
  ])(
    'fails a scan the service refused for "%s" as a fault of the configuration, saying what to check',
    async (fault) => {
      const outcomes = new Map<number, OcrOutcome>([[1, { kind: 'failed', detail: fault }]]);
      const settled = settle(parsed(await pictures()), outcomes, true);
      expect(settled.failure?.code).toBe('LLM_UNAVAILABLE');
      expect(settled.failure?.message).toContain('GEMINI_API_KEY and OCR_MODEL');
      expect(settled.failure?.message).not.toContain('in a moment'); // waiting does not help
      expect(settled.failure?.detail).toBe(`${fault} (OCR_PARTIAL)`);
    },
  );

  it('puts the fault of the configuration before the quota, the quota before the service, the service before the time', async () => {
    const two = (await pictures()).slice(0, 1).concat([{ ...(await pictures())[0]!, pageNumber: 2 }]);
    const codeOf = (a: string, b: string): string | undefined =>
      settle(
        parsed(two),
        new Map<number, OcrOutcome>([
          [1, { kind: 'failed', detail: a }],
          [2, { kind: 'failed', detail: b }],
        ]),
        true,
      ).failure?.detail;
    expect(codeOf('time allowed for OCR used up', 'the key was rejected')).toBe(
      'the key was rejected (OCR_PARTIAL)',
    );
    expect(codeOf('model service unavailable', 'daily quota reached')).toBe(
      'daily quota reached (OCR_PARTIAL)',
    );
    expect(codeOf('time allowed for OCR used up', 'model service unavailable')).toBe(
      'model service unavailable (OCR_PARTIAL)',
    );
  });

  it('says the quota when both happened (the quota is the longer wait), and keeps a document that has any text', async () => {
    const [text] = serialise((await extractFixture('text-en.pdf')).slice(0, 1));
    const [blank] = await pictures();
    if (text === undefined || blank === undefined) throw new Error('fixtures');
    const both = new Map<number, OcrOutcome>([
      [1, { kind: 'failed', detail: 'model service unavailable' }],
      [2, { kind: 'failed', detail: 'daily quota reached' }],
    ]);
    const two = (await pictures()).slice(0, 1).concat([{ ...blank, pageNumber: 2 }]);
    expect(settle(parsed(two), both, true).failure?.code).toBe('RATE_LIMITED');
    // with one page of text the document is indexed, the unread page is OCR_PARTIAL
    const kept = settle(
      parsed([text, { ...blank, pageNumber: 2 }]),
      new Map<number, OcrOutcome>([[2, { kind: 'failed', detail: 'model service unavailable' }]]),
      true,
    );
    expect(kept.failure).toBeNull();
    expect(kept.decisions.get(2)).toEqual({
      extraction: 'empty',
      warnings: ['OCR_PARTIAL'],
      keepText: false,
    });
  });

  it('fails a document without any text as PDF_EMPTY and names OCR_UNAVAILABLE when there is no engine', async () => {
    const settled = settle(parsed(await pictures()), new Map([[1, { kind: 'unavailable' }]]), false);
    expect(settled.failure?.code).toBe('PDF_EMPTY');
    expect(settled.failure?.message).toBe('The PDF has no readable text.');
    expect(settled.failure?.detail).toBe('no page contains text and OCR is not available (OCR_UNAVAILABLE)');
  });

  it('fails a document OCR found no text in as PDF_EMPTY and says OCR looked', async () => {
    const settled = settle(parsed(await pictures()), new Map([[1, readOutcome('', 0)]]), true);
    expect(settled.failure?.code).toBe('PDF_EMPTY');
    expect(settled.failure?.detail).toBe('no page contains text; OCR found none (LOW_TEXT_QUALITY)');
    expect(settled.decisions.get(1)).toMatchObject({ extraction: 'empty', warnings: ['LOW_TEXT_QUALITY'] });
  });

  it('fails a blank document as PDF_EMPTY without a word about OCR: nothing was read because there was nothing to read', async () => {
    const blank = serialise(await extractFixture('empty.pdf'));
    const settled = settle(parsed(blank), new Map(), null);
    expect(settled.failure?.code).toBe('PDF_EMPTY');
    expect(settled.failure?.detail).toBe('no page contains text');
    expect(settled.decisions.get(1)).toEqual({ extraction: 'empty', warnings: [], keepText: false });
  });

  it('fails a document as PDF_UNREADABLE when pages could not be read (extraction or OCR failed)', async () => {
    const failed = settle(parsed(await pictures()), new Map([[1, { kind: 'failed' }]]), true);
    expect(failed.failure?.code).toBe('PDF_UNREADABLE');
    expect(failed.failure?.detail).toBe('1 of 1 pages could not be read');
    const extraction = settle(
      parsed([], [{ pageNumber: 1, reason: 'timeout', message: 'it took too long' }], 1),
    );
    expect(extraction.failure?.code).toBe('PDF_UNREADABLE');
    expect(extraction.failure?.detail).toBe('1 of 1 pages could not be read');
  });

  it('counts a page whose image was too big to decode apart, whether OCR was missing or failed on it', async () => {
    const [blank] = serialise(await extractFixture('empty.pdf'));
    if (blank === undefined) throw new Error('fixture');
    const huge = { ...blank, removedImages: 1, imageCoverage: 1 };
    for (const [outcome, available] of [
      [{ kind: 'unavailable' }, false],
      [{ kind: 'failed' }, true],
    ] as const) {
      const settled = settle(parsed([huge]), new Map([[1, outcome]]), available);
      expect(settled.failure?.code).toBe('PDF_UNREADABLE');
      expect(settled.failure?.detail).toBe(
        '1 of 1 pages could not be read (1 hold images too large to decode)',
      );
    }
  });

  it('flags a page that failed extraction with OCR_PARTIAL when there is an engine, OCR_UNAVAILABLE when there is none', async () => {
    const pages = serialise((await extractFixture('text-en.pdf')).slice(0, 1));
    const failure = [{ pageNumber: 2, reason: 'timeout' as const, message: 'it took too long' }];
    expect(settle(parsed(pages, failure), new Map(), true).decisions.get(2)?.warnings).toEqual([
      'OCR_PARTIAL',
    ]);
    expect(settle(parsed(pages, failure), new Map(), false).decisions.get(2)?.warnings).toEqual([
      'OCR_UNAVAILABLE',
    ]);
    expect(settle(parsed(pages, failure), new Map(), null).decisions.get(2)?.extraction).toBe('empty');
  });
});
