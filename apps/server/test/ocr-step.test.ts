import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Config } from '../src/config.js';
import type { Db } from '../src/db/client.js';
import { documentsRepo } from '../src/db/repositories/documents.js';
import { ingestJobsRepo } from '../src/db/repositories/ingest-jobs.js';
import { stageDataRepo } from '../src/db/repositories/ingest-stage.js';
import { DAILY_QUOTA_DETAIL, KEY_REJECTED_DETAIL, NO_QUOTA_DETAIL } from '../src/gemini/index.js';
import { STAGE_OCR, readCursor, type OcrCursor } from '../src/ingest/cursor.js';
import { TickContext, type TickDeps } from '../src/ingest/tick/context.js';
import { ocrStep } from '../src/ingest/tick/step-ocr.js';
import type { OcrRun } from '../src/ingest/worker/host-ocr.js';
import type { OcrPageResult } from '../src/ingest/worker/protocol.js';
import { GeminiBudgets } from '../src/limits/gemini-budget.js';
import { OCR_BUDGET_DETAIL, OCR_SERVICE_DETAIL } from '../src/ocr/types.js';
import {
  createMigratedPgliteTestDb,
  insertSession,
  resetCounters,
  testConfig,
  type TestDb,
} from './helpers.js';

/*
 * The OCR stage of a tick: what it does with what the OCR worker reports, over several ticks. The worker is a script (the
 * threads and the engines are tested elsewhere); the database is real.
 */

let test: TestDb;
let db: Db;

beforeAll(async () => {
  test = await createMigratedPgliteTestDb();
  db = test.db;
});
afterAll(async () => {
  await test.dispose();
});
beforeEach(async () => {
  await db.query('DELETE FROM documents');
  await resetCounters(db);
});

const emptyRun: OcrRun = {
  results: [],
  failures: [],
  unavailable: false,
  languages: null,
  quotaReached: false,
  configFault: null,
  requests: null,
};

const readPage = (pageNumber: number): OcrPageResult => ({
  pageNumber,
  confidence: null,
  languages: [],
  text: {
    confidence: null,
    text: `Page ${String(pageNumber)} as the model read it.`,
    blocks: [],
    charCount: 30,
    fontStats: { bodyFontSize: 10, medianLeading: 12, sizes: [], fontNames: [] },
    quality: {
      rawChars: 30,
      unmappedChars: 0,
      unmappedRatio: 0,
      garbageRatio: 0,
      mojibakeRatio: 0,
      sandwichedAscii: 0,
      arabicLetterShare: 0,
      scriptScatter: false,
      arabicFontNames: false,
    },
  },
});

interface Harness {
  ctx: TickContext;
  calls: number[][];
  /** What the worker was asked for, call by call (the pages and the time the call was given). */
  requests: { pages: number[]; budgetMs: number | undefined }[];
  cursor: () => Promise<OcrCursor>;
  documentId: string;
  /** How many times the file was read (from the store, in a real tick). */
  loads: { count: number };
  /** The job after it was parked and the quota is back: a new tick (a new lease) on the cursor as it was saved. */
  resume: () => Promise<TickContext>;
}

