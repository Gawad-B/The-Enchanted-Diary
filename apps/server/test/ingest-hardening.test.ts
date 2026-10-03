import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createDb, type Db, type Queryable } from '../src/db/client.js';
import { documentsRepo } from '../src/db/repositories/documents.js';
import { ingestJobsRepo } from '../src/db/repositories/ingest-jobs.js';
import { AppError } from '../src/http/errors.js';
import { DocumentBytes } from '../src/ingest/bytes.js';
import { failDocument } from '../src/ingest/tick/finish.js';
import type { TickDeps } from '../src/ingest/tick/context.js';
import { IngestWorkerHost, type IngestWorkers } from '../src/ingest/worker/host.js';
import { trailingFailureRun } from '../src/ingest/worker/host-parse-range.js';
import { PageLedger } from '../src/ingest/worker/ledger.js';
import { LocalDiskStorage } from '../src/storage/local-disk.js';
import { EmbeddingError } from '../src/embeddings/provider.js';
import { StorageError, type StorageProvider } from '../src/storage/provider.js';
import {
  detailOf,
  startServer,
  summaryOf,
  tickOnce,
  tickUntilDone,
  type TestServer,
} from './http-helpers.js';
import { FakeEmbeddings, Gate, type FakeEmbeddingOptions } from './doubles/fake-embeddings.js';
import { insertSession, resetCounters, testConfig } from './helpers.js';
import type { IngestTickResponse } from '@enchanted/shared';

/*
 * The tick engine where it has to hold up in real conditions: a unit of work that outlasts the tick, pages that hang in every
 * tick, a database or a store that fails once, a tick that no longer holds its job. Real server, real worker threads, PGlite with
 * the real migrations; the failures are injected.
 */

let db: Db;
const servers: TestServer[] = [];

beforeAll(async () => {
  db = await createDb(testConfig());
});
afterEach(async () => {
  await Promise.all(servers.splice(0).map((started) => started.close()));
  await resetCounters(db);
  await db.query('DELETE FROM documents');
});
afterAll(async () => {
  await db.close();
});

const SMALL_TICKS = { INGEST_TICK_BUDGET_MS: '1000' };

/** The real workers, except for what `replace` says. */
function workersWith(config: ReturnType<typeof testConfig>, replace: Partial<IngestWorkers>): IngestWorkers {
  const real = new IngestWorkerHost({
    maxOldGenerationSizeMb: config.ingestWorkerMaxOldMb,
    pageTimeoutMs: config.ingestPageTimeoutMs,
    maxRssGrowthMb: config.ingestWorkerMaxRssGrowthMb,
  });
  return {
    validate: (bytes, options) => real.validate(bytes, options),
    parse: (bytes, options) => real.parse(bytes, options),
    parseRange: (bytes, options) => real.parseRange(bytes, options),
    analyze: (pages, options) => real.analyze(pages, options),
    ocr: (bytes, options) => real.ocr(bytes, options),
    checkOcr: (settings, options) => real.checkOcr(settings, options),
    ...replace,
  };
}

async function serverWith(
  env: Record<string, string>,
  overrides: {
    workers?: Partial<IngestWorkers>;
    db?: Db;
    storage?: (inner: StorageProvider) => StorageProvider;
  },
): Promise<TestServer> {
  const config = testConfig(env);
  const inner = new LocalDiskStorage(config.storageDir);
  const started = await startServer(overrides.db ?? db, config, {
    deps: {
      ingestion: {
        ...(overrides.workers === undefined ? {} : { workers: workersWith(config, overrides.workers) }),
        ...(overrides.storage === undefined ? {} : { storage: overrides.storage(inner) }),
      },
    },
  });
  servers.push(started);
  return started;
}

/** A database that drops the connection for the next `budget.failures` statements `shouldFail` picks out. */
function flakyDb(
  real: Db,
  shouldFail: (sql: string, params: readonly unknown[]) => boolean,
  budget: { failures: number },
): Db {
  const guard =
    (target: Queryable): Queryable['query'] =>
    async (sql, params) => {
      if (budget.failures > 0 && shouldFail(sql, params ?? [])) {
        budget.failures -= 1;
        throw new Error('Connection terminated unexpectedly');
      }
      return target.query(sql, params);
    };
  return {
    ...real,
    query: guard(real),
    transaction: (fn) =>
      real.transaction((tx) => fn({ ...tx, query: guard(tx), exec: (sql: string) => tx.exec(sql) })),
  };
}

