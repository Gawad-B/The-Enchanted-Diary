import type { Abnormal, ThreadEnd } from './thread.js';
import { stopReason } from './thread.js';

/*
 * The bookkeeping of a job that reads pages over restartable threads (text extraction and OCR do exactly this): which
 * pages are read, which failed and why, which one a thread was working on, when to give up. One place, so that the two
 * cannot disagree about it. The rules it enforces:
 *  - a page is settled once: a result is never overwritten by a failure, and a failure is recorded once;
 *  - the page "in flight" is the one that has started and not yet reported; when a thread dies, that page is the one
 *    lost, or, if none is in flight (the thread died between pages or while opening), the next page in line. If no
 *    page remains there is nobody to blame and nothing is recorded;
 *  - progress counts every settled page exactly once.
 */

/** Pages that fail one after the other before the whole document is given up on. */
export const MAX_CONSECUTIVE_PAGE_FAILURES = 5;

export interface PageFailure {
  pageNumber: number;
  /**
   * `quota`: the model service's daily quota ran out; `service`: the model service could not answer (busy, down); `config`:
   * the service refused the key, does not know the model or refuses every request (its `message` says which): none of
   * them is the page's fault, none is "damaged", and `budget` (the time allowed for OCR ran out) is not either.
   */
  reason: 'timeout' | 'memory' | 'crash' | 'error' | 'budget' | 'quota' | 'service' | 'config';
  message: string;
}

export interface LedgerOptions {
  /** Give up after this many pages lost to a timeout or the memory watchdog in all (consecutive or not). */
  maxStops?: number;
}

export class PageLedger<R> {
  readonly results = new Map<number, R>();
  readonly failures: PageFailure[] = [];
  private pending: number[] | null;
  private inFlight: number | null = null;
  private consecutive = 0;
  private stops = 0;
  private lastFailed = 0;
  private lastFailure: PageFailure['reason'] | null = null;

  /** `pages` null: the page count is not known yet (a document is being opened); see {@link setPages}. */
  constructor(
    pages: readonly number[] | null,
    private readonly changed: () => void = () => undefined,
    private readonly options: LedgerOptions = {},
  ) {
    this.pending = pages === null ? null : [...pages];
  }

  /**
   * The run of pages lost in a row that an earlier call of a job left off with (the ledger of a job that reads over several
   * ticks starts each tick with this, so that the give-up rule holds over the whole document): the pages before the first of
   * this ledger's, `lastFailedPage` the last of them.
   */
  seedFailureRun(consecutive: number, lastFailedPage: number): void {
    this.consecutive = consecutive;
    this.lastFailed = lastFailedPage;
  }

  /** The pages are known now (1..count). Only the first call counts: a restarted thread reports the same document. */
  setPages(pages: readonly number[]): void {
    this.pending ??= [...pages];
    this.changed();
  }

  /** True while the pages are not known. */
  get unknown(): boolean {
    return this.pending === null;
  }

  /** The pages still to read, in order. */
  get remaining(): readonly number[] {
    return this.pending ?? [];
  }

  /** Every page is settled (and the pages are known). */
  get done(): boolean {
    return this.pending !== null && this.pending.length === 0;
  }

  /** Pages settled so far, read or failed. */
  get settled(): number {
    return this.results.size + this.failures.length;
  }

  get consecutiveFailures(): number {
    return this.consecutive;
  }

  get lastFailedPage(): number {
    return this.lastFailed;
  }

  /** Why the latest failure happened (null if nothing failed yet). */
  get lastFailureReason(): PageFailure['reason'] | null {
    return this.lastFailure;
  }

  /** How many pages were lost to a timeout or a memory kill. */
  get stoppedPages(): number {
    return this.stops;
  }

  /** Too many failures in a row, or too many pages stopped by the time or memory limits: stop trying. */
  shouldGiveUp(): boolean {
    return (
      this.consecutive >= MAX_CONSECUTIVE_PAGE_FAILURES ||
      (this.options.maxStops !== undefined && this.stops >= this.options.maxStops)
    );
  }

  /** The thread has started on this page. */
  begin(pageNumber: number): void {
    this.inFlight = pageNumber;
  }

  complete(pageNumber: number, result: R): void {
    if (this.isSettled(pageNumber)) return;
    this.results.set(pageNumber, result);
    this.consecutive = 0;
    this.settle(pageNumber);
  }

