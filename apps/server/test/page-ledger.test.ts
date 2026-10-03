import { describe, expect, it } from 'vitest';
import { MAX_CONSECUTIVE_PAGE_FAILURES, PageLedger } from '../src/ingest/worker/ledger.js';

/** The bookkeeping of pages read over restartable threads: who is blamed when a thread dies, when to give up. */
describe('PageLedger', () => {
  const ledger = (pages: number[], maxStops?: number) => {
    const progress: number[] = [];
    const made = new PageLedger<string>(
      pages,
      () => progress.push(made.settled),
      maxStops === undefined ? {} : { maxStops },
    );
    return { ledger: made, progress };
  };

  it('settles every page once: a result is never overwritten by a failure, nor a failure recorded twice', () => {
    const { ledger: l, progress } = ledger([1, 2, 3]);
    l.begin(1);
    l.complete(1, 'one');
    l.fail(1, 'crash', 'late'); // a thread that died after reporting page 1
    l.fail(2, 'error', 'first');
    l.fail(2, 'timeout', 'second');
    l.complete(2, 'too late');
    expect([...l.results.keys()]).toEqual([1]);
    expect(l.failures).toEqual([{ pageNumber: 2, reason: 'error', message: 'first' }]);
    expect(l.remaining).toEqual([3]);
    expect(progress).toEqual([1, 2]); // each page counted once, never past the total
  });

  it('blames the page in flight when a thread dies, and only that page', () => {
    const { ledger: l } = ledger([1, 2, 3]);
    l.begin(1);
    l.complete(1, 'one');
    l.begin(2);
    expect(l.lose('timeout', 'it took too long')).toBe(2);
    expect(l.failures.map((f) => f.pageNumber)).toEqual([2]);
    expect(l.remaining).toEqual([3]);
  });

  it('blames the next page in line when a thread dies between pages (nothing is in flight), never the page it reported', () => {
    const { ledger: l } = ledger([1, 2, 3]);
    l.begin(1);
    l.complete(1, 'one'); // the thread dies now, before it starts page 2
    expect(l.lose('crash', 'the worker stopped unexpectedly')).toBe(2);
    expect([...l.results.keys()]).toEqual([1]);
    expect(l.failures.map((f) => f.pageNumber)).toEqual([2]);
  });

  it('blames nobody when a thread dies after the last page was reported: the job is complete', () => {
    const { ledger: l } = ledger([1]);
    l.begin(1);
    l.complete(1, 'one');
    expect(l.done).toBe(true);
    expect(l.lose('crash', 'the worker stopped unexpectedly')).toBeNull();
    expect(l.failures).toEqual([]);
  });

  it('keeps a page pending when pages after it settle first (a batch: the page the answer left out is asked for again last)', () => {
    const { ledger: l, progress } = ledger([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    l.begin(1);
    for (const page of [2, 3, 4, 5, 6, 7, 8]) l.complete(page, `page ${String(page)}`);
    expect(l.remaining).toEqual([1, 9, 10]); // page 1 is still owed an outcome
    // its single retry hits the quota: the run is over, and every page that is left, page 1 included, fails with it
    l.failRemaining('quota', 'daily quota reached');
    expect(l.done).toBe(true);
    expect(l.failures.map((f) => [f.pageNumber, f.reason])).toEqual([
      [1, 'quota'],
      [9, 'quota'],
      [10, 'quota'],
    ]);
    expect(l.settled).toBe(10); // every requested page settled exactly once
    expect(progress.at(-1)).toBe(10);
  });

  it('settles every requested page exactly once, whatever the order the pages are reported in', () => {
    const { ledger: l } = ledger([1, 2, 3, 4, 5]);
    for (const page of [3, 5, 1, 4]) l.complete(page, 'read');
    l.complete(3, 'again');
    l.fail(5, 'error', 'late');
    l.fail(2, 'error', 'unread');
    expect(l.settled).toBe(5);
    expect(l.done).toBe(true);
    expect([...l.results.keys()].sort()).toEqual([1, 3, 4, 5]);
    expect(l.failures.map((f) => f.pageNumber)).toEqual([2]);
  });

  it('counts a request that failed for several pages once toward the limit, not once per page', () => {
    const { ledger: l } = ledger([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    l.failRequest([1, 2, 3, 4, 5, 6, 7, 8], 'service', 'the model service was not available');
    expect(l.failures).toHaveLength(8);
    expect(l.failures.every((f) => f.reason === 'service')).toBe(true);
    expect(l.consecutiveFailures).toBe(1);
    expect(l.shouldGiveUp()).toBe(false);
    expect(l.remaining).toEqual([9, 10]);
    expect(l.lastFailureReason).toBe('service');
    // a request that settles pages that are already settled counts for nothing
    l.failRequest([1, 2], 'service', 'again');
    expect(l.consecutiveFailures).toBe(1);
    // five requests in a row do end it
    for (const page of [9, 10]) l.failRequest([page], 'service', 'x');
    expect(l.consecutiveFailures).toBe(3);
  });

  it('starts the count again when a page is read after a failed request, and ends it after five failed requests in a row', () => {
    const { ledger: l } = ledger(Array.from({ length: 12 }, (_, i) => i + 1));
    l.failRequest([1, 2], 'service', 'x');
    l.complete(3, 'read');
    expect(l.consecutiveFailures).toBe(0);
    for (const pages of [[4, 5], [6, 7], [8, 9], [10], [11]]) l.failRequest(pages, 'service', 'x');
    expect(l.consecutiveFailures).toBe(5);
    expect(l.shouldGiveUp()).toBe(true);
  });

  it('gives up after five failures in a row, but a page read in between starts the count again', () => {
    expect(MAX_CONSECUTIVE_PAGE_FAILURES).toBe(5);
    const { ledger: l } = ledger([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    for (const page of [1, 2, 3, 4]) l.fail(page, 'error', 'x');
    expect(l.shouldGiveUp()).toBe(false);
    l.complete(5, 'five');
    for (const page of [6, 7, 8, 9]) l.fail(page, 'error', 'x');
    expect(l.shouldGiveUp()).toBe(false);
    // Eight pages have failed in all, but never five in a row until now: 6, 7, 8, 9 and 10.
    l.fail(10, 'error', 'x');
    expect(l.shouldGiveUp()).toBe(true);
  });

  it('counts pages stopped by the time or memory limits in all, whatever was read between them', () => {
    const { ledger: l } = ledger([1, 2, 3, 4, 5, 6], 3);
    l.fail(1, 'timeout', 'x');
    l.complete(2, 'two');
    l.fail(3, 'memory', 'x');
    l.complete(4, 'four');
    expect(l.shouldGiveUp()).toBe(false);
    l.fail(5, 'timeout', 'x');
    expect(l.stoppedPages).toBe(3);
    expect(l.shouldGiveUp()).toBe(true);
    // Other failures (a thrown page) do not count towards it.
    const { ledger: other } = ledger([1, 2, 3, 4, 5, 6], 3);
    for (const page of [1, 2, 3]) other.fail(page, 'error', 'x');
    other.complete(4, 'four');
    expect(other.shouldGiveUp()).toBe(false);
  });

  it('knows the pages only once told, and only the first telling counts', () => {
    const l = new PageLedger<string>(null);
    expect(l.unknown).toBe(true);
    expect(l.done).toBe(false);
    l.setPages([1, 2]);
    l.setPages([1, 2, 3]); // a restarted thread reports the same document
    expect(l.remaining).toEqual([1, 2]);
  });

  it('fails what remains, or abandons it without a record', () => {
    const { ledger: l } = ledger([1, 2, 3, 4]);
    l.complete(1, 'one');
    l.failRemaining('budget', 'out of time');
    expect(l.failures.map((f) => [f.pageNumber, f.reason])).toEqual([
      [2, 'budget'],
      [3, 'budget'],
      [4, 'budget'],
    ]);
    expect(l.done).toBe(true);
    const { ledger: gone } = ledger([1, 2]);
    gone.abandon();
    expect(gone.done).toBe(true);
    expect(gone.failures).toEqual([]);
    expect(gone.settled).toBe(0);
  });
});