const embedReservation = (sql: string, params: readonly unknown[]): boolean =>
  sql.includes('rate_counters') && params[0] === 'gemini:embed';

const hangUntilAborted = (): IngestWorkers['analyze'] => (_pages, options) =>
  new Promise((_resolve, reject) => {
    options.signal?.addEventListener(
      'abort',
      () => {
        reject(options.signal?.reason instanceof Error ? options.signal.reason : new Error('aborted'));
      },
      { once: true },
    );
  });

describe('a unit of work that outlasts the tick (it does not end by itself)', () => {
  it('counts every such tick as an attempt, keeps the time it took, and ends the document after INGEST_MAX_ATTEMPTS', async () => {
    const started = await serverWith(
      { ...SMALL_TICKS, INGEST_TICK_HARD_LIMIT_MS: '5000', INGEST_MAX_ATTEMPTS: '2' },
      { workers: { analyze: hangUntilAborted() } },
    );
    const client = started.client();
    const accepted = summaryOf(await client.uploadFixture('text-en.pdf'));
    // Parsing is quick; the first tick that reaches the analysis is stopped at the hard limit. Which tick that is does not depend
    // on how long a tick took on a loaded machine: it is the one after which the job, with every page extracted, records an attempt.
    const analysisHung = async (): Promise<boolean> => {
      const job = await ingestJobsRepo.find(db, accepted.id);
      const parse = (job?.cursor as { parse?: { nextPage: number; pageCount: number } } | undefined)?.parse;
      // An attempt that was recorded after every page was extracted: a tick that overran in the parsing would not count.
      return job?.attempts === 1 && parse !== undefined && parse.nextPage > parse.pageCount;
    };
    let answer: IngestTickResponse = await tickOnce(client, accepted.id);
    for (let ticks = 1; !(await analysisHung()); ticks += 1) {
      expect(ticks, 'the analysis was never reached').toBeLessThan(60);
      answer = await tickOnce(client, accepted.id);
    }
    expect(answer.status).toBe('running');
    let job = await ingestJobsRepo.find(db, accepted.id);
    // Nothing was saved by the unit, but the tick is not free: it is an attempt, and its time is the job's.
    expect(job).toMatchObject({ lease_id: null, attempts: 1 });
    expect((job?.cursor as { workMs: number }).workMs).toBeGreaterThanOrEqual(5000);

    await tickOnce(client, accepted.id); // the second such tick
    job = await ingestJobsRepo.find(db, accepted.id);
    expect(job?.attempts).toBe(2);
    // The third is not even started: the job has used its attempts, the document ends, and its cleanup follows.
    answer = await tickOnce(client, accepted.id);
    expect(answer).toMatchObject({ status: 'failed', error: { code: 'INGEST_INTERRUPTED' } });
    expect(await ingestJobsRepo.find(db, accepted.id)).toBeNull();
  }, 120_000);

  it('is bounded by INGEST_JOB_TIMEOUT_MS: the time such ticks took is counted, and the document ends as taking too long', async () => {
    const started = await serverWith(
      {
        ...SMALL_TICKS,
        INGEST_TICK_HARD_LIMIT_MS: '5000',
        INGEST_MAX_ATTEMPTS: '50',
        INGEST_JOB_TIMEOUT_MS: '8000',
      },
      { workers: { analyze: hangUntilAborted() } },
    );
    const client = started.client();
    const accepted = summaryOf(await client.uploadFixture('text-en.pdf'));
    const answers = await tickUntilDone(client, accepted.id, { timeoutMs: 100_000 });
    const last = answers.at(-1);
    expect(last).toMatchObject({ status: 'failed', error: { code: 'PDF_UNREADABLE' } });
    expect(last?.error?.message).toContain('took too long');
  }, 120_000);
});

