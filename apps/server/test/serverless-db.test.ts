import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '../src/db/client.js';
import { countersRepo } from '../src/db/repositories/counters.js';
import { documentsRepo, type DocumentRow } from '../src/db/repositories/documents.js';
import { ingestJobsRepo } from '../src/db/repositories/ingest-jobs.js';
import { stageDataRepo } from '../src/db/repositories/ingest-stage.js';
import { uploadTicketsRepo } from '../src/db/repositories/upload-tickets.js';
import { GeminiBudgets, budgetLimitsOf } from '../src/limits/gemini-budget.js';
import { nextQuotaReset, pacificDayStart } from '../src/limits/quota-day.js';
import { retryOnDeadlock } from '../src/db/errors.js';
import { AppError } from '../src/http/errors.js';
import { LeaseLostError, TickContext, type TickDeps } from '../src/ingest/tick/context.js';
import { failDocument } from '../src/ingest/tick/finish.js';
import { finishDocument } from '../src/ingest/tick/step-embed.js';
import {
  dbBackends,
  describeEach,
  insertSession,
  resetCounters,
  testConfig,
  type TestDb,
} from './helpers.js';

/*
 * The database half of the serverless re-platform: counters, budgets, leases. It runs on embedded PGlite always (one connection:
 * it checks the logic, not the races) and on a real PostgreSQL + pgvector as well when TEST_DATABASE_URL points at one (the
 * docker-compose service of `npm run db:up`), with a pool of twelve connections, where the races can happen: two ticks that ask
 * for a lease together, a document deleted while a tick commits.
 */
let test: TestDb;
let db: Db;