/** A tick on a document whose pages 1..pages all need OCR, with `runs` as what the OCR worker answers, call after call. */
async function harness(options: {
  pages: number;
  /** What the worker answers, call after call; an Error is a call that fails. */
  runs: (OcrRun | Error)[];
  env?: Record<string, string>;
  spentMs?: number;
  /** Pages OCR had read in earlier ticks. */
  read?: number[];
  budgets?: GeminiBudgets;
  /** Settings that have no environment variable or that the configuration would refuse (a hard limit under 8 s with OCR on). */
  overrides?: Partial<Config>;
  /** How long reading the file takes (a store that is slow but answers). */
  readMs?: number;
}): Promise<Harness> {
  const config = testConfig(
    { OCR_PROVIDER: 'gemini', GEMINI_API_KEY: 'k', ...options.env },
    options.overrides,
  );
  const sessionId = await insertSession(db);
  const id = randomUUID();
  await documentsRepo.insert(db, {
    id,
    sessionId,
    filename: 'scan.pdf',
    byteSize: 1,
    sha256: 'x',
    pageCount: options.pages,
    storageKey: `${id}.pdf`,
    expiresAt: new Date(Date.now() + 3_600_000),
  });
  await ingestJobsRepo.create(db, id);
  const taken = await ingestJobsRepo.acquire(db, id, { leaseMs: 60_000, concurrency: 5 });
  if (taken.kind !== 'acquired') throw new Error('not acquired');
  const cursor = readCursor({});
  cursor.ocr = {
    pages: Array.from({ length: options.pages }, (_, i) => i + 1),
    skipped: [],
    read: options.read ?? [],
    failed: [],
    languageSample: '',
    spentMs: options.spentMs ?? 0,
    unavailable: false,
  };
  const calls: number[][] = [];
  const requests: Harness['requests'] = [];
  const loads = { count: 0 };
  const runs = [...options.runs];
  const deps = {
    db,
    config,
    budgets: options.budgets ?? new GeminiBudgets(db, { llm: 0, embed: 0, ocr: 0, aux: 0 }),
    ocr: { isAvailable: () => Promise.resolve(true), peek: () => true },
    bytes: {
      load: () => {
        loads.count += 1;
        return new Promise<Uint8Array>((resolve) => {
          setTimeout(() => {
            resolve(new Uint8Array(1));
          }, options.readMs ?? 0);
        });
      },
      forget: () => Promise.resolve(),
    },
    workers: {
      ocr: (_bytes: Uint8Array, request: { pages: number[]; budgetMs?: number }) => {
        calls.push(request.pages);
        requests.push({ pages: request.pages, budgetMs: request.budgetMs });
        const next = runs.shift() ?? emptyRun;
        // A call that fails takes a moment, so that the time it took can be told from none.
        return next instanceof Error
          ? new Promise<never>((_resolve, reject) => setTimeout(() => reject(next), 40))
          : Promise.resolve(next);
      },
    },
    log: { info: () => undefined, warn: () => undefined, error: () => undefined },
  } as unknown as TickDeps;
  const ctx = new TickContext(
    deps,
    (await documentsRepo.findById(db, id))!,
    'ocr',
    cursor,
    taken.lease,
    new AbortController().signal,
  );
  return {
    ctx,
    calls,
    requests,
    loads,
    documentId: id,
    cursor: async () => readCursor((await ingestJobsRepo.find(db, id))?.cursor).ocr!,
    resume: async () => {
      await db.query('UPDATE ingest_jobs SET parked_until = NULL WHERE document_id = $1', [id]);
      const again = await ingestJobsRepo.acquire(db, id, { leaseMs: 60_000, concurrency: 5 });
      if (again.kind !== 'acquired') throw new Error('not acquired again');
      return new TickContext(
        deps,
        (await documentsRepo.findById(db, id))!,
        again.job.stage,
        readCursor(again.job.cursor),
        again.lease,
        new AbortController().signal,
      );
    },
  };
}

