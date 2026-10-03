import { AppError } from '../../http/errors.js';
import type { OutlineEntry } from '../../pdf/outline.js';
import { PageLedger, type PageFailure } from './ledger.js';
import type { SerializedPage } from './protocol.js';
import {
  abortError,
  runThread,
  stopDetail,
  stopReason,
  workerFailure,
  type Outcome,
  type ThreadContext,
} from './thread.js';

/*
 * One tick's share of the text extraction: the pages from `startPage` on, until the tick runs out of time. It is the
 * restartable-thread loop of host-parse.ts (a page that times out, grows the process too much, throws or kills its
 * thread is lost and a fresh thread goes on after it; five lost in a row give up) with two differences: it may STOP early,
 * leaving the pages it did not reach for the next tick, which the whole-document `parse` cannot do, and the run of lost
 * pages it counts does not start at 0 in every tick: the pages the earlier ticks gave up on, right before `startPage`, are
 * part of it (`priorFailures`), so that "five in a row" holds over the whole document and not once per tick.
 */

export interface ParseRangeOptions {
  /** The first page to extract. */
  startPage: number;
  /** The last page of the document. */
  pageCount: number;
  /** MAX_PAGES. */
  maxPages: number;
  /** Read the outline too (the first tick of a job does). */
  readOutline: boolean;
  /** The pages given up on so far (by earlier ticks): the run of them that ends right before `startPage` counts as lost in a row. */
  priorFailures?: readonly PageFailure[];
  /** Asked after every page: true stops the range once the page just finished is recorded. */
  shouldStop(): boolean;
  signal?: AbortSignal;
  /** A page was extracted. Awaited before the next page's result is handled (writes to the database). */
  onPage(page: SerializedPage): Promise<void>;
  /** A page was given up on. */
  onFailure(failure: PageFailure): Promise<void>;
  onOutline(entries: OutlineEntry[]): Promise<void>;
}

export interface ParseRangeResult {
  /** Pages extracted by this call. */
  extracted: number;
  /** The first page not settled (by this call or before): where the next tick starts; pageCount + 1 when done. */
  nextPage: number;
}

const UNREADABLE = 'The pages appear damaged or unreadable.';

/** The pages given up on in a row, ending at `startPage - 1`: the run a new range goes on from. */
export function trailingFailureRun(failures: readonly PageFailure[], startPage: number): number {
  const failed = new Set(failures.map((failure) => failure.pageNumber));
  let run = 0;
  for (let page = startPage - 1; page >= 1 && failed.has(page); page -= 1) run += 1;
  return run;
}