describe('pages that hang in every tick', () => {
  const HANGING = {
    url: new URL('./doubles/hanging-parse-worker.mjs', import.meta.url),
    execArgv: ['--conditions=source'],
  };

  it('give up on the document after five in a row, however many ticks it takes (the run is not forgotten between ticks)', async () => {
    process.env.HANGING_PAGES = '5';
    try {
      const config = testConfig({ ...SMALL_TICKS, INGEST_PAGE_TIMEOUT_MS: '500' });
      const real = new IngestWorkerHost(
        {
          maxOldGenerationSizeMb: config.ingestWorkerMaxOldMb,
          pageTimeoutMs: config.ingestPageTimeoutMs,
          maxRssGrowthMb: config.ingestWorkerMaxRssGrowthMb,
        },
        { entry: HANGING },
      );
      const started = await startServer(db, config, { deps: { ingestion: { workers: real } } });
      servers.push(started);
      const client = started.client();
      const accepted = summaryOf(await client.uploadFixture('text-en.pdf'));
      const answers = await tickUntilDone(client, accepted.id, { timeoutMs: 100_000 });
      // More than one tick (each loses at most a couple of pages in its second), and the verdict is the run of five.
      expect(answers.length).toBeGreaterThan(2);
      const last = answers.at(-1);
      expect(last).toMatchObject({ status: 'failed', error: { code: 'PDF_UNREADABLE' } });
      expect(last?.error?.message).toContain('5 pages in a row could not be read');
    } finally {
      delete process.env.HANGING_PAGES;
    }
  }, 120_000);
});

describe('a database or a store that fails once', () => {
  it('does not fail the document or delete its file: the tick says to come back, and the next one finishes it', async () => {
    const budget = { failures: 1 };
    const started = await serverWith({}, { db: flakyDb(db, embedReservation, budget) });
    const client = started.client();
    const accepted = summaryOf(await client.uploadFixture('text-en.pdf'));
    const answers: IngestTickResponse[] = [];
    const done = await tickUntilDone(client, accepted.id, {
      onTick: async (answer) => {
        answers.push(answer);
        // Whatever happened, the file is there while the document is being read.
        if (answer.status === 'running') {
          expect(await started.app.ingestion.storage.stat(`${accepted.id}.pdf`)).not.toBeNull();
        }
      },
    });
    expect(budget.failures).toBe(0); // it did happen
    expect(answers.some((answer) => answer.status === 'running' && answer.retryAfterMs === 3000)).toBe(true);
    expect(answers.every((answer) => answer.status !== 'failed')).toBe(true);
    expect(done.at(-1)?.status).toBe('ready');
    expect((await detailOf(client, accepted.id)).chunkCount).toBe(5);
  }, 120_000);

  it('fails the document only after three ticks in a row, and still keeps its file', async () => {
    const budget = { failures: 1000 };
    const started = await serverWith({}, { db: flakyDb(db, embedReservation, budget) });
    const client = started.client();
    const accepted = summaryOf(await client.uploadFixture('text-en.pdf'));
    const answers = await tickUntilDone(client, accepted.id);
    const last = answers.at(-1);
    expect(last).toMatchObject({ status: 'failed', error: { code: 'INTERNAL' } });
    // Three ticks that failed for a passing reason: two of them said "come back" (3 s, then 9 s: each wait longer), the third gave up.
    expect(
      answers.filter((answer) => answer.status === 'running').map((answer) => answer.retryAfterMs),
    ).toEqual([3000, 9000]);
    expect(await started.app.ingestion.storage.stat(`${accepted.id}.pdf`)).not.toBeNull();
  }, 120_000);

  it('does the same for a store that does not answer when the document is read back', async () => {
    let failures = 1;
    const started = await serverWith(
      {},
      {
        storage: (inner) => ({
          name: inner.name,
          put: (key, data) => inner.put(key, data),
          get: (key) => {
            if (failures > 0) {
              failures -= 1;
              return Promise.reject(new StorageError('IO', 'the store did not answer'));
            }
            return inner.get(key);
          },
          createReadStream: (key) => inner.createReadStream(key),
          stat: (key) => inner.stat(key),
          delete: (key) => inner.delete(key),
          list: () => inner.list(),
          deleteTemporary: (name) => inner.deleteTemporary(name),
        }),
      },
    );
    const client = started.client();
    const accepted = summaryOf(await client.uploadFixture('text-en.pdf'));
    const first = await tickOnce(client, accepted.id);
    expect(first).toMatchObject({ status: 'running', retryAfterMs: 3000 });
    expect(failures).toBe(0);
    expect(await started.app.ingestion.storage.stat(`${accepted.id}.pdf`)).not.toBeNull();
    expect((await tickUntilDone(client, accepted.id)).at(-1)?.status).toBe('ready');
  }, 120_000);
});

