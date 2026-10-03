import { randomUUID } from 'node:crypto';
import type { Direction } from '@enchanted/shared';
import { EMBEDDING_INPUT_OVERHEAD_TOKENS } from '../../chunking/tokens.js';
import { chunksRepo, type ChunkRecord } from '../../db/repositories/chunks.js';
import { documentsRepo } from '../../db/repositories/documents.js';
import { stageDataRepo } from '../../db/repositories/ingest-stage.js';
import { pagesRepo, type PageRecord } from '../../db/repositories/pages.js';
import { AppError } from '../../http/errors.js';
import type { OutlineEntry } from '../../pdf/outline.js';
import { assessPage } from '../../pdf/quality.js';
import { STAGE_OCR, STAGE_OUTLINE, STAGE_PAGE, type AnalysisCursor } from '../cursor.js';
import { FAILED_PAGE_DECISION, collectWarnings, type OcrOutcome } from '../page-policy.js';
import { settlePages } from '../settle-pages.js';
import { fitTokenWindow } from '../token-window.js';
import type { ParseResult } from '../worker/host.js';
import type { OcrPageResult, SerializedPage } from '../worker/protocol.js';
import { AGAIN, type StepResult, type TickContext } from './context.js';

/** The progress of the analysis is written at most this often: a page is a message, and a message is not a write. */
const PROGRESS_WRITE_MS = 500;

/**
 * The outcome OCR had for each page that needed it, rebuilt from the cursor and the stored results: what `settlePages`
 * decides on. A page that did not need OCR has no outcome.
 */
function ocrOutcomes(
  ocr: NonNullable<TickContext['cursor']['ocr']>,
  results: ReadonlyMap<number, OcrPageResult>,
): Map<number, OcrOutcome> {
  const outcomes = new Map<number, OcrOutcome>();
  for (const pageNumber of ocr.read) {
    const read = results.get(pageNumber);
    if (read !== undefined) {
      outcomes.set(pageNumber, {
        kind: 'read',
        confidence: read.confidence,
        languages: read.languages,
        text: read.text,
      });
    }
  }
  for (const failure of ocr.failed) {
    outcomes.set(failure.pageNumber, {
      kind: 'failed',
      ...(failure.detail === undefined ? {} : { detail: failure.detail }),
    });
  }
  for (const pageNumber of ocr.skipped) outcomes.set(pageNumber, { kind: 'skipped' });
  // The engine did not start: every page it was to read, and those beyond OCR_MAX_PAGES, has no engine to be read by.
  if (ocr.unavailable) {
    for (const pageNumber of [...ocr.pages, ...ocr.skipped]) {
      if (!outcomes.has(pageNumber)) outcomes.set(pageNumber, { kind: 'unavailable' });
    }
    for (const pageNumber of ocr.skipped) outcomes.set(pageNumber, { kind: 'unavailable' });
  }
  return outcomes;
}

/**
 * Settles what every page is (text, OCR text, empty), analyses the language, direction and sections, chunks the text (in a
 * worker thread), and stores the pages and chunks of the document in one transaction together with the move to the
 * embedding stage. Nothing is visible before that commit; a tick that dies before it leaves the stage as it was.
 */