export async function parsePageRange(
  context: ThreadContext,
  bytes: Uint8Array,
  options: ParseRangeOptions,
): Promise<ParseRangeResult> {
  const { limits, log } = context;
  const pages = Array.from(
    { length: options.pageCount - options.startPage + 1 },
    (_, i) => options.startPage + i,
  );
  const ledger = new PageLedger<SerializedPage>(pages);
  const priorRun = trailingFailureRun(options.priorFailures ?? [], options.startPage);
  if (priorRun > 0) ledger.seedFailureRun(priorRun, options.startPage - 1);

  // What the thread reports is written to the database one item at a time, in order. A write that fails (the job lost its
  // lease, the document was removed) stops the thread: nobody is waiting for what it would read next.
  const failed = new AbortController();
  const signal =
    options.signal === undefined ? failed.signal : AbortSignal.any([options.signal, failed.signal]);
  let writes: Promise<void> = Promise.resolve();
  const write: { error: Error | null } = { error: null };
  // (Read through functions: what sets these runs later, in a callback, which the compiler cannot see.)
  const writeError = (): Error | null => write.error;
  const later = (work: () => Promise<void>): void => {
    writes = writes.then(work).catch((error: unknown) => {
      write.error ??= error instanceof Error ? error : new Error('a write of the extracted pages failed');
      failed.abort();
    });
  };
  const lost = (pageNumber: number): void => {
    later(() => options.onFailure(failureOf(ledger, pageNumber)));
  };

  let extracted = 0;
  let readOutline = options.readOutline;
  const state = { stopped: false };
  const thread = { opened: false };
  const isStopped = (): boolean => state.stopped;
  const isOpened = (): boolean => thread.opened;
  const isDone = (): boolean => ledger.done;

  while (!isDone() && !isStopped()) {
    thread.opened = false;
    const outcome: Outcome<true> = { result: null, failure: null };
    const end = await runThread({
      entry: context.entry,
      stopGraceMs: context.stopGraceMs,
      task: {
        task: 'parse',
        bytes,
        startPage: ledger.remaining[0] ?? options.startPage,
        maxPages: options.maxPages,
        readOutline,
        paced: true,
      },
      bytes,
      maxOldGenerationSizeMb: limits.maxOldGenerationSizeMb,
      signal,
      initialWatchdogMs: context.openTimeout,
      memory: context.memory,
      onMessage: (message, control) => {
        switch (message.type) {
          case 'opened':
            thread.opened = true;
            if (message.pageCount !== options.pageCount) {
              outcome.failure = new AppError('PDF_MALFORMED', 'The PDF is not the one that was uploaded.');
              control.finish();
              break;
            }
            control.watchdog(context.openTimeout); // reading the outline comes next, before any page starts
            break;
          case 'outline':
            readOutline = false;
            later(() => options.onOutline(message.entries));
            break;
          case 'page-start':
            ledger.begin(message.pageNumber);
            control.watchdog(limits.pageTimeoutMs);
            control.watchMemory(true);
            break;
          case 'page':
            ledger.complete(message.page.pageNumber, message.page);
            extracted += 1;
            later(() => options.onPage(message.page));
            control.watchdog(null);
            control.watchMemory(false);
            if (options.shouldStop()) {
              state.stopped = true;
              control.finish(); // the thread is idle, waiting: it is asked to stop and ends by itself
            } else {
              control.next();
            }
            break;
          case 'page-error':
            log?.warn({ page: message.pageNumber, raw: message.message }, 'a page raised an error');
            ledger.fail(message.pageNumber, 'error', 'the page could not be read');
            lost(message.pageNumber);
            control.watchdog(null);
            control.watchMemory(false);
            if (ledger.shouldGiveUp() || options.shouldStop()) {
              state.stopped = true;
              control.finish();
            } else {
              control.next();
            }
            break;
          case 'parsed':
            ledger.abandon();
            control.finish();
            break;
          case 'failure':
            outcome.failure = workerFailure(context, message);
            control.finish();
            break;
          default:
            break;
        }
      },
    });
    await writes;
    const failedWrite = writeError();
    if (failedWrite !== null) throw failedWrite;
    if (end.kind === 'aborted') throw abortError(options.signal);
    if (outcome.failure !== null) throw outcome.failure;
    if (ledger.shouldGiveUp()) throw gaveUp(ledger);
    if (isStopped() || isDone()) break;
    if (end.kind === 'finished') {
      // A thread that ends by itself has read everything it was given: pages left mean it ended early.
      for (const page of [...ledger.remaining]) {
        ledger.fail(page, 'crash', 'the worker stopped unexpectedly');
        lost(page);
      }
      ledger.abandon();
      break;
    }
    if (!isOpened()) {
      throw new AppError(
        'PDF_UNREADABLE',
        UNREADABLE,
        `the PDF could not be opened: ${stopDetail(end, limits)}`,
      );
    }
    // The thread died or ran out of time or memory on a page: that page is lost, a fresh thread goes on after it.
    const page = ledger.lose(stopReason(end), stopDetail(end, limits));
    if (page !== null) {
      log?.warn({ page, reason: end.kind }, 'a page could not be extracted');
      lost(page);
      if (ledger.shouldGiveUp()) {
        await writes;
        throw gaveUp(ledger);
      }
      if (options.shouldStop()) state.stopped = true;
    }
  }
  await writes;
  const lastFailedWrite = writeError();
  if (lastFailedWrite !== null) throw lastFailedWrite;
  return { extracted, nextPage: ledger.remaining[0] ?? options.pageCount + 1 };
}

const gaveUp = (ledger: PageLedger<SerializedPage>): AppError =>
  new AppError(
    'PDF_UNREADABLE',
    UNREADABLE,
    `${String(ledger.consecutiveFailures)} pages in a row could not be read (the last was page ${String(ledger.lastFailedPage)})`,
  );

function failureOf(ledger: PageLedger<SerializedPage>, pageNumber: number): PageFailure {
  const failure = ledger.failures.find((candidate) => candidate.pageNumber === pageNumber);
  return failure ?? { pageNumber, reason: 'error', message: 'the page could not be read' };
}