/** A storage whose reads are `get`, the rest the real local disk. */
function storageWith(inner: StorageProvider, get: StorageProvider['get']): StorageProvider {
  return {
    name: inner.name,
    put: (key, data) => inner.put(key, data),
    get,
    createReadStream: (key) => inner.createReadStream(key),
    stat: (key) => inner.stat(key),
    delete: (key) => inner.delete(key),
    list: () => inner.list(),
    deleteTemporary: (name) => inner.deleteTemporary(name),
  };
}

describe('a store that does not answer when the document is first read (the validate stage)', () => {
  it('fails the document after three ticks in a row, STORAGE_FAILED, the file kept, each tick asked to wait longer: it is not asked again for ever', async () => {
    let reads = 0;
    const started = await serverWith(
      { INGEST_MAX_ATTEMPTS: '1' },
      {
        storage: (inner) =>
          storageWith(inner, () => {
            reads += 1;
            return Promise.reject(new StorageError('IO', 'the store did not answer'));
          }),
      },
    );
    const client = started.client();
    const accepted = summaryOf(await client.uploadFixture('text-en.pdf'));
    const answers = await tickUntilDone(client, accepted.id);
    // Naming the stage "validating" used to end the run of failed ticks at every tick: 1, 1, 1, ... for as long as the tab asked.
    expect(answers.map((answer) => answer.status)).toEqual(['running', 'running', 'failed']);
    expect(answers.map((answer) => answer.retryAfterMs)).toEqual([3000, 9000, undefined]);
    expect(answers.at(-1)).toMatchObject({ error: { code: 'STORAGE_FAILED' } });
    expect(reads).toBe(3);
    expect(await started.app.ingestion.storage.stat(`${accepted.id}.pdf`)).not.toBeNull(); // never deleted for a store that did not answer
  }, 60_000);

  it('ends a read that stalls past the tick as a store that did not answer, not as a tick stopped at its hard limit: no attempt, no INGEST_INTERRUPTED, no deleted file', async () => {
    let reads = 0;
    const started = await serverWith(
      // One attempt would be all INGEST_MAX_ATTEMPTS lets a document have: a stalled read must not use it.
      { INGEST_MAX_ATTEMPTS: '1', INGEST_TICK_BUDGET_MS: '1000', INGEST_TICK_HARD_LIMIT_MS: '8000' },
      {
        storage: (inner) =>
          storageWith(inner, (_key, options) => {
            reads += 1;
            return new Promise<never>((_resolve, reject) => {
              options?.signal?.addEventListener(
                'abort',
                () => {
                  reject(new Error('the read was stopped'));
                },
                { once: true },
              );
            });
          }),
      },
    );
    const client = started.client();
    const accepted = summaryOf(await client.uploadFixture('text-en.pdf'));
    const before = Date.now();
    const answers = await tickUntilDone(client, accepted.id);
    expect(answers.map((answer) => answer.status)).toEqual(['running', 'running', 'failed']);
    expect(answers.at(-1)).toMatchObject({ error: { code: 'STORAGE_FAILED' } });
    expect(reads).toBe(3);
    // Each read was stopped by what the tick had left of its time (about 3 s of the 8, after the 5 s a unit keeps free), not by
    // the hard limit.
    expect(Date.now() - before).toBeLessThan(40_000);
    expect(await started.app.ingestion.storage.stat(`${accepted.id}.pdf`)).not.toBeNull();
  }, 90_000);

  it('keeps the file of a document that was interrupted again and again before any work on it began (it only ever waited for the store)', async () => {
    const started = await serverWith({ INGEST_MAX_ATTEMPTS: '3' }, {});
    const client = started.client();
    const accepted = summaryOf(await client.uploadFixture('text-en.pdf'));
    await db.query('UPDATE ingest_jobs SET attempts = 3 WHERE document_id = $1', [accepted.id]);
    const answer = await tickOnce(client, accepted.id);
    expect(answer).toMatchObject({ status: 'failed', error: { code: 'INGEST_INTERRUPTED' } });
    expect(await started.app.ingestion.storage.stat(`${accepted.id}.pdf`)).not.toBeNull();
  }, 60_000);
});