export async function analyzeStep(ctx: TickContext): Promise<StepResult> {
  const { deps, row } = ctx;
  const { config } = deps;
  const parse = ctx.cursor.parse;
  const ocr = ctx.cursor.ocr;
  if (parse === undefined || ocr === undefined) throw new Error('the analysis has nothing to analyse');

  const stored = await stageDataRepo.all<SerializedPage>(deps.db, row.id, STAGE_PAGE);
  const pages = stored.map((entry) => entry.data);
  const outline = (await stageDataRepo.get<OutlineEntry[]>(deps.db, row.id, STAGE_OUTLINE, 0)) ?? [];
  const results = new Map(
    (await stageDataRepo.all<OcrPageResult>(deps.db, row.id, STAGE_OCR)).map((entry) => [
      entry.item,
      entry.data,
    ]),
  );
  const parsed: ParseResult = { pageCount: parse.pageCount, pages, failures: parse.failures, outline };
  const assessments = new Map(
    pages.map((page) => [page.pageNumber, assessPage(page, { minChars: config.ocrMinChars })]),
  );
  const settled = settlePages({
    parsed,
    assessments,
    outcomes: ocrOutcomes(ocr, results),
    // Null when no page needed OCR (the engine was never asked).
    ocrAvailable: ocr.pages.length === 0 && ocr.skipped.length === 0 ? null : !ocr.unavailable,
    ocrConfigured: config.ocrProvider !== 'none',
  });
  if (settled.failure !== null) throw settled.failure;
  const { decisions, evidence, kept } = settled;

  // --- analyzing + chunking (worker thread) ---
  let direction: Direction | undefined;
  let lastWrite = 0;
  let writes: Promise<void> = Promise.resolve();
  const analysis = await deps.workers.analyze(
    kept.map((page) => ({ ...page, ...evidence.get(page.pageNumber) })),
    {
      outline: parsed.outline,
      chunking: {
        targetChars: config.chunkTargetChars,
        maxChars: config.chunkMaxChars,
        minChars: config.chunkMinChars,
        overlapChars: config.chunkOverlapChars,
        maxTokens: deps.embeddings.maxInputTokens - EMBEDDING_INPUT_OVERHEAD_TOKENS,
      },
      signal: ctx.signal,
      onProgress: (step, completed, total, known) => {
        const directionKnown = known !== undefined && direction === undefined;
        if (known !== undefined) direction = known;
        const now = Date.now();
        if (!directionKnown && completed < total && now - lastWrite < PROGRESS_WRITE_MS) return;
        lastWrite = now;
        // Progress is best effort: a failed write is not a failed analysis (the commit below finds a lost lease).
        writes = writes
          .then(async () => {
            // Held to the lease like every write of a tick: a tick that lost its job writes nothing.
            await documentsRepo.setProgress(
              deps.db,
              row.id,
              { stage: step, completed, total, unit: 'pages' },
              ctx.leaseId,
            );
            if (directionKnown && direction !== undefined) {
              await documentsRepo.setDirection(deps.db, row.id, direction, ctx.leaseId);
            }
          })
          .catch((error: unknown) => {
            deps.log.warn(
              { err: error, documentId: row.id },
              'could not record the progress of the analysis',
            );
          });
      },
    },
  );
  await writes;
  if (analysis.chunks.length === 0) {
    throw new AppError('PDF_EMPTY', 'The PDF has no readable text.', 'no text could be split into passages');
  }

  // The exact token counts, when the embedding model has a tokenizer of its own (a remote service has none).
  const languages = new Map(analysis.pages.map((page) => [page.pageNumber, page.language]));
  const chunks = await fitTokenWindow(
    deps.embeddings,
    analysis.chunks,
    kept,
    (pageNumber) => languages.get(pageNumber) ?? 'und',
    {
      targetChars: config.chunkTargetChars,
      maxChars: config.chunkMaxChars,
      minChars: config.chunkMinChars,
      overlapChars: config.chunkOverlapChars,
    },
    deps.log,
  );

  // --- the records ---
  const fallback = pages[0];
  const analysisByPage = new Map(analysis.pages.map((page) => [page.pageNumber, page]));
  const pageRecords: PageRecord[] = [];
  for (let pageNumber = 1; pageNumber <= parse.pageCount; pageNumber += 1) {
    const page = settled.pages.get(pageNumber);
    const decision = decisions.get(pageNumber) ?? FAILED_PAGE_DECISION;
    const analysed = analysisByPage.get(pageNumber);
    pageRecords.push({
      pageNumber,
      width: page?.width ?? fallback?.width ?? 612,
      height: page?.height ?? fallback?.height ?? 792,
      text: decision.keepText && page !== undefined ? page.text : '',
      charCount: decision.keepText && page !== undefined ? page.charCount : 0,
      language: analysed?.language ?? 'und',
      direction: analysed?.direction ?? analysis.direction,
      extraction: decision.extraction,
      ocrConfidence: decision.ocrConfidence ?? null,
    });
  }
  const chunkRecords: ChunkRecord[] = chunks.map((chunk) => ({
    id: randomUUID(),
    chunkIndex: chunk.index,
    pageStart: chunk.pageStart,
    pageEnd: chunk.pageEnd,
    sectionTitle: chunk.sectionTitle,
    language: chunk.language,
    direction: chunk.direction,
    content: chunk.content,
    searchText: chunk.searchText,
    charStart: chunk.charStart,
    charEnd: chunk.charEnd,
    overlapChars: chunk.overlapChars,
    tokenCount: chunk.tokenCount,
    highlights: chunk.highlights,
  }));
  const warnings = collectWarnings(
    [...decisions.entries()].map(([pageNumber, decision]) => ({ pageNumber, warnings: decision.warnings })),
  );
  const found: AnalysisCursor = {
    primaryLanguage: analysis.primaryLanguage,
    direction: analysis.direction,
    languages: analysis.languages,
    sections: analysis.sections,
    warnings,
    pageCount: parsed.pageCount,
    chunkCount: chunkRecords.length,
  };
  ctx.cursor.analysis = found;

  await ctx.commit({
    stage: 'embedding',
    progress: { completed: 0, total: chunkRecords.length, unit: 'chunks' },
    writes: async (tx) => {
      await pagesRepo.insertMany(tx, row.id, pageRecords);
      await chunksRepo.insertMany(tx, row.id, chunkRecords);
      await documentsRepo.setAnalysis(tx, row.id, found);
      // The pages and OCR results have done their work: what the document keeps is in its own tables now.
      await stageDataRepo.clear(tx, row.id);
    },
  });
  return AGAIN;
}
