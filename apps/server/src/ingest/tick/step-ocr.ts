import type { Queryable } from '../../db/client.js';
import { stageDataRepo } from '../../db/repositories/ingest-stage.js';
import { DAILY_QUOTA_DETAIL } from '../../gemini/index.js';
import { OCR_BUDGET_DETAIL, OCR_SERVICE_DETAIL } from '../../ocr/types.js';
import { STAGE_OCR, type OcrCursor } from '../cursor.js';
import { runOcrStage } from '../ocr-stage.js';
import type { OcrPageResult } from '../worker/protocol.js';
import { AGAIN, type StepResult, type TickContext } from './context.js';

/** The pages of an OCR request, for a provider that reads documents (Gemini): this many requests per call of the worker. */
const REQUESTS_PER_CALL = 2;
/** The fewest pages a call of the OCR worker reads (and the number for an engine that reads one page at a time: Tesseract). */
const PAGES_PER_CALL_MINIMUM = 4;
/** A tick with less time than this left does not start an OCR call (starting its thread alone takes about a second). */
export const MIN_CALL_MS = 3000;
/** Calls in a row to which the service answered for no page before OCR is given up on for the document (the ticks in between wait 3 s, 9 s). */
const SILENT_CALLS_LIMIT = 3;
const SILENT_RETRY_MS = 3000;
/** What a client waits when the tick had no time left for a call. */
const NO_TIME_RETRY_MS = 1000;

const settled = (ocr: OcrCursor): Set<number> =>
  new Set([...ocr.read, ...ocr.failed.map((failure) => failure.pageNumber)]);

/**
 * Whether a reason for leaving pages unread ends OCR for the whole document: the daily quota, and a configuration the
 * service refuses (a key, a model name: nothing more is asked for the document). A service that did not answer and the time
 * allowed are different: they are only about the pages they met.
 */
const endsOcr = (detail: string): boolean => detail !== OCR_SERVICE_DETAIL && detail !== OCR_BUDGET_DETAIL;

/**
 * The pages a document may be left with when the daily quota ends OCR and is not waited for: a tenth of those OCR was to read
 * (at least one), and only once some page was read. More than that (or none read) is a document that is not yet read:
 * the job is parked until the quota starts again.
 */
const smallRemainder = (ocr: OcrCursor, unread: number): boolean =>
  ocr.read.length > 0 && unread <= Math.max(1, Math.floor(ocr.pages.length / 10));

/**
 * Reads the pages that need OCR, a few at a time (one OCR worker call per unit of work). What was read is stored as it comes;
 * a page the engine could not read is recorded, with why when it was not the page's fault, and left (OCR_PARTIAL: the
 * document is still indexed, and a scan of which nothing could be read fails as "try again later", never as damaged). When
 * OCR is over for the document (the app's budget for it is used up, the configuration is refused, the service does not
 * answer at all, or OCR_MAX_SECONDS is spent over all the ticks) every page not yet read is recorded as left with that
 * reason at once, so that no later tick asks for it again.
 *
 * A daily quota (Google's own, or the app's budget for the day) is different: it is a wait, not a verdict. The job PARKS
 * in this stage until the quota starts again (what was read is kept, the pages the quota refused stay unread and are asked
 * for after the reset), unless only a small remainder is left, which the document is let go with.
 *
 * A call is bounded by what is left of OCR_MAX_SECONDS AND of the tick (its hard limit), so that the worker's own clock
 * fires before the tick is stopped from outside; pages the tick's clock left unread are asked for in the next tick, not
 * failed. The daily OCR budget is reconciled with the requests the worker really sent.
 */
