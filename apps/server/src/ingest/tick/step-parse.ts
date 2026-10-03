import { assessPage, isBlankPage } from '../../pdf/quality.js';
import { stageDataRepo } from '../../db/repositories/ingest-stage.js';
import { STAGE_OUTLINE, STAGE_PAGE, type OcrCursor, type ParseCursor } from '../cursor.js';
import { languageSampleOf } from '../ocr-stage.js';
import type { SerializedPage } from '../worker/protocol.js';
import { AGAIN, type StepResult, type TickContext } from './context.js';

/** The first stage: the file is read from the store and checked against the hash taken when it was uploaded. */
export async function validateStep(ctx: TickContext): Promise<StepResult> {
  // Fetching the file from a remote store takes a moment: the document says what it is doing. (Only a label: it does not end the
  // run of ticks in which the store did not answer, or such a store would be asked again for ever.)
  await ctx.commit({ stage: 'validating', progress: { completed: 0, total: 1, unit: 'steps' }, label: true });
  await ctx.bytes();
  const parse: ParseCursor = { pageCount: ctx.row.page_count, nextPage: 1, failures: [], outlineRead: false };
  ctx.cursor.parse = parse;
  await ctx.commit({
    stage: 'parsing',
    progress: { completed: 0, total: parse.pageCount, unit: 'pages' },
  });
  return AGAIN;
}

/** Extracts pages (worker threads) until the tick is out of time; the page after the last one starts the next stage. */
export async function parseStep(ctx: TickContext): Promise<StepResult> {
  const parse = ctx.cursor.parse;
  if (parse === undefined) throw new Error('the parse stage has no cursor');
  if (parse.nextPage > parse.pageCount) return planOcr(ctx, parse);

  const { deps, row } = ctx;
  const bytes = await ctx.bytes();
  const progress = (): { completed: number; total: number; unit: 'pages' } => ({
    completed: parse.nextPage - 1,
    total: parse.pageCount,
    unit: 'pages',
  });

  await deps.workers.parseRange(bytes, {
    startPage: parse.nextPage,
    pageCount: parse.pageCount,
    maxPages: deps.config.maxPages,
    readOutline: !parse.outlineRead,
    priorFailures: parse.failures,
    shouldStop: () => ctx.expired(),
    signal: ctx.signal,
    onOutline: async (entries) => {
      parse.outlineRead = true;
      await ctx.commit({
        progress: progress(),
        writes: (tx) => stageDataRepo.put(tx, row.id, STAGE_OUTLINE, 0, entries),
      });
    },
    onPage: async (page: SerializedPage) => {
      parse.nextPage = Math.max(parse.nextPage, page.pageNumber + 1);
      await ctx.commit({
        progress: progress(),
        writes: (tx) => stageDataRepo.put(tx, row.id, STAGE_PAGE, page.pageNumber, page),
      });
    },
    onFailure: async (failure) => {
      parse.failures.push(failure);
      parse.nextPage = Math.max(parse.nextPage, failure.pageNumber + 1);
      await ctx.commit({ progress: progress() });
    },
  });
  return AGAIN;
}

/**
 * Every page is extracted: decides which of them need OCR (and how many are read: OCR_MAX_PAGES), takes the text that names
 * the document's languages, and moves on to the OCR stage, or straight to the analysis when no page needs it.
 */
async function planOcr(ctx: TickContext, parse: ParseCursor): Promise<StepResult> {
  const { deps, row } = ctx;
  const { config } = deps;
  const stored = await stageDataRepo.all<SerializedPage>(deps.db, row.id, STAGE_PAGE);
  const pages = stored.map((entry) => entry.data);
  const assessments = new Map(
    pages.map((page) => [page.pageNumber, assessPage(page, { minChars: config.ocrMinChars })]),
  );
  // A blank page (no text, no image, no more vector drawing than a rule) has nothing for OCR to read: it never starts an
  // OCR thread. Text drawn as vector outlines is not blank (hundreds of filled paths) and is read.
  const needOcr = pages
    .filter((page) => assessments.get(page.pageNumber)?.needsOcr === true && !isBlankPage(page))
    .map((page) => page.pageNumber);
  const ocr: OcrCursor = {
    pages: needOcr.slice(0, config.ocrMaxPages),
    skipped: needOcr.slice(config.ocrMaxPages),
    read: [],
    failed: [],
    languageSample: languageSampleOf(pages, {
      minChars: config.ocrMinChars,
      unreliable: (pageNumber) => assessments.get(pageNumber)?.unreliable === true,
    }),
    spentMs: 0,
    unavailable: false,
  };
  // Pages beyond OCR_MAX_PAGES are not read, but whether OCR could have read them says what their warning is.
  if (needOcr.length > 0 && ocr.pages.length === 0) {
    ocr.unavailable = config.ocrProvider === 'none' || !(await deps.ocr.isAvailable());
  }
  ctx.cursor.ocr = ocr;
  const reading = ocr.pages.length > 0;
  await ctx.commit({
    stage: reading ? 'ocr' : 'analyzing',
    progress: reading
      ? { completed: 0, total: ocr.pages.length, unit: 'pages' }
      : { completed: 0, total: parse.pageCount, unit: 'pages' },
  });
  return AGAIN;
}