describe('the OCR stage of a tick', () => {
  it('reads a batch of pages, stores what was read, and counts the pages done', async () => {
    const h = await harness({
      pages: 5,
      runs: [{ ...emptyRun, results: [readPage(1), readPage(2), readPage(3)] }],
      env: { OCR_PAGES_PER_REQUEST: '2' }, // two requests of two pages a call
    });
    const result = await ocrStep(h.ctx);
    expect(result).toEqual({ kind: 'again' });
    expect(h.calls).toEqual([[1, 2, 3, 4]]);
    const saved = await h.cursor();
    expect(saved.read).toEqual([1, 2, 3]);
    expect(saved.failed).toEqual([]); // page 4 got no answer at all: it is asked for again by the next call
    expect((await stageDataRepo.all(db, h.documentId, STAGE_OCR)).map((entry) => entry.item)).toEqual([
      1, 2, 3,
    ]);
    expect(await documentsRepo.findById(db, h.documentId)).toMatchObject({
      stage: 'ocr',
      progress_completed: 3,
      progress_total: 5,
      progress_unit: 'pages',
    });
  });

  it('moves on to the analysis when every page is settled', async () => {
    const h = await harness({ pages: 2, runs: [{ ...emptyRun, results: [readPage(1), readPage(2)] }] });
    await ocrStep(h.ctx);
    await ocrStep(h.ctx);
    expect(h.ctx.stage).toBe('analyzing');
    expect(h.calls).toHaveLength(1);
  });

  it('keeps the reason when the time allowed for OCR is spent over several ticks: the pages left say so, and nothing is asked for', async () => {
    const h = await harness({ pages: 3, runs: [], spentMs: 10 * 60_000, env: { OCR_MAX_SECONDS: '600' } });
    await ocrStep(h.ctx); // the budget is used up: every page is left, with the reason
    expect(h.calls).toEqual([]);
    expect((await h.cursor()).failed).toEqual(
      [1, 2, 3].map((pageNumber) => ({ pageNumber, detail: OCR_BUDGET_DETAIL })),
    );
    await ocrStep(h.ctx);
    expect(h.ctx.stage).toBe('analyzing');
  });

  it('ends OCR for the document when the model service refuses the configuration: what is left says why, and no later call asks again', async () => {
    const h = await harness({
      pages: 6,
      runs: [
        {
          ...emptyRun,
          failures: [1, 2, 3, 4].map((pageNumber) => ({
            pageNumber,
            reason: 'config' as const,
            message: KEY_REJECTED_DETAIL,
          })),
          configFault: KEY_REJECTED_DETAIL,
        },
      ],
      env: { OCR_PAGES_PER_REQUEST: '2' },
    });
    await ocrStep(h.ctx);
    const saved = await h.cursor();
    expect(saved.read).toEqual([]);
    // The four pages of the call and the two that were not yet asked about: all left for the same reason.
    expect(saved.failed).toEqual(
      [1, 2, 3, 4, 5, 6].map((pageNumber) => ({ pageNumber, detail: KEY_REJECTED_DETAIL })),
    );
    await ocrStep(h.ctx);
    expect(h.calls).toHaveLength(1);
    expect(h.ctx.stage).toBe('analyzing');
  });

  it('parks the job in the OCR stage when the daily quota of the service runs out, keeping what was read and asking for the rest after the reset', async () => {
    const h = await harness({
      pages: 6,
      runs: [
        {
          ...emptyRun,
          results: [readPage(1), readPage(2)],
          failures: [3, 4].map((pageNumber) => ({
            pageNumber,
            reason: 'quota' as const,
            message: DAILY_QUOTA_DETAIL,
          })),
          quotaReached: true,
        },
        { ...emptyRun, results: [3, 4, 5, 6].map(readPage) },
      ],
      env: { OCR_PAGES_PER_REQUEST: '2' },
    });
    expect(await ocrStep(h.ctx)).toEqual({ kind: 'parked' });
    // What was read is kept; the pages the quota refused are NOT recorded as lost: they are still to be read.
    const saved = await h.cursor();
    expect(saved.read).toEqual([1, 2]);
    expect(saved.failed).toEqual([]);
    expect((await stageDataRepo.all(db, h.documentId, STAGE_OCR)).map((entry) => entry.item)).toEqual([1, 2]);
    const job = await ingestJobsRepo.find(db, h.documentId);
    expect(job).toMatchObject({ stage: 'ocr', lease_id: null, last_error: DAILY_QUOTA_DETAIL });
    expect(job?.parked_until?.getTime()).toBeGreaterThan(Date.now());
    expect(await documentsRepo.findById(db, h.documentId)).toMatchObject({
      status: 'processing',
      stage: 'ocr',
      progress_completed: 2,
      progress_total: 6,
      progress_detail: DAILY_QUOTA_DETAIL,
    });

    // The quota is back: the next tick asks for the pages that are left, and only those, and the stage ends.
    const resumed = await h.resume();
    expect(await ocrStep(resumed)).toEqual({ kind: 'again' });
    expect(h.calls).toEqual([
      [1, 2, 3, 4], // two requests of two pages a call
      [3, 4, 5, 6], // after the reset: the pages the quota refused, and the ones that were not reached
    ]);
    expect((await h.cursor()).read).toEqual([1, 2, 3, 4, 5, 6]);
    await ocrStep(resumed);
    expect(resumed.stage).toBe('analyzing');
  });

  it('parks a scan of which nothing could be read before the quota ended, instead of failing it', async () => {
    const h = await harness({
      pages: 3,
      runs: [
        {
          ...emptyRun,
          failures: [1, 2, 3].map((pageNumber) => ({
            pageNumber,
            reason: 'quota' as const,
            message: DAILY_QUOTA_DETAIL,
          })),
          quotaReached: true,
        },
      ],
    });
    expect(await ocrStep(h.ctx)).toEqual({ kind: 'parked' });
    expect((await h.cursor()).failed).toEqual([]);
  });

  it('lets a document go with the few pages the quota left when it has read nearly all of them (OCR_PARTIAL)', async () => {
    const h = await harness({
      pages: 10,
      runs: [
        {
          ...emptyRun,
          results: [1, 2, 3, 4, 5, 6, 7, 8, 9].map(readPage),
          failures: [{ pageNumber: 10, reason: 'quota' as const, message: DAILY_QUOTA_DETAIL }],
          quotaReached: true,
        },
      ],
    });
    expect(await ocrStep(h.ctx)).toEqual({ kind: 'again' });
    const saved = await h.cursor();
    expect(saved.read).toHaveLength(9);
    expect(saved.failed).toEqual([{ pageNumber: 10, detail: DAILY_QUOTA_DETAIL }]);
    await ocrStep(h.ctx);
    expect(h.ctx.stage).toBe('analyzing');
  });

  it('parks when the app’s own budget for the day is spent, before anything is sent', async () => {
    const budgets = new GeminiBudgets(db, { llm: 0, embed: 0, ocr: 1, aux: 0 });
    await budgets.require('ocr'); // today's single request is gone
    const h = await harness({ pages: 3, runs: [], budgets });
    expect(await ocrStep(h.ctx)).toEqual({ kind: 'parked' });
    expect(h.calls).toEqual([]);
    expect((await h.cursor()).failed).toEqual([]);
    expect((await ingestJobsRepo.find(db, h.documentId))?.parked_until).not.toBeNull();
  });

  it('lets the last page go when the app’s budget is spent and nearly everything was read', async () => {
    const budgets = new GeminiBudgets(db, { llm: 0, embed: 0, ocr: 1, aux: 0 });
    await budgets.require('ocr');
    const h = await harness({ pages: 10, runs: [], budgets, read: [1, 2, 3, 4, 5, 6, 7, 8, 9] });
    expect(await ocrStep(h.ctx)).toEqual({ kind: 'again' });
    expect(h.calls).toEqual([]);
    expect((await h.cursor()).failed).toEqual([{ pageNumber: 10, detail: DAILY_QUOTA_DETAIL }]);
  });

  it('counts the requests of a call against the OCR budget (a request is eight pages), as many as the worker says it sent', async () => {
    const budgets = new GeminiBudgets(db, { llm: 0, embed: 0, ocr: 100, aux: 0 });
    const used = async (): Promise<number> =>
      (await db.query<{ count: number }>(`SELECT count FROM rate_counters WHERE key = 'gemini:ocr'`)).rows[0]
        ?.count ?? 0;
    const read16 = Array.from({ length: 16 }, (_, i) => readPage(i + 1));

    // As reserved: two requests for sixteen pages.
    const exact = await harness({
      pages: 20,
      runs: [{ ...emptyRun, results: read16, requests: 2 }],
      budgets,
    });
    await ocrStep(exact.ctx);
    expect(exact.calls[0]).toHaveLength(16);
    expect(await used()).toBe(2);

    // Garbled answers: every page of both batches was asked for again alone, eighteen requests in all. The count follows.
    const garbled = await harness({
      pages: 20,
      runs: [{ ...emptyRun, results: read16, requests: 18 }],
      budgets,
    });
    await ocrStep(garbled.ctx);
    expect(await used()).toBe(2 + 18);

    // Fewer than reserved (a batch that never left): the rest is given back.
    const fewer = await harness({
      pages: 20,
      runs: [{ ...emptyRun, results: read16, requests: 1 }],
      budgets,
    });
    await ocrStep(fewer.ctx);
    expect(await used()).toBe(2 + 18 + 1);

    // A worker that did not count (an engine without requests): what was reserved stands.
    const uncounted = await harness({ pages: 20, runs: [{ ...emptyRun, results: read16 }], budgets });
    await ocrStep(uncounted.ctx);
    expect(await used()).toBe(2 + 18 + 1 + 2);
  });

  it('bounds a call by what is left of the tick, and leaves the pages the tick’s clock stopped for the next tick', async () => {
    const h = await harness({
      pages: 4,
      runs: [
        {
          ...emptyRun,
          results: [readPage(1)],
          failures: [2, 3, 4].map((pageNumber) => ({
            pageNumber,
            reason: 'budget' as const,
            message: 'the time allowed for OCR on this document was used up',
          })),
        },
      ],
      // A hard limit of 12 s less the 5 s margin: a call may take about seven seconds, whatever OCR_MAX_SECONDS says (600).
      env: { INGEST_TICK_HARD_LIMIT_MS: '12000', INGEST_TICK_BUDGET_MS: '1000' },
    });
    await ocrStep(h.ctx);
    const budget = h.requests[0]?.budgetMs ?? 0;
    expect(budget).toBeGreaterThan(5000);
    expect(budget).toBeLessThanOrEqual(7000);
    const saved = await h.cursor();
    expect(saved.read).toEqual([1]);
    expect(saved.failed).toEqual([]); // not lost: the next tick asks for 2, 3 and 4
    expect(saved.spentMs).toBeGreaterThanOrEqual(0);
  });

  it('sizes the call after the file was read: a store that is slow but answers takes its time out of the call, and the tick is not overrun', async () => {
    const h = await harness({
      pages: 4,
      runs: [{ ...emptyRun, results: [readPage(1)] }],
      env: { INGEST_TICK_HARD_LIMIT_MS: '12000', INGEST_TICK_BUDGET_MS: '1000' },
      readMs: 2500,
    });
    await ocrStep(h.ctx);
    // 12 s less the 5 s margin less the 2.5 s the read took: 4.5 s (asked for in whole seconds: 5), not the 7 s a call sized
    // before the read would have had.
    const budget = h.requests[0]?.budgetMs ?? 0;
    expect(budget).toBeGreaterThan(3000);
    expect(budget).toBeLessThanOrEqual(5000);
  });

  it('does not read the file when the tick has no time for a call anyway, and waits when the read left none', async () => {
    const none = await harness({
      pages: 4,
      runs: [],
      env: { INGEST_TICK_BUDGET_MS: '1000' },
      overrides: { ingestTickHardLimitMs: 5000 },
    });
    expect(await ocrStep(none.ctx)).toMatchObject({ kind: 'wait' });
    expect(none.loads.count).toBe(0); // a read of the store costs the day's budget: not for nothing
    // 8.5 s of hard limit leave 3.5 s: enough for a call, until a read of one second takes it below the 3 s a call needs.
    const slow = await harness({
      pages: 4,
      runs: [],
      env: { INGEST_TICK_BUDGET_MS: '1000' },
      overrides: { ingestTickHardLimitMs: 8500 },
      readMs: 1000,
    });
    expect(await ocrStep(slow.ctx)).toMatchObject({ kind: 'wait' });
    expect(slow.loads.count).toBe(1);
    expect(slow.calls).toEqual([]);
  });

  it('records the pages the document’s own OCR time stopped (OCR_MAX_SECONDS), when that is what limits the call', async () => {
    const h = await harness({
      pages: 4,
      runs: [
        {
          ...emptyRun,
          results: [readPage(1)],
          failures: [2, 3, 4].map((pageNumber) => ({
            pageNumber,
            reason: 'budget' as const,
            message: 'the time allowed for OCR on this document was used up',
          })),
        },
      ],
      env: { OCR_MAX_SECONDS: '5' },
    });
    await ocrStep(h.ctx);
    expect(h.requests[0]?.budgetMs).toBe(5000);
    expect((await h.cursor()).failed).toEqual(
      [2, 3, 4].map((pageNumber) => ({ pageNumber, detail: OCR_BUDGET_DETAIL })),
    );
  });

  it('starts no call when the tick has no time left for one, and takes nothing from the budget', async () => {
    const budgets = new GeminiBudgets(db, { llm: 0, embed: 0, ocr: 100, aux: 0 });
    const h = await harness({
      pages: 4,
      runs: [],
      budgets,
      // (Under the least the configuration allows: that is refused as a setting, and checked below.)
      env: { INGEST_TICK_BUDGET_MS: '1000' },
      overrides: { ingestTickHardLimitMs: 5000 },
    });
    expect(await ocrStep(h.ctx)).toMatchObject({ kind: 'wait' });
    expect(h.calls).toEqual([]);
    expect(await budgets.used('ocr')).toBe(0);
  });

  it('counts the time of a call that failed or was stopped as the document’s OCR time', async () => {
    const h = await harness({ pages: 4, runs: [new Error('stopped')] });
    await expect(ocrStep(h.ctx)).rejects.toThrow('stopped');
    expect(h.ctx.cursor.ocr?.spentMs).toBeGreaterThanOrEqual(30);
    expect(h.ctx.cursor.ocr?.read).toEqual([]);
  });

  it('leaves a single page the service did not answer for, and goes on with the others', async () => {
    const h = await harness({
      pages: 4,
      runs: [
        {
          ...emptyRun,
          results: [readPage(1), readPage(3), readPage(4)],
          failures: [{ pageNumber: 2, reason: 'service', message: OCR_SERVICE_DETAIL }],
        },
      ],
    });
    await ocrStep(h.ctx);
    const saved = await h.cursor();
    expect(saved.read).toEqual([1, 3, 4]);
    expect(saved.failed).toEqual([{ pageNumber: 2, detail: OCR_SERVICE_DETAIL }]);
    await ocrStep(h.ctx);
    expect(h.ctx.stage).toBe('analyzing');
  });

  it('waits for a service that did not answer for any page of a call, longer each time, and gives it up for the document only after three calls in a row', async () => {
    const silent: OcrRun = {
      ...emptyRun,
      failures: [1, 2, 3, 4].map((pageNumber) => ({
        pageNumber,
        reason: 'service' as const,
        message: OCR_SERVICE_DETAIL,
      })),
    };
    const h = await harness({
      pages: 6,
      runs: [silent, silent, silent],
      env: { OCR_PAGES_PER_REQUEST: '2' },
    });
    // A few minutes of trouble at the service must not end the OCR of the document after one call: the pages stay unread.
    expect(await ocrStep(h.ctx)).toEqual({ kind: 'wait', retryAfterMs: 3000 });
    expect((await h.cursor()).failed).toEqual([]);
    expect(await ocrStep(h.ctx)).toEqual({ kind: 'wait', retryAfterMs: 9000 });
    expect((await h.cursor()).failed).toEqual([]);
    expect((await h.cursor()).silentCalls).toBe(2);
    // The third: it is not there for this document, and the pages left say so.
    expect(await ocrStep(h.ctx)).toEqual({ kind: 'again' });
    expect((await h.cursor()).failed).toEqual(
      [1, 2, 3, 4, 5, 6].map((pageNumber) => ({ pageNumber, detail: OCR_SERVICE_DETAIL })),
    );
    expect(h.calls).toHaveLength(3);
  });

  it('forgets the calls the service did not answer to as soon as it answers for a page', async () => {
    const silent: OcrRun = {
      ...emptyRun,
      failures: [1, 2, 3, 4].map((pageNumber) => ({
        pageNumber,
        reason: 'service' as const,
        message: OCR_SERVICE_DETAIL,
      })),
    };
    const h = await harness({
      pages: 8,
      runs: [silent, silent, { ...emptyRun, results: [1, 2, 3, 4].map(readPage) }, silent, silent],
      env: { OCR_PAGES_PER_REQUEST: '2' },
    });
    await ocrStep(h.ctx);
    await ocrStep(h.ctx);
    expect((await h.cursor()).silentCalls).toBe(2);
    await ocrStep(h.ctx); // answered: pages 1-4 read
    expect((await h.cursor()).silentCalls).toBe(0);
    // Two more silent calls do not reach three in a row.
    await ocrStep(h.ctx);
    await ocrStep(h.ctx);
    const saved = await h.cursor();
    expect(saved.silentCalls).toBe(2);
    expect(saved.failed).toEqual([]);
  });

  it('ends OCR for the document at once when the model has no quota at all on this plan (a fault of the configuration, never a wait)', async () => {
    const h = await harness({
      pages: 6,
      runs: [
        {
          ...emptyRun,
          failures: [1, 2, 3, 4].map((pageNumber) => ({
            pageNumber,
            reason: 'config' as const,
            message: NO_QUOTA_DETAIL,
          })),
          configFault: NO_QUOTA_DETAIL,
        },
      ],
      env: { OCR_PAGES_PER_REQUEST: '2' },
    });
    await ocrStep(h.ctx);
    expect((await h.cursor()).failed).toEqual(
      [1, 2, 3, 4, 5, 6].map((pageNumber) => ({ pageNumber, detail: NO_QUOTA_DETAIL })),
    );
    expect(h.calls).toHaveLength(1);
  });

  it('marks the engine unavailable when it did not start, and the stage ends', async () => {
    const h = await harness({ pages: 2, runs: [{ ...emptyRun, unavailable: true }] });
    await ocrStep(h.ctx);
    expect((await h.cursor()).unavailable).toBe(true);
    await ocrStep(h.ctx);
    expect(h.ctx.stage).toBe('analyzing');
  });
});