export async function ocrStep(ctx: TickContext): Promise<StepResult> {
  const ocr = ctx.cursor.ocr;
  if (ocr === undefined) throw new Error('the OCR stage has no cursor');
  const { deps, row } = ctx;
  const { config } = deps;
  const progress = (): { completed: number; total: number; unit: 'pages' } => ({
    completed: ocr.read.length + ocr.failed.length,
    total: ocr.pages.length,
    unit: 'pages',
  });
  const unread = (): number[] => {
    const done = settled(ocr);
    return ocr.pages.filter((page) => !done.has(page));
  };
  /** Stores the pages that were read (in the transaction that saves the cursor that says so). */
  const saveReads =
    (reads: OcrPageResult[]) =>
    async (tx: Queryable): Promise<void> => {
      for (const read of reads) await stageDataRepo.put(tx, row.id, STAGE_OCR, read.pageNumber, read);
    };
  /** OCR is over for this document: what is left is recorded as left, for this reason. */
  const stopWith = (detail: string): void => {
    for (const pageNumber of unread()) ocr.failed.push({ pageNumber, detail });
  };
  /**
   * The daily quota ends OCR for today: park (a wait) or, for a small remainder, let the document go with the pages left.
   * `reads` are saved either way. Returns null when the document goes on without parking.
   */
  const quotaReached = async (reads: OcrPageResult[]): Promise<StepResult | null> => {
    if (smallRemainder(ocr, unread().length)) {
      stopWith(DAILY_QUOTA_DETAIL);
      return null;
    }
    return ctx.park(progress(), DAILY_QUOTA_DETAIL, saveReads(reads));
  };

  const budgetMs = config.ocrMaxSeconds * 1000;
  if (!ocr.unavailable && unread().length > 0 && ocr.spentMs >= budgetMs) stopWith(OCR_BUDGET_DETAIL);
  const remaining = unread();
  if (ocr.unavailable || remaining.length === 0) {
    await ctx.commit({
      stage: 'analyzing',
      progress: { completed: 0, total: row.page_count, unit: 'pages' },
    });
    return AGAIN;
  }

  // No time for a call: wait (and do not read the file for nothing: a read of the store costs a day's budget).
  if (ctx.msLeft() < MIN_CALL_MS) return { kind: 'wait', retryAfterMs: NO_TIME_RETRY_MS };
  // The file first: a store that does not answer must not cost the day's budget a reservation that no request used. (And the
  // call is sized AFTER the read: a read that is slow but answers takes its time out of the tick, and the call may only have
  // what is left. Sized before it, the two together overran the tick, which is stopped, and a store that is only slow would end
  // as an interrupted document.)
  const bytes = await ctx.bytes();

  // The call may take what is left of the document's OCR time, and what is left of the tick before its hard limit.
  const leftOfBudgetMs = budgetMs - ocr.spentMs;
  const leftOfTickMs = ctx.msLeft();
  if (leftOfTickMs < MIN_CALL_MS) return { kind: 'wait', retryAfterMs: NO_TIME_RETRY_MS };
  const tickIsTheLimit = leftOfTickMs < leftOfBudgetMs;
  const callMs = Math.min(leftOfBudgetMs, leftOfTickMs);

  // Starting an OCR thread costs about a second: a call reads at least a few pages, whatever the size of a request.
  const perCall = Math.max(
    config.ocrProvider === 'gemini' ? config.ocrPagesPerRequest * REQUESTS_PER_CALL : 0,
    PAGES_PER_CALL_MINIMUM,
  );
  const slice = remaining.slice(0, perCall);

  const reserved = config.ocrProvider === 'gemini' ? Math.ceil(slice.length / config.ocrPagesPerRequest) : 0;
  const reservation = reserved > 0 ? await deps.budgets.reserve('ocr', reserved) : null;
  if (reservation?.allowed === false) {
    // The app's own budget for the day is spent: as if the service had said so.
    const result = await quotaReached([]);
    if (result !== null) return result;
    await ctx.commit({ progress: progress() });
    return AGAIN;
  }

  const started = Date.now();
  let result: Awaited<ReturnType<typeof runOcrStage>>;
  try {
    result = await runOcrStage(
      {
        workers: deps.workers,
        ocr: deps.ocr,
        // The stage reads the pages it is given: which pages and how long were decided above.
        config: {
          ...config,
          ocrMaxPages: slice.length,
          ocrMaxSeconds: Math.max(1, Math.ceil(callMs / 1000)),
        },
        log: deps.log,
      },
      {
        bytes,
        pages: slice,
        languageSample: ocr.languageSample,
        signal: ctx.signal,
        emit: () => Promise.resolve(),
        chain: (previous) => previous,
      },
    );
  } finally {
    // The time a call took is the document's, also when it was stopped (the runner writes it down: the abort counts).
    ocr.spentMs += Date.now() - started;
  }

  // The budget is kept in step with the requests the worker really sent: a batch the model answered wrongly is asked for
  // again page by page, and a retry is a request too. (Without a count nothing is changed: what was reserved stands.)
  // (Of the day the reservation was taken in: a call that ends after midnight Pacific settles the day it started on.)
  if (reservation !== null && result.requests !== null) {
    if (result.requests > reserved) {
      await deps.budgets.charge('ocr', result.requests - reserved, reservation.windowStart);
    } else if (result.requests < reserved) {
      await deps.budgets.refund('ocr', reserved - result.requests, reservation.windowStart);
    }
  }

  if (result.available === false) {
    ocr.unavailable = true;
    await ctx.commit({ progress: progress() });
    return AGAIN;
  }

  const reads: OcrPageResult[] = [];
  let ends: string | null = result.detail !== null && endsOcr(result.detail) ? result.detail : null;
  let answered = false; // a page of this call was read, or failed for a reason of its own
  const silent: { pageNumber: number; detail: string }[] = []; // pages the service did not answer for
  for (const [pageNumber, outcome] of result.outcomes) {
    if (outcome.kind === 'read') {
      reads.push({
        pageNumber,
        confidence: outcome.confidence,
        languages: outcome.languages,
        text: outcome.text,
      });
      ocr.read.push(pageNumber);
      answered = true;
    } else if (outcome.kind === 'failed') {
      // A page the quota refused is not lost: it is asked for after the reset (or, for a small remainder, left below).
      if (outcome.detail === DAILY_QUOTA_DETAIL) continue;
      // A page the TICK's clock stopped (not the document's OCR time) is asked for in the next tick.
      if (outcome.detail === OCR_BUDGET_DETAIL && tickIsTheLimit) continue;
      if (outcome.detail === OCR_SERVICE_DETAIL) {
        silent.push({ pageNumber, detail: OCR_SERVICE_DETAIL }); // decided below, with the rest of the call
        continue;
      }
      ocr.failed.push({ pageNumber, ...(outcome.detail === undefined ? {} : { detail: outcome.detail }) });
      answered = true;
      if (outcome.detail !== undefined && endsOcr(outcome.detail)) ends ??= outcome.detail;
    } else if (outcome.kind === 'skipped') {
      ocr.failed.push({ pageNumber });
    }
  }
  if (silent.length > 0 && !answered && ends === null) {
    // The service did not answer for any page of this call. That may pass (a few minutes of trouble at the service): the pages
    // stay unread and the next tick asks again, after a longer wait each time; only after SILENT_CALLS_LIMIT calls in a row
    // is it "not there" for the document, and the pages left are given up on with that reason.
    ocr.silentCalls = (ocr.silentCalls ?? 0) + 1;
    if (ocr.silentCalls < SILENT_CALLS_LIMIT) {
      await ctx.commit({ progress: progress(), writes: saveReads(reads) });
      return { kind: 'wait', retryAfterMs: SILENT_RETRY_MS * 3 ** (ocr.silentCalls - 1) };
    }
    ocr.failed.push(...silent);
    ends = OCR_SERVICE_DETAIL;
  } else {
    // Pages left for their own reasons while the service answered others: recorded as before. Any answer ends the run.
    ocr.failed.push(...silent);
    if (answered) ocr.silentCalls = 0;
  }
  if (ends === DAILY_QUOTA_DETAIL) {
    const parked = await quotaReached(reads);
    if (parked !== null) return parked;
  } else if (ends !== null) {
    stopWith(ends);
  }
  await ctx.commit({ progress: progress(), writes: saveReads(reads) });
  return AGAIN;
}