describeEach(dbBackends(), (backend) => {
  beforeAll(async () => {
    test = await backend.create();
    db = test.db;
  });
  afterAll(async () => {
    await test.dispose();
  });
  beforeEach(async () => {
    await resetCounters(db);
    await db.query('DELETE FROM ingest_jobs');
  });

  async function newDocument(): Promise<string> {
    const sessionId = await insertSession(db);
    const id = randomUUID();
    await documentsRepo.insert(db, {
      id,
      sessionId,
      filename: 'a.pdf',
      byteSize: 1,
      sha256: 'x',
      pageCount: 1,
      storageKey: `${id}.pdf`,
      expiresAt: new Date(Date.now() + 3_600_000),
    });
    await ingestJobsRepo.create(db, id);
    return id;
  }

  const MINUTE = 60_000;

  describe('countersRepo.consume', () => {
    it('allows up to the limit and refuses the rest, without counting what it refused', async () => {
      const now = new Date('2026-10-02T12:00:10Z');
      const ask = (): Promise<boolean> =>
        countersRepo.consume(db, { key: 'k', limit: 3, windowMs: MINUTE, now }).then((r) => r.allowed);
      expect([await ask(), await ask(), await ask(), await ask(), await ask()]).toEqual([
        true,
        true,
        true,
        false,
        false,
      ]);
      expect(await countersRepo.used(db, 'k', new Date('2026-10-02T12:00:00Z'))).toBe(3); // the refusals took nothing
    });

    it('says when the window ends, and starts again with the next one', async () => {
      const early = new Date('2026-10-02T12:00:10Z');
      await countersRepo.consume(db, { key: 'w', limit: 1, windowMs: MINUTE, now: early });
      const refused = await countersRepo.consume(db, { key: 'w', limit: 1, windowMs: MINUTE, now: early });
      expect(refused).toMatchObject({ allowed: false, retryAfterMs: 50_000 });
      expect(refused.resetAt.toISOString()).toBe('2026-10-02T12:01:00.000Z');
      const later = await countersRepo.consume(db, {
        key: 'w',
        limit: 1,
        windowMs: MINUTE,
        now: new Date('2026-10-02T12:01:00Z'),
      });
      expect(later.allowed).toBe(true);
    });

    it('keeps keys apart', async () => {
      const now = new Date();
      expect((await countersRepo.consume(db, { key: 'a', limit: 1, windowMs: MINUTE, now })).allowed).toBe(
        true,
      );
      expect((await countersRepo.consume(db, { key: 'b', limit: 1, windowMs: MINUTE, now })).allowed).toBe(
        true,
      );
      expect((await countersRepo.consume(db, { key: 'a', limit: 1, windowMs: MINUTE, now })).allowed).toBe(
        false,
      );
    });

    it('lets exactly `limit` of many simultaneous calls through', async () => {
      const now = new Date();
      const results = await Promise.all(
        Array.from({ length: 25 }, () =>
          countersRepo.consume(db, { key: 'race', limit: 7, windowMs: MINUTE, now }),
        ),
      );
      expect(results.filter((result) => result.allowed)).toHaveLength(7);
    });

    it('counts items, not just calls, and refuses a call bigger than the limit at once', async () => {
      const now = new Date();
      expect(
        (await countersRepo.consume(db, { key: 'items', limit: 10, windowMs: MINUTE, amount: 6, now }))
          .allowed,
      ).toBe(true);
      // 6 + 5 does not fit: nothing is taken, and the 4 that do fit are still there.
      expect(
        (await countersRepo.consume(db, { key: 'items', limit: 10, windowMs: MINUTE, amount: 5, now }))
          .allowed,
      ).toBe(false);
      expect(
        (await countersRepo.consume(db, { key: 'items', limit: 10, windowMs: MINUTE, amount: 4, now }))
          .allowed,
      ).toBe(true);
      expect(
        (await countersRepo.consume(db, { key: 'big', limit: 3, windowMs: MINUTE, amount: 4, now })).allowed,
      ).toBe(false);
      expect(await countersRepo.used(db, 'big', new Date(Math.floor(now.getTime() / MINUTE) * MINUTE))).toBe(
        0,
      );
    });

    it('removes the counters of windows long over', async () => {
      await countersRepo.consume(db, {
        key: 'old',
        limit: 1,
        windowMs: MINUTE,
        now: new Date('2026-09-01T00:00:00Z'),
      });
      await countersRepo.consume(db, {
        key: 'new',
        limit: 1,
        windowMs: MINUTE,
        now: new Date('2026-10-02T00:00:00Z'),
      });
      expect(await countersRepo.deleteOlderThan(db, new Date('2026-09-30T00:00:00Z'))).toBe(1);
      expect((await db.query('SELECT key FROM rate_counters')).rows).toEqual([{ key: 'new' }]);
    });
  });

  describe('the Pacific day of the Gemini quotas', () => {
    it('begins at midnight Pacific: 07:00 UTC in summer, 08:00 UTC in winter', () => {
      expect(pacificDayStart(new Date('2026-10-02T06:59:59Z')).toISOString()).toBe(
        '2026-10-01T07:00:00.000Z',
      );
      expect(pacificDayStart(new Date('2026-10-02T07:00:00Z')).toISOString()).toBe(
        '2026-10-02T07:00:00.000Z',
      );
      expect(pacificDayStart(new Date('2026-12-15T07:59:00Z')).toISOString()).toBe(
        '2026-12-14T08:00:00.000Z',
      );
      expect(pacificDayStart(new Date('2026-12-15T20:00:00Z')).toISOString()).toBe(
        '2026-12-15T08:00:00.000Z',
      );
    });

    it('ends at the next midnight Pacific', () => {
      expect(nextQuotaReset(new Date('2026-10-02T12:00:00Z')).toISOString()).toBe('2026-10-03T07:00:00.000Z');
      expect(nextQuotaReset(new Date('2026-12-15T12:00:00Z')).toISOString()).toBe('2026-12-16T08:00:00.000Z');
    });

    it('copes with the days that are 23 and 25 hours long', () => {
      // 8 March 2026: clocks go forward at 02:00 (midnight is 08:00 UTC, the next one 07:00 UTC).
      expect(pacificDayStart(new Date('2026-03-08T20:00:00Z')).toISOString()).toBe(
        '2026-03-08T08:00:00.000Z',
      );
      expect(nextQuotaReset(new Date('2026-03-08T20:00:00Z')).toISOString()).toBe('2026-03-09T07:00:00.000Z');
      // 1 November 2026: clocks go back (midnight is 07:00 UTC, the next one 08:00 UTC).
      expect(pacificDayStart(new Date('2026-11-01T20:00:00Z')).toISOString()).toBe(
        '2026-11-01T07:00:00.000Z',
      );
      expect(nextQuotaReset(new Date('2026-11-01T20:00:00Z')).toISOString()).toBe('2026-11-02T08:00:00.000Z');
    });
  });

  describe('GeminiBudgets', () => {
    const limits = { llm: 2, embed: 10, ocr: 1, aux: 3 };

    it('reserves up to the day’s budget of each kind and refuses beyond it', async () => {
      const budgets = new GeminiBudgets(db, limits, () => new Date('2026-10-02T12:00:00Z'));
      expect((await budgets.reserve('llm')).allowed).toBe(true);
      expect((await budgets.reserve('llm')).allowed).toBe(true);
      const refused = await budgets.reserve('llm');
      expect(refused.allowed).toBe(false);
      expect(refused.resetAt.toISOString()).toBe('2026-10-03T07:00:00.000Z');
      // The other kinds have budgets of their own; embedded texts are counted by the item.
      expect((await budgets.reserve('embed', 8)).allowed).toBe(true);
      expect((await budgets.reserve('embed', 3)).allowed).toBe(false);
      expect((await budgets.reserve('embed', 2)).allowed).toBe(true);
      expect((await budgets.reserve('ocr')).allowed).toBe(true);
      expect((await budgets.reserve('ocr')).allowed).toBe(false);
    });

    it('starts again when the Pacific day does, not at midnight UTC', async () => {
      let now = new Date('2026-10-02T06:00:00Z'); // 23:00 on 1 October in Pacific time
      const budgets = new GeminiBudgets(db, { llm: 1, embed: 1, ocr: 1, aux: 1 }, () => now);
      expect((await budgets.reserve('llm')).allowed).toBe(true);
      now = new Date('2026-10-02T06:59:00Z');
      expect((await budgets.reserve('llm')).allowed).toBe(false);
      now = new Date('2026-10-02T07:00:00Z');
      expect((await budgets.reserve('llm')).allowed).toBe(true);
    });

    it('has no limit for 0, and `require` throws the RATE_LIMITED the visitor is told about', async () => {
      const unlimited = new GeminiBudgets(db, { llm: 0, embed: 0, ocr: 0, aux: 0 });
      for (let i = 0; i < 5; i += 1) expect((await unlimited.reserve('llm')).allowed).toBe(true);
      const budgets = new GeminiBudgets(db, { llm: 1, embed: 1, ocr: 1, aux: 1 });
      await budgets.require('llm');
      await expect(budgets.require('llm')).rejects.toMatchObject({
        code: 'RATE_LIMITED',
        statusCode: 429,
        detail: 'daily quota reached',
      });
    });

    it('takes one unit of each kind or none: a refusal gives back what the earlier kinds had taken', async () => {
      const now = new Date('2026-10-02T12:00:00Z');
      const budgets = new GeminiBudgets(db, { llm: 3, embed: 1, ocr: 0, aux: 0 }, () => now);
      await budgets.requireAll(['llm', 'embed']);
      await expect(budgets.requireAll(['llm', 'embed'])).rejects.toMatchObject({ code: 'RATE_LIMITED' });
      await expect(budgets.requireAll(['llm', 'embed'])).rejects.toMatchObject({ code: 'RATE_LIMITED' });
      const day = pacificDayStart(now);
      expect(await countersRepo.used(db, 'gemini:llm', day)).toBe(1); // the two refusals returned their answer unit
      expect(await countersRepo.used(db, 'gemini:embed', day)).toBe(1);
      await budgets.refund('llm', 5); // never below 0
      expect(await countersRepo.used(db, 'gemini:llm', day)).toBe(0);
    });

    it('only budgets the kinds whose provider is Gemini', () => {
      const gemini = testConfig();
      expect(budgetLimitsOf(gemini)).toEqual({ llm: 300, embed: 800, ocr: 0, aux: 400 }); // the tests turn OCR off
      expect(budgetLimitsOf({ ...gemini, llmProvider: 'anthropic', embeddingProvider: 'openai' })).toEqual({
        llm: 0,
        embed: 0,
        ocr: 0,
        aux: 0,
      });
    });
  });

  describe('ingestJobsRepo', () => {
    const LEASE_MS = 60_000;
    const OPTIONS = { leaseMs: LEASE_MS, concurrency: 1 };

    it('gives the lease to exactly one of several ticks that arrive together', async () => {
      const id = await newDocument();
      const results = await Promise.all(
        Array.from({ length: 6 }, () => ingestJobsRepo.acquire(db, id, OPTIONS)),
      );
      expect(results.filter((result) => result.kind === 'acquired')).toHaveLength(1);
      expect(results.filter((result) => result.kind === 'held')).toHaveLength(5);
    });

    it('answers `missing` for a document without a job', async () => {
      expect(await ingestJobsRepo.acquire(db, randomUUID(), OPTIONS)).toEqual({ kind: 'missing' });
    });

    it('lets only the holder save, renew and release', async () => {
      const id = await newDocument();
      const taken = await ingestJobsRepo.acquire(db, id, OPTIONS);
      if (taken.kind !== 'acquired') throw new Error('not acquired');
      const state = { stage: 'parsing' as const, cursor: { nextPage: 3 } };
      expect(await ingestJobsRepo.save(db, id, randomUUID(), state, LEASE_MS)).toBe(false);
      expect(await ingestJobsRepo.renew(db, id, randomUUID(), LEASE_MS)).toBe(false);
      expect(await ingestJobsRepo.save(db, id, taken.lease, state, LEASE_MS)).toBe(true);
      expect(await ingestJobsRepo.renew(db, id, taken.lease, LEASE_MS)).toBe(true);
      expect(await ingestJobsRepo.find(db, id)).toMatchObject({ stage: 'parsing', cursor: { nextPage: 3 } });
      await ingestJobsRepo.release(db, id, randomUUID()); // not the holder: nothing happens
      expect((await ingestJobsRepo.acquire(db, id, OPTIONS)).kind).toBe('held');
      await ingestJobsRepo.release(db, id, taken.lease);
      expect((await ingestJobsRepo.acquire(db, id, OPTIONS)).kind).toBe('acquired');
    });

    it('takes over a lease that ran out, and counts it as an attempt; a clean release is not one', async () => {
      const id = await newDocument();
      const first = await ingestJobsRepo.acquire(db, id, OPTIONS);
      if (first.kind !== 'acquired') throw new Error('not acquired');
      expect(first.job.attempts).toBe(0);
      await db.query(
        `UPDATE ingest_jobs SET lease_until = now() - interval '1 second' WHERE document_id = $1`,
        [id],
      );
      const second = await ingestJobsRepo.acquire(db, id, OPTIONS);
      if (second.kind !== 'acquired') throw new Error('not taken over');
      expect(second.job.attempts).toBe(1); // the tick that held it died
      // The tick that lost the lease can no longer write.
      expect(await ingestJobsRepo.save(db, id, first.lease, { stage: 'ocr', cursor: {} }, LEASE_MS)).toBe(
        false,
      );
      // A clean save ends the run of failed ticks; a clean release does not count.
      expect(await ingestJobsRepo.save(db, id, second.lease, { stage: 'ocr', cursor: {} }, LEASE_MS)).toBe(
        true,
      );
      await ingestJobsRepo.release(db, id, second.lease);
      const third = await ingestJobsRepo.acquire(db, id, OPTIONS);
      expect(third.kind === 'acquired' && third.job.attempts).toBe(0);
    });

    it('keeps INGEST_CONCURRENCY documents at work and makes the others wait', async () => {
      const [a, b, c] = [await newDocument(), await newDocument(), await newDocument()];
      const first = await ingestJobsRepo.acquire(db, a, OPTIONS);
      if (first.kind !== 'acquired') throw new Error('not acquired');
      expect((await ingestJobsRepo.acquire(db, b, OPTIONS)).kind).toBe('busy');
      expect((await ingestJobsRepo.acquire(db, b, { ...OPTIONS, concurrency: 2 })).kind).toBe('acquired');
      expect((await ingestJobsRepo.acquire(db, c, { ...OPTIONS, concurrency: 2 })).kind).toBe('busy');
      await ingestJobsRepo.release(db, a, first.lease);
      expect((await ingestJobsRepo.acquire(db, c, { ...OPTIONS, concurrency: 2 })).kind).toBe('acquired');
    });

    it('parks a job until its time, refuses ticks meanwhile, and lets it go by itself when the time has passed', async () => {
      const id = await newDocument();
      const taken = await ingestJobsRepo.acquire(db, id, OPTIONS);
      if (taken.kind !== 'acquired') throw new Error('not acquired');
      const until = new Date(Date.now() + 3_600_000);
      expect(await ingestJobsRepo.park(db, id, taken.lease, until, 'daily quota reached')).toBe(true);
      const parked = await ingestJobsRepo.acquire(db, id, OPTIONS);
      expect(parked.kind === 'parked' && parked.until.getTime()).toBe(until.getTime());
      await db.query(
        `UPDATE ingest_jobs SET parked_until = now() - interval '1 minute' WHERE document_id = $1`,
        [id],
      );
      // Nothing sweeps the parking (there is no cron for it): the next tick finds it over.
      expect((await ingestJobsRepo.acquire(db, id, OPTIONS)).kind).toBe('acquired');
      expect((await ingestJobsRepo.find(db, id))?.parked_until).toBeNull();
    });

    it('counts the jobs that are being read, not the abandoned ones or the parked ones, and orders the waiting', async () => {
      const [a, b, c] = [await newDocument(), await newDocument(), await newDocument()];
      expect(await ingestJobsRepo.countActive(db, 600_000)).toBe(3);
      await db.query(`UPDATE ingest_jobs SET updated_at = now() - interval '1 hour' WHERE document_id = $1`, [
        a,
      ]);
      expect(await ingestJobsRepo.countActive(db, 600_000)).toBe(2); // nobody has touched it for an hour
      await db.query(
        `UPDATE ingest_jobs SET parked_until = now() + interval '1 hour' WHERE document_id = $1`,
        [b],
      );
      expect(await ingestJobsRepo.countActive(db, 600_000)).toBe(1);
      expect(await ingestJobsRepo.queuePosition(db, c, 600_000)).toBe(1);
    });

    it('is removed with its document, together with the stage data', async () => {
      const id = await newDocument();
      await stageDataRepo.put(db, id, 'page', 1, { text: 'one' });
      await stageDataRepo.put(db, id, 'page', 1, { text: 'one again' }); // a repeated write replaces
      await stageDataRepo.put(db, id, 'page', 2, { text: 'two' });
      expect(await stageDataRepo.all(db, id, 'page')).toEqual([
        { item: 1, data: { text: 'one again' } },
        { item: 2, data: { text: 'two' } },
      ]);
      expect(await stageDataRepo.count(db, id, 'page')).toBe(2);
      expect(await stageDataRepo.get(db, id, 'page', 9)).toBeNull();
      await documentsRepo.remove(db, id);
      expect(await ingestJobsRepo.find(db, id)).toBeNull();
      expect(await stageDataRepo.count(db, id, 'page')).toBe(0);
    });
  });

  describe('the progress of a document', () => {
    it('is recorded for a processing document only, and reset by ready', async () => {
      const id = await newDocument();
      expect(
        await documentsRepo.setProgress(db, id, {
          stage: 'ocr',
          completed: 2,
          total: 5,
          unit: 'pages',
          detail: 'x',
        }),
      ).toBe(true);
      expect(await documentsRepo.findById(db, id)).toMatchObject({
        stage: 'ocr',
        progress_completed: 2,
        progress_total: 5,
        progress_unit: 'pages',
        progress_detail: 'x',
      });
      await documentsRepo.markReady(db, id, {
        primaryLanguage: 'en',
        direction: 'ltr',
        languages: [],
        sections: [],
        warnings: [],
        pageCount: 5,
      });
      expect(
        await documentsRepo.setProgress(db, id, { stage: 'ocr', completed: 3, total: 5, unit: 'pages' }),
      ).toBe(false);
      expect(await documentsRepo.findById(db, id)).toMatchObject({
        status: 'ready',
        stage: 'ready',
        progress_completed: 1,
        progress_total: 1,
        progress_detail: null,
      });
    });
  });

  describe('GeminiBudgets, beyond the reservations', () => {
    it('has a budget of its own for the small calls around an answer, which can be given back', async () => {
      const now = new Date('2026-10-02T12:00:00Z');
      const budgets = new GeminiBudgets(db, { llm: 5, embed: 5, ocr: 5, aux: 2 }, () => now);
      expect((await budgets.reserve('aux')).allowed).toBe(true);
      expect((await budgets.reserve('aux')).allowed).toBe(true);
      expect((await budgets.reserve('aux')).allowed).toBe(false);
      await budgets.refund('aux'); // the call did not happen
      expect(await budgets.used('aux')).toBe(1);
      expect((await budgets.reserve('aux')).allowed).toBe(true);
      expect(await budgets.used('llm')).toBe(0); // the kinds do not share
    });

    it('counts what was used beyond what was reserved, even past the limit, and then refuses the day', async () => {
      const now = new Date('2026-10-02T12:00:00Z');
      const budgets = new GeminiBudgets(db, { llm: 0, embed: 0, ocr: 4, aux: 0 }, () => now);
      expect((await budgets.reserve('ocr', 2)).allowed).toBe(true);
      await budgets.charge('ocr', 5); // the call made seven requests in all
      expect(await budgets.used('ocr')).toBe(7);
      expect((await budgets.reserve('ocr', 1)).allowed).toBe(false);
      await budgets.charge('llm', 3); // a kind without a limit counts nothing
      expect(await budgets.used('llm')).toBe(0);
    });
  });

  describe('GeminiBudgets across midnight', () => {
    it('settles a reservation on the Pacific day it was taken in, not on the day it is settled', async () => {
      let now = new Date('2026-10-03T06:59:58Z'); // 23:59:58 on 2 October in Pacific time
      const budgets = new GeminiBudgets(db, { llm: 0, embed: 20, ocr: 0, aux: 0 }, () => now);
      const evening = await budgets.reserve('embed', 16);
      expect(evening.allowed).toBe(true);
      now = new Date('2026-10-03T07:00:03Z'); // 00:00:03 the next day
      expect((await budgets.reserve('embed', 20)).allowed).toBe(true);
      // The 16 are given back to the evening's day: the new day keeps its 20 (it used to be lowered to 4, and admit 36 of 20).
      await budgets.refund('embed', 16, evening.windowStart);
      expect(await budgets.used('embed')).toBe(20);
      expect(await budgets.used('embed', evening.windowStart)).toBe(0);
      expect((await budgets.reserve('embed', 1)).allowed).toBe(false);
      // What was used beyond the reservation is charged to the evening's day as well.
      await budgets.charge('embed', 3, evening.windowStart);
      expect(await budgets.used('embed', evening.windowStart)).toBe(3);
      expect(await budgets.used('embed')).toBe(20);
    });

    it('gives back to the day each unit was taken in when a later kind is refused (requireAll), and says which day that was', async () => {
      const now = new Date('2026-10-03T12:00:00Z');
      const budgets = new GeminiBudgets(db, { llm: 5, embed: 1, ocr: 0, aux: 0 }, () => now);
      const day = await budgets.requireAll(['llm', 'embed']);
      expect(day.getTime()).toBe(pacificDayStart(now).getTime());
      await expect(budgets.requireAll(['llm', 'embed'])).rejects.toMatchObject({ code: 'RATE_LIMITED' });
      expect(await budgets.used('llm', day)).toBe(1);
    });
  });

  describe('uploadTicketsRepo', () => {
    const ticket = async (
      options: { expiresAt?: Date; maxBytes?: number } = {},
    ): Promise<{ pathname: string; sessionId: string }> => {
      const sessionId = await insertSession(db);
      const pathname = `${randomUUID()}.pdf`;
      await uploadTicketsRepo.issue(db, {
        pathname,
        sessionId,
        maxBytes: options.maxBytes ?? 1000,
        expiresAt: options.expiresAt ?? new Date(Date.now() + 1_800_000),
      });
      return { pathname, sessionId };
    };

    it('counts what a ticket may bring from its issue until it is settled, used or refused or not', async () => {
      const before = await uploadTicketsRepo.openBytes(db);
      const open = await ticket();
      const used = await ticket();
      const burned = await ticket();
      expect((await uploadTicketsRepo.openBytes(db)) - before).toBe(3000);
      expect(await uploadTicketsRepo.claim(db, used.pathname, used.sessionId, randomUUID())).toBe(true);
      await uploadTicketsRepo.burn(db, burned.pathname);
      // A used or burned ticket still counts: its client token can put a blob under the pathname again until the ticket is over.
      expect((await uploadTicketsRepo.openBytes(db)) - before).toBe(3000);
      await uploadTicketsRepo.markReleased(db, used.pathname);
      expect((await uploadTicketsRepo.openBytes(db)) - before).toBe(2000);
      await uploadTicketsRepo.markReleased(db, burned.pathname);
      await uploadTicketsRepo.markReleased(db, open.pathname);
      expect((await uploadTicketsRepo.openBytes(db)) - before).toBe(0);
    });

    it('is claimed once, by its own session, and gives no token once it is spent', async () => {
      const t = await ticket();
      expect(await uploadTicketsRepo.isOpenFor(db, t.pathname, t.sessionId)).toBe(true);
      expect(await uploadTicketsRepo.isOpenFor(db, t.pathname, randomUUID())).toBe(false);
      expect(await uploadTicketsRepo.claim(db, t.pathname, randomUUID(), randomUUID())).toBe(false); // another session
      expect(await uploadTicketsRepo.claim(db, t.pathname, t.sessionId, randomUUID())).toBe(true);
      expect(await uploadTicketsRepo.claim(db, t.pathname, t.sessionId, randomUUID())).toBe(false); // once
      expect(await uploadTicketsRepo.isOpenFor(db, t.pathname, t.sessionId)).toBe(false);
    });

    it('offers for settling every unsettled ticket an hour past its expiry, used or not, oldest first', async () => {
      const old = await ticket({ expiresAt: new Date(Date.now() - 3 * 3_600_000) });
      const used = await ticket({ expiresAt: new Date(Date.now() - 2 * 3_600_000) });
      await uploadTicketsRepo.claim(db, used.pathname, used.sessionId, randomUUID());
      const recent = await ticket({ expiresAt: new Date(Date.now() - 600_000) }); // not yet an hour
      const settled = await ticket({ expiresAt: new Date(Date.now() - 4 * 3_600_000) });
      await uploadTicketsRepo.markReleased(db, settled.pathname);
      const mine = new Set([old.pathname, used.pathname, recent.pathname, settled.pathname]);
      const due = (await uploadTicketsRepo.dueBefore(db, new Date(Date.now() - 3_600_000), 1000)).filter(
        (pathname) => mine.has(pathname),
      );
      expect(due).toEqual([old.pathname, used.pathname]);
    });
  });

  describe('what a tick writes into its job, besides its saves', () => {
    const LEASE_MS = 60_000;
    const OPTIONS = { leaseMs: LEASE_MS, concurrency: 5 };

    it('counts a tick that was stopped at its hard limit as an attempt and keeps the time it worked, the rest of the cursor as it was', async () => {
      const id = await newDocument();
      const taken = await ingestJobsRepo.acquire(db, id, OPTIONS);
      if (taken.kind !== 'acquired') throw new Error('not acquired');
      await ingestJobsRepo.save(
        db,
        id,
        taken.lease,
        { stage: 'ocr', cursor: { workMs: 100, transient: 0, ocr: { spentMs: 10, read: [1, 2] } } },
        LEASE_MS,
      );
      expect(await ingestJobsRepo.releaseAborted(db, id, randomUUID(), { workMs: 1 })).toBe(false); // not the holder
      expect(
        await ingestJobsRepo.releaseAborted(db, id, taken.lease, { workMs: 240_000, ocrSpentMs: 230_000 }),
      ).toBe(true);
      const job = await ingestJobsRepo.find(db, id);
      expect(job).toMatchObject({
        attempts: 1,
        lease_id: null,
        stage: 'ocr',
        cursor: { workMs: 240_000, transient: 0, ocr: { spentMs: 230_000, read: [1, 2] } },
      });
      // Without OCR in the cursor only the time is written.
      const again = await ingestJobsRepo.acquire(db, id, OPTIONS);
      if (again.kind !== 'acquired') throw new Error('not acquired');
      await ingestJobsRepo.save(
        db,
        id,
        again.lease,
        { stage: 'parsing', cursor: { workMs: 1, transient: 0 } },
        LEASE_MS,
      );
      await ingestJobsRepo.releaseAborted(db, id, again.lease, { workMs: 9, ocrSpentMs: 5 });
      expect((await ingestJobsRepo.find(db, id))?.cursor).toEqual({ workMs: 9, transient: 0 });
    });

    it('counts the ticks in a row that failed for a passing reason, for the holder only', async () => {
      const id = await newDocument();
      const taken = await ingestJobsRepo.acquire(db, id, OPTIONS);
      if (taken.kind !== 'acquired') throw new Error('not acquired');
      await ingestJobsRepo.save(
        db,
        id,
        taken.lease,
        { stage: 'embedding', cursor: { workMs: 5, transient: 0 } },
        LEASE_MS,
      );
      expect(await ingestJobsRepo.recordTransient(db, id, randomUUID(), 'database')).toBeNull();
      expect(await ingestJobsRepo.recordTransient(db, id, taken.lease, 'database')).toBe(1);
      expect(await ingestJobsRepo.recordTransient(db, id, taken.lease, 'database')).toBe(2);
      expect((await ingestJobsRepo.find(db, id))?.cursor).toEqual({
        workMs: 5,
        transient: 2,
        transientCause: 'database',
      });
    });

    it('counts ONE cause at a time: a different trouble starts the count again at 1', async () => {
      const id = await newDocument();
      const taken = await ingestJobsRepo.acquire(db, id, OPTIONS);
      if (taken.kind !== 'acquired') throw new Error('not acquired');
      await ingestJobsRepo.save(
        db,
        id,
        taken.lease,
        { stage: 'embedding', cursor: { workMs: 5, transient: 0 } },
        LEASE_MS,
      );
      expect(await ingestJobsRepo.recordTransient(db, id, taken.lease, 'database')).toBe(1);
      expect(await ingestJobsRepo.recordTransient(db, id, taken.lease, 'database')).toBe(2);
      expect(await ingestJobsRepo.recordTransient(db, id, taken.lease, 'store')).toBe(1); // another cause: back to 1
      expect(await ingestJobsRepo.recordTransient(db, id, taken.lease, 'database')).toBe(1);
      expect((await ingestJobsRepo.find(db, id))?.cursor).toMatchObject({
        transient: 1,
        transientCause: 'database',
      });
    });

    it('keeps the run of failed ticks through a save that is only a label, and ends it with any other', async () => {
      const id = await newDocument();
      const first = await ingestJobsRepo.acquire(db, id, OPTIONS);
      if (first.kind !== 'acquired') throw new Error('not acquired');
      // The lease of a tick that died holding it: the next acquire counts an attempt.
      await db.query(
        `UPDATE ingest_jobs SET lease_until = now() - interval '1 second' WHERE document_id = $1`,
        [id],
      );
      const second = await ingestJobsRepo.acquire(db, id, OPTIONS);
      if (second.kind !== 'acquired') throw new Error('not acquired');
      expect(second.job.attempts).toBe(1);
      const state = { stage: 'validating' as const, cursor: { workMs: 0, transient: 1 } };
      expect(await ingestJobsRepo.save(db, id, second.lease, state, LEASE_MS, { keepAttempts: true })).toBe(
        true,
      );
      expect((await ingestJobsRepo.find(db, id))?.attempts).toBe(1); // a label: not progress
      expect(await ingestJobsRepo.save(db, id, second.lease, state, LEASE_MS)).toBe(true);
      expect((await ingestJobsRepo.find(db, id))?.attempts).toBe(0); // a unit of work was saved
    });

    it('makes the job of a document that is being processed and has none, and of no other', async () => {
      const id = await newDocument();
      await ingestJobsRepo.remove(db, id);
      expect(await ingestJobsRepo.createForProcessing(db, id)).toBe(true);
      expect(await ingestJobsRepo.createForProcessing(db, id)).toBe(false); // it has one
      await ingestJobsRepo.remove(db, id);
      await documentsRepo.markReady(db, id, {
        primaryLanguage: 'en',
        direction: 'ltr',
        languages: [],
        sections: [],
        warnings: [],
        pageCount: 1,
      });
      expect(await ingestJobsRepo.createForProcessing(db, id)).toBe(false); // a finished document gets none
      expect(await ingestJobsRepo.createForProcessing(db, randomUUID())).toBe(false); // nor a document that is gone
      expect(await ingestJobsRepo.find(db, id)).toBeNull();
    });

    it('does not count the jobs of the session that is replacing its document', async () => {
      const [a, b] = [await newDocument(), await newDocument()];
      const owner = (await documentsRepo.findById(db, a))?.session_id ?? null;
      expect(await ingestJobsRepo.countActive(db, 600_000)).toBe(2);
      expect(await ingestJobsRepo.countActive(db, 600_000, owner)).toBe(1);
      expect(b).not.toBe(a);
    });

    it('writes the progress of a tick only while its lease is the job’s', async () => {
      const id = await newDocument();
      const taken = await ingestJobsRepo.acquire(db, id, OPTIONS);
      if (taken.kind !== 'acquired') throw new Error('not acquired');
      const progress = { stage: 'analyzing' as const, completed: 1, total: 4, unit: 'pages' as const };
      expect(await documentsRepo.setProgress(db, id, progress, randomUUID())).toBe(false);
      expect(await documentsRepo.setProgress(db, id, progress, taken.lease)).toBe(true);
      await documentsRepo.setDirection(db, id, 'rtl', randomUUID());
      expect((await documentsRepo.findById(db, id))?.direction).toBe('ltr');
      await documentsRepo.setDirection(db, id, 'rtl', taken.lease);
      expect((await documentsRepo.findById(db, id))?.direction).toBe('rtl');
    });
  });

  describe('the lease under real concurrency', () => {
    it('gives INGEST_CONCURRENCY leases, no more, to the documents that all ask for one at once', async () => {
      const ids = await Promise.all(Array.from({ length: 10 }, () => newDocument()));
      const results = await Promise.all(
        ids.map((id) => ingestJobsRepo.acquire(db, id, { leaseMs: 60_000, concurrency: 2 })),
      );
      expect(results.filter((result) => result.kind === 'acquired')).toHaveLength(2);
      expect(results.filter((result) => result.kind === 'busy')).toHaveLength(8);
    });

    it('gives a document that many ticks ask for to exactly one of them, over and over', async () => {
      for (let round = 0; round < 5; round += 1) {
        const id = await newDocument();
        const results = await Promise.all(
          Array.from({ length: 20 }, () =>
            ingestJobsRepo.acquire(db, id, { leaseMs: 60_000, concurrency: 50 }),
          ),
        );
        expect(results.filter((result) => result.kind === 'acquired')).toHaveLength(1);
        expect(results.filter((result) => result.kind === 'held')).toHaveLength(19);
      }
    });
  });

  describe('a document that is removed while a tick commits', () => {
    const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

    /** A database whose transactions are slow between statements: the window in which locks are held is wide. */
    const slowDb = (): Db => ({
      ...db,
      transaction: (fn) =>
        db.transaction((tx) =>
          fn({
            ...tx,
            query: async (sql: string, params?: readonly unknown[]) => {
              const result = await tx.query(sql, params);
              await sleep(3);
              return result;
            },
            exec: (sql: string) => tx.exec(sql),
          } as typeof tx),
        ),
    });

    // On PostgreSQL the delete takes the document row and then the job row (the cascade), and a commit used to take the job row and
    // then the document row: each waited for the other, and the database ended one of them with a deadlock (40P01). Every write
    // of a tick locks the document first now (commit, park, finishing and failing a document); the removal comes in the ways
    // the app has (DELETE, the replacement of a session's processing document, retention). PGlite has one connection, so only a
    // real server can show it.
    interface Ticking {
      /** What a tick does to its job in one transaction. */
      name: string;
      run(ctx: TickContext, deps: TickDeps, row: DocumentRow, lease: string): Promise<void>;
    }
    const failure = new AppError('PDF_UNREADABLE', 'damaged');
    const tickings: Ticking[] = [
      {
        name: 'commits',
        run: (ctx) =>
          ctx.commit({ progress: { completed: 1, total: 2, unit: 'pages' }, writes: () => sleep(1) }),
      },
      {
        name: 'parks',
        run: async (ctx) => {
          await ctx.park({ completed: 1, total: 2, unit: 'pages' }, 'daily quota reached');
        },
      },
      {
        name: 'finishes the document',
        run: async (ctx) => {
          ctx.cursor.analysis = {
            primaryLanguage: 'en',
            direction: 'ltr',
            languages: [],
            sections: [],
            warnings: [],
            pageCount: 1,
            chunkCount: 0,
          };
          await finishDocument(ctx, 0);
        },
      },
      {
        name: 'fails the document',
        run: async (_ctx, deps, row, lease) => {
          const failed = await failDocument(deps, row, failure, { lease });
          // (failDocument tells, and does not throw, when the database ends it: a deadlock would be in the log.)
          if (!failed) throw new LeaseLostError();
        },
      },
    ];
    interface Removal {
      name: string;
      run(database: Db, id: string, sessionId: string): Promise<unknown>;
    }
    const removals: Removal[] = [
      { name: 'DELETE', run: (database, id) => documentsRepo.remove(database, id) },
      {
        name: 'the replacement of the session’s processing document',
        run: (database, _id, sessionId) =>
          documentsRepo.removeProcessingForSession(database, sessionId, null),
      },
      {
        name: 'retention',
        run: async (database, id) => {
          await database.query(
            "UPDATE documents SET expires_at = now() - interval '1 minute' WHERE id = $1",
            [id],
          );
          return documentsRepo.removeExpired(database, new Date());
        },
      },
    ];

    for (const ticking of tickings) {
      for (const removal of removals) {
        it.runIf(backend.kind === 'pg')(
          `never ends one of them as the victim of a deadlock: a tick that ${ticking.name}, against ${removal.name}`,
          async () => {
            const slow = slowDb();
            const errors: unknown[] = [];
            const outcomes = { done: 0, lost: 0 };
            for (let trial = 0; trial < 25; trial += 1) {
              const id = await newDocument();
              const taken = await ingestJobsRepo.acquire(db, id, { leaseMs: 60_000, concurrency: 1000 });
              if (taken.kind !== 'acquired') throw new Error('not acquired');
              const row = await documentsRepo.findById(db, id);
              if (row === null) throw new Error('no such document');
              const deps = {
                db: slow,
                storage: { delete: () => Promise.resolve() },
                bytes: { forget: () => Promise.resolve() },
                config: { ingestLeaseMs: 60_000, ingestTickHardLimitMs: 240_000 },
                log: {
                  info: () => undefined,
                  warn: () => undefined,
                  error: (object: unknown) => errors.push(object),
                },
              } as unknown as TickDeps;
              const ctx = new TickContext(
                deps,
                row,
                'parsing',
                { workMs: 0, transient: 0 },
                taken.lease,
                new AbortController().signal,
              );
              const tick = ticking.run(ctx, deps, row, taken.lease).then(
                () => 'done' as const,
                (error: unknown) => {
                  if (error instanceof LeaseLostError) return 'lost' as const;
                  throw error; // a deadlock is not this
                },
              );
              const remove = sleep(trial % 7).then(() => removal.run(slow, id, row.session_id));
              const [outcome] = await Promise.all([tick, remove]);
              outcomes[outcome] += 1;
              // Whoever won, nothing of a removed document is left (a document the tick finished or failed first is removed by
              // the DELETE and retention only if they ran; the replacement removes processing documents only).
              const left = await documentsRepo.findById(db, id);
              if (left === null) expect(await ingestJobsRepo.find(db, id)).toBeNull();
            }
            expect(errors).toEqual([]); // no deadlock was logged by failDocument
            expect(outcomes.done + outcomes.lost).toBe(25);
          },
          120_000,
        );
      }
    }

    it('is retried once by the removal paths when the database does choose them as the victim', async () => {
      let calls = 0;
      const result = await retryOnDeadlock(() => {
        calls += 1;
        if (calls === 1)
          return Promise.reject(Object.assign(new Error('deadlock detected'), { code: '40P01' }));
        return Promise.resolve('removed');
      });
      expect(result).toBe('removed');
      expect(calls).toBe(2);
      await expect(
        retryOnDeadlock(() => Promise.reject(Object.assign(new Error('other'), { code: '23505' }))),
      ).rejects.toThrow('other');
    });
  });
});