describe('passing troubles that are not the same', () => {
  it('count separately: two of the database and one of the embedding service do not fail a document, and each wait is longer only within one trouble', async () => {
    const budget = { failures: 2 };
    const options: FakeEmbeddingOptions = {
      failWith: new EmbeddingError('the service had a bad moment', { retryable: true, status: 503 }),
    };
    const started = await startServer(flakyDb(db, embedReservation, budget), testConfig({}), {
      embeddings: new FakeEmbeddings(options),
    });
    servers.push(started);
    const client = started.client();
    const accepted = summaryOf(await client.uploadFixture('text-en.pdf'));
    const waits: number[] = [];
    const answers = await tickUntilDone(client, accepted.id, {
      onTick: (answer) => {
        if (answer.retryAfterMs !== undefined) waits.push(answer.retryAfterMs);
        // After the database has had its two bad ticks and the service its one, the service is fine again.
        if (waits.length === 3) options.failWith = undefined;
      },
    });
    expect(waits).toEqual([3000, 9000, 3000]); // the third is a different trouble: its first, not a third in a row
    expect(answers.at(-1)?.status).toBe('ready');
  }, 120_000);
});

describe('a tick that no longer holds its job', () => {
  async function failing(): Promise<{
    deps: TickDeps;
    row: NonNullable<Awaited<ReturnType<typeof documentsRepo.findById>>>;
    lease: string;
    storage: LocalDiskStorage;
  }> {
    const config = testConfig();
    const storage = new LocalDiskStorage(config.storageDir);
    const sessionId = await insertSession(db);
    const id = randomUUID();
    await storage.put(`${id}.pdf`, Buffer.from('%PDF-1.7 pretend'));
    await documentsRepo.insert(db, {
      id,
      sessionId,
      filename: 'a.pdf',
      byteSize: 16,
      sha256: 'x',
      pageCount: 1,
      storageKey: `${id}.pdf`,
      expiresAt: new Date(Date.now() + 3_600_000),
    });
    await ingestJobsRepo.create(db, id);
    const taken = await ingestJobsRepo.acquire(db, id, { leaseMs: 60_000, concurrency: 5 });
    if (taken.kind !== 'acquired') throw new Error('not acquired');
    const row = await documentsRepo.findById(db, id);
    if (row === null) throw new Error('no document');
    const deps = {
      db,
      storage,
      bytes: new DocumentBytes(storage, config.tmpDir),
      config: { ingestLeaseMs: 60_000 },
      log: { info: () => undefined, warn: () => undefined, error: () => undefined },
    } as unknown as TickDeps;
    return { deps, row, lease: taken.lease, storage };
  }

  it('cannot fail a document that another tick has taken over: nothing is recorded and the file stays', async () => {
    const { deps, row, storage } = await failing();
    const recorded = await failDocument(deps, row, new AppError('PDF_UNREADABLE', 'damaged'), {
      lease: randomUUID(), // the lease of a tick that was taken over: not the job's
    });
    expect(recorded).toBe(false);
    expect(await documentsRepo.findById(db, row.id)).toMatchObject({ status: 'processing' });
    expect(await ingestJobsRepo.find(db, row.id)).not.toBeNull();
    expect(await storage.stat(row.storage_key)).not.toBeNull();
  });

  it('fails it while it holds the job, deleting the file for a verdict and keeping it when told to', async () => {
    const verdict = await failing();
    expect(
      await failDocument(verdict.deps, verdict.row, new AppError('PDF_UNREADABLE', 'damaged'), {
        lease: verdict.lease,
      }),
    ).toBe(true);
    expect(await documentsRepo.findById(db, verdict.row.id)).toMatchObject({ status: 'failed' });
    expect(await verdict.storage.stat(verdict.row.storage_key)).toBeNull();

    const passing = await failing();
    expect(
      await failDocument(passing.deps, passing.row, new AppError('RATE_LIMITED', 'busy'), {
        lease: passing.lease,
        keepFile: true,
      }),
    ).toBe(true);
    expect(await passing.storage.stat(passing.row.storage_key)).not.toBeNull();
  });
});