  fail(pageNumber: number, reason: PageFailure['reason'], message: string): void {
    if (this.isSettled(pageNumber)) return;
    this.failures.push({ pageNumber, reason, message });
    this.consecutive += 1;
    if (reason === 'timeout' || reason === 'memory') this.stops += 1;
    this.lastFailed = pageNumber;
    this.lastFailure = reason;
    this.settle(pageNumber);
  }

  /**
   * One request failed for all of `pageNumbers` (a batch the service could not answer): every page is recorded, but the
   * failure counts once toward the consecutive limit, not once per page, so that a single bad request does not end the
   * document's OCR.
   */
  failRequest(pageNumbers: readonly number[], reason: PageFailure['reason'], message: string): void {
    const unsettled = pageNumbers.filter((page) => !this.isSettled(page));
    for (const page of unsettled) {
      this.failures.push({ pageNumber: page, reason, message });
      this.lastFailed = page;
      this.settle(page);
    }
    if (unsettled.length > 0) {
      this.consecutive += 1;
      this.lastFailure = reason;
      if (reason === 'timeout' || reason === 'memory') this.stops += 1;
    }
  }

  /** The thread ended without finishing: the page it was working on, or else the next in line, is lost. */
  lose(reason: PageFailure['reason'], message: string): number | null {
    const page = this.inFlight ?? this.pending?.[0];
    if (page === undefined) return null;
    this.fail(page, reason, message);
    return page;
  }

  /** Every page not yet settled fails with this reason (the run is over). */
  failRemaining(reason: PageFailure['reason'], message: string): void {
    for (const page of [...this.remaining]) this.fail(page, reason, message);
  }

  /** The run is over without a verdict on the pages left: nothing is recorded for them. */
  abandon(): void {
    this.pending = [];
    this.inFlight = null;
  }

  private isSettled(pageNumber: number): boolean {
    return this.results.has(pageNumber) || this.failures.some((failure) => failure.pageNumber === pageNumber);
  }

  private settle(pageNumber: number): void {
    this.inFlight = null;
    // Only this page: pages are not settled in order when a batch is read (a page the answer left out is asked for again
    // after the pages after it were read), and one that is still to be settled must stay pending.
    this.pending &&= this.pending.filter((page) => page !== pageNumber);
    this.changed();
  }
}

export type DriveStatus =
  /** Every page is settled. */
  | { status: 'done' }
  /** The caller's signal (or the budget's) aborted the run. */
  | { status: 'aborted' }
  /** Too many failures: stop reading. */
  | { status: 'gave-up' }
  /** A thread died or ran out of time before it was ready (before it opened the document, or started the engine). */
  | { status: 'not-started'; end: Abnormal };

/**
 * Runs threads one after the other until the ledger is done: `run` starts a thread for the pages still to read and
 * resolves when it ends (its message handler feeds the ledger); `ready` says whether that thread got as far as being
 * ready to read (opened the document, started the engine). A thread that dies or times out while reading loses a page and
 * a fresh one continues after it; a thread that ends cleanly with pages left has stopped early and its pages fail.
 */
export async function driveThreads(
  ledger: PageLedger<unknown>,
  options: {
    run(): Promise<ThreadEnd>;
    ready(): boolean;
    /** A curated sentence about why a thread was stopped. */
    detail(end: Abnormal): string;
    /** Called when a page was lost to how a thread ended (for the log). */
    onLost?: (pageNumber: number, end: Abnormal) => void;
    /** What to say of pages a thread left behind when it ended cleanly. */
    leftBehind?: string;
  },
): Promise<DriveStatus> {
  while (!ledger.done) {
    const end = await options.run();
    if (end.kind === 'aborted') return { status: 'aborted' };
    if (ledger.shouldGiveUp()) return { status: 'gave-up' };
    if (end.kind === 'finished') {
      // A thread that ends cleanly has read everything it was given; pages left mean it ended early.
      ledger.failRemaining('crash', options.leftBehind ?? 'the worker stopped unexpectedly');
      ledger.abandon();
      return { status: 'done' };
    }
    if (!options.ready()) return { status: 'not-started', end };
    const lost = ledger.lose(stopReason(end), options.detail(end));
    if (lost !== null) options.onLost?.(lost, end);
    if (ledger.shouldGiveUp()) return { status: 'gave-up' };
  }
  return { status: 'done' };
}