describe('a tick that cannot extend its lease', () => {
  it('stops when its renewals have failed for as long as the lease lasts, and fails nothing (another tick may hold the job by now)', async () => {
    const budget = { failures: 1_000_000 };
    const renewal = (sql: string): boolean => sql.includes('SET lease_until = (now()');
    const gate = new Gate();
    const held = await startServer(
      flakyDb(db, renewal, budget),
      testConfig({ INGEST_TICK_BUDGET_MS: '45000', INGEST_LEASE_MS: '1000' }),
      { embeddings: new FakeEmbeddings({ onPassages: gate.hold }) },
    );
    servers.push(held);
    const client = held.client();
    const accepted = summaryOf(await client.uploadFixture('text-en.pdf'));
    const before = Date.now();
    // The embedding step holds for good (the gate never opens): only the lease can end this tick, and its renewals all fail.
    const answer = await tickOnce(client, accepted.id);
    expect(Date.now() - before).toBeLessThan(15_000); // it did not wait for the gate: the lease ran out and the tick let go
    expect(answer.status).toBe('running');
    expect(budget.failures).toBeLessThan(1_000_000); // the renewals were tried, and failed
    const job = await ingestJobsRepo.find(db, accepted.id);
    expect(job).toMatchObject({ lease_id: null });
    expect((await detailOf(client, accepted.id)).status).toBe('processing');
    expect(await held.app.ingestion.storage.stat(`${accepted.id}.pdf`)).not.toBeNull();
  }, 60_000);
});

describe('the run of pages given up on, over the ticks of a document', () => {
  const failure = (pageNumber: number): { pageNumber: number; reason: 'timeout'; message: string } => ({
    pageNumber,
    reason: 'timeout',
    message: 'the page took too long',
  });

  it('is the pages given up on in a row that end right before the page a tick starts at', () => {
    expect(trailingFailureRun([], 1)).toBe(0);
    expect(trailingFailureRun([failure(1), failure(2)], 3)).toBe(2);
    expect(trailingFailureRun([failure(1), failure(2), failure(3), failure(4)], 5)).toBe(4);
    // A page that was read in between ends the run: pages 2 and 3 failed, page 4 was read, the next tick starts at 5.
    expect(trailingFailureRun([failure(2), failure(3)], 5)).toBe(0);
    expect(trailingFailureRun([failure(1), failure(3), failure(4)], 5)).toBe(2);
    // Whatever the order they were recorded in.
    expect(trailingFailureRun([failure(4), failure(2), failure(3)], 5)).toBe(3);
  });

  it('seeds the ledger of a tick, which gives up with the run of the earlier ticks counted', () => {
    const ledger = new PageLedger<unknown>([6, 7, 8, 9, 10]);
    ledger.seedFailureRun(4, 5);
    expect(ledger.shouldGiveUp()).toBe(false);
    ledger.fail(6, 'timeout', 'x'); // the fifth in a row, over two ticks
    expect(ledger.shouldGiveUp()).toBe(true);
    expect(ledger.consecutiveFailures).toBe(5);
    expect(ledger.lastFailedPage).toBe(6);
    // A page that is read ends the run.
    const other = new PageLedger<unknown>([6, 7]);
    other.seedFailureRun(4, 5);
    other.complete(6, {});
    other.fail(7, 'timeout', 'x');
    expect(other.shouldGiveUp()).toBe(false);
  });
});
