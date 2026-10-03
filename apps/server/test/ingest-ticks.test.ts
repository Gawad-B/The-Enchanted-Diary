import { randomUUID } from 'node:crypto';
import {
  IngestTickResponseSchema,
  SessionDocumentResponseSchema,
  type IngestStage,
  type IngestTickResponse,
} from '@enchanted/shared';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createDb, type Db } from '../src/db/client.js';
import { chunksRepo } from '../src/db/repositories/chunks.js';
import { ingestJobsRepo } from '../src/db/repositories/ingest-jobs.js';
import { EmbeddingError, type PassageOptions } from '../src/embeddings/provider.js';
import { FakeEmbeddings, Gate, type FakeEmbeddingOptions } from './doubles/fake-embeddings.js';
import {
  detailOf,
  errorOf,
  keepTicking,
  sessionOf,
  startServer,
  summaryOf,
  tickOnce,
  tickUntilDone,
  waitForDocument,
  waitUntil,
  type Client,
  type TestServer,
} from './http-helpers.js';
import { resetCounters, testConfig } from './helpers.js';

/*
 * The tick-based ingestion end to end: the real server, real worker threads, PGlite with the real migrations, a fake embedding
 * model. A tick budget of one second (the least there is) makes each tick do about one unit of work, so that the progress, the
 * hand-over between ticks and the recovery from a tick that died can be looked at.
 */

let db: Db;
const servers: TestServer[] = [];

beforeAll(async () => {
  db = await createDb(testConfig());
});
afterEach(async () => {
  await Promise.all(servers.splice(0).map((started) => started.close()));
  await resetCounters(db);
  await db.query('DELETE FROM documents'); // what one test left reading must not fill the line for the next
});
afterAll(async () => {
  await db.close();
});

const SMALL_TICKS = { INGEST_TICK_BUDGET_MS: '1000' };
/** Two servers that must accept each other's cookies sign them with the same secret. */
const SECRET = { SESSION_SECRET: 'tick-test-secret-tick-test-secret-0123456789' };

async function server(
  env: Record<string, string> = {},
  embeddings: FakeEmbeddings = new FakeEmbeddings(),
): Promise<TestServer> {
  const started = await startServer(db, testConfig(env), { embeddings });
  servers.push(started);
  return started;
}

/** An embedding model that also remembers the titles it was given with each batch of passages. */
class TitleRecordingEmbeddings extends FakeEmbeddings {
  readonly titles: (string | null | undefined)[][] = [];

  override embedPassages(
    texts: readonly string[],
    signal?: AbortSignal,
    options?: PassageOptions,
  ): Promise<number[][]> {
    this.titles.push([...(options?.titles ?? [])]);
    return super.embedPassages(texts, signal);
  }
}

/**
 * The counters are fixed windows aligned to the clock (a minute): a test that counts requests within one must not straddle two.
 * Waits for the next window when fewer than five seconds of this one are left.
 */
async function untilWindowHasRoom(minute = 60_000, needMs = 5000): Promise<void> {
  const left = minute - (Date.now() % minute);
  if (left < needMs) await new Promise((resolve) => setTimeout(resolve, left + 50));
}

const count = async (sql: string, params: unknown[]): Promise<number> =>
  (await db.query<{ n: number }>(sql, params)).rows[0]?.n ?? -1;

describe('the ticks of a document', () => {
  it('walk through the stages with real progress and end with the ready document', async () => {
    const started = await server(SMALL_TICKS);
    const client = started.client();
    const accepted = summaryOf(await client.uploadFixture('text-en.pdf'));
    const answers = await tickUntilDone(client, accepted.id);

    // The contract: every answer parses, the last one is the finished document.
    for (const answer of answers) IngestTickResponseSchema.parse(answer);
    const last = answers.at(-1);
    expect(last?.status).toBe('ready');
    expect(last?.document).toMatchObject({ id: accepted.id, status: 'ready', chunkCount: 5, pageCount: 5 });
    expect(last?.progress).toEqual({ stage: 'ready', completed: 1, total: 1, unit: 'steps' });
    expect(answers.length).toBeGreaterThan(3); // a one-second budget: no tick does it all

    const stages: IngestStage[] = [];
    for (const answer of answers)
      if (stages.at(-1) !== answer.progress.stage) stages.push(answer.progress.stage);
    const order: IngestStage[] = ['validating', 'parsing', 'analyzing', 'chunking', 'embedding', 'ready'];
    // Whatever a tick got to, in this order and never back.
    expect(stages).toEqual(order.filter((stage) => stages.includes(stage)));
    expect(stages).toContain('parsing');
    expect(stages).toContain('ready');

    // Real counts: pages while parsing, never more done than there are.
    const progress = answers.map((answer) => answer.progress);
    for (const step of progress) expect(step.completed).toBeLessThanOrEqual(step.total);
    const parsing = progress.filter((step) => step.stage === 'parsing');
    expect(parsing.every((step) => step.unit === 'pages' && step.total === 5)).toBe(true);
    expect(parsing.map((step) => step.completed)).toEqual(
      [...parsing.map((step) => step.completed)].sort((a, b) => a - b),
    );
    // (A tick that finishes the analysis may go straight on to the end: the embedding stage need not be seen.)
    const embedding = progress.filter((step) => step.stage === 'embedding');
    expect(embedding.every((step) => step.unit === 'chunks' && step.total === 5)).toBe(true);

    // The job and its scratch data are gone; the document keeps its pages, chunks and embeddings.
    expect(await ingestJobsRepo.find(db, accepted.id)).toBeNull();
    expect(
      await count('SELECT count(*)::int AS n FROM ingest_stage_data WHERE document_id = $1', [accepted.id]),
    ).toBe(0);
    expect(
      await count('SELECT count(*)::int AS n FROM document_pages WHERE document_id = $1', [accepted.id]),
    ).toBe(5);
    expect((await detailOf(client, accepted.id)).status).toBe('ready');
  }, 120_000);

  it('report the direction of an Arabic document as soon as the analysis knows it', async () => {
    // A tick is held in the embedding step, after the analysis: the direction is known, the document is not ready.
    const gate = new Gate();
    const started = await server(SMALL_TICKS, new FakeEmbeddings({ onPassages: gate.hold }));
    const client = started.client();
    const accepted = summaryOf(await client.uploadFixture('arabic.pdf'));
    const answers: IngestTickResponse[] = [];
    const ticking = tickUntilDone(client, accepted.id, { onTick: (answer) => void answers.push(answer) });
    await waitUntil(() => gate.entered > 0, 'a tick to reach the embedding step');
    const while_ = IngestTickResponseSchema.parse(
      (await client.get(`/api/documents/${accepted.id}/progress`)).json(),
    );
    expect(while_).toMatchObject({ status: 'running', progress: { stage: 'embedding', direction: 'rtl' } });
    // Before the analysis there is nothing to report (the column holds its default, which is not evidence).
    const early = answers.filter((answer) => ['validating', 'parsing'].includes(answer.progress.stage));
    expect(early.every((answer) => answer.progress.direction === undefined)).toBe(true);
    gate.open();
    expect((await ticking).at(-1)?.status).toBe('ready');
  }, 120_000);

  it('go on where a previous process left off: a new server finishes what the old one started', async () => {
    const first = await server({ ...SMALL_TICKS, ...SECRET });
    const client = first.client();
    const accepted = summaryOf(await client.uploadFixture('text-en.pdf'));
    // A few ticks, then the process goes away (as an instance of a function does).
    let answer = await tickOnce(client, accepted.id);
    while (answer.progress.stage !== 'parsing' || answer.progress.completed < 2)
      answer = await tickOnce(client, accepted.id);
    expect(answer.status).toBe('running');
    const done = answer.progress.completed;
    await first.close();
    servers.splice(servers.indexOf(first), 1);

    // The same files and secret: a new process of the same deployment.
    const second = await server({ ...SMALL_TICKS, ...SECRET, STORAGE_DIR: first.config.storageDir });
    const again = second.client();
    again.cookie = client.cookie;
    const resumed = await tickOnce(again, accepted.id);
    // It did not start over: it is at or beyond where the first process got to.
    expect(
      resumed.progress.stage === 'parsing' ? resumed.progress.completed : Infinity,
    ).toBeGreaterThanOrEqual(done);
    const rest = await tickUntilDone(again, accepted.id);
    expect(rest.at(-1)?.status).toBe('ready');
    const ready = await detailOf(again, accepted.id);
    expect(ready).toMatchObject({ status: 'ready', pageCount: 5, chunkCount: 5, primaryLanguage: 'en' });
    expect(ready.pages.map((page) => page.extraction)).toEqual(['text', 'text', 'text', 'text', 'text']);
  }, 120_000);

  it('give the document, and so the client, back to a session that reloads the page while it is being read', async () => {
    const started = await server(SMALL_TICKS);
    const client = started.client();
    const accepted = summaryOf(await client.uploadFixture('text-en.pdf'));
    await tickOnce(client, accepted.id);
    const session = SessionDocumentResponseSchema.parse((await client.get('/api/session/document')).json());
    expect(session.document).toMatchObject({ id: accepted.id, status: 'processing' });
    // A read of the progress changes nothing and works for a second tab.
    const before = await db.query(
      'SELECT stage, progress_completed, updated_at FROM documents WHERE id = $1',
      [accepted.id],
    );
    const polled = IngestTickResponseSchema.parse(
      (await client.get(`/api/documents/${accepted.id}/progress`)).json(),
    );
    expect(polled.status).toBe('running');
    expect(
      await db.query('SELECT stage, progress_completed, updated_at FROM documents WHERE id = $1', [
        accepted.id,
      ]),
    ).toEqual(before);
    expect((await tickUntilDone(client, accepted.id)).at(-1)?.status).toBe('ready');
    const finished = IngestTickResponseSchema.parse(
      (await client.get(`/api/documents/${accepted.id}/progress`)).json(),
    );
    expect(finished.status).toBe('ready');
    expect(finished.document?.id).toBe(accepted.id);
  }, 120_000);

  it('are refused for another session, an unknown document and, over the limit, with a Retry-After', async () => {
    const started = await server({ TICKS_PER_MINUTE: '3' });
    const client = started.client();
    const accepted = summaryOf(await client.uploadFixture('text-en.pdf'));
    const stranger = started.client();
    expect((await stranger.request('POST', `/api/documents/${accepted.id}/tick`)).statusCode).toBe(404);
    expect((await stranger.get(`/api/documents/${accepted.id}/progress`)).statusCode).toBe(404);
    // (A tick for a document that is not there is counted for the session that asked, before the 404: another client asks.)
    expect((await started.client().request('POST', `/api/documents/${randomUUID()}/tick`)).statusCode).toBe(
      404,
    );
    // Quick ticks (the job is parked: they do no work), well inside one fixed minute of the counter: a window that ended in the
    // middle of the test would reset the count and the fourth would not be refused.
    await db.query(`UPDATE ingest_jobs SET parked_until = now() + interval '1 hour' WHERE document_id = $1`, [
      accepted.id,
    ]);
    await untilWindowHasRoom();
    const statuses: number[] = [];
    for (let i = 0; i < 5; i += 1)
      statuses.push((await client.request('POST', `/api/documents/${accepted.id}/tick`)).statusCode);
    // Three ticks a minute: the fourth is refused.
    expect(statuses).toEqual([200, 200, 200, 429, 429]);
    const refused = await client.request('POST', `/api/documents/${accepted.id}/tick`);
    expect(errorOf(refused).code).toBe('RATE_LIMITED');
    expect(refused.headers['retry-after']).toBeDefined();
    // What was counted is what the counter says: three ticks, the refusals took nothing.
    const counted = await db.query<{ count: number }>(
      `SELECT count FROM rate_counters WHERE key = $1 ORDER BY window_start DESC LIMIT 1`,
      [`ticks:${await sessionOf(client)}`],
    );
    expect(counted.rows[0]?.count).toBe(3);
    await started.app.ingestion.service.removeDocument(accepted.id);
  }, 60_000);
});

describe('two ticks at once', () => {
  it('leave exactly one working: the others return the progress and ask to come back', async () => {
    const gate = new Gate();
    const started = await server({}, new FakeEmbeddings({ onPassages: gate.hold }));
    const client = started.client();
    const accepted = summaryOf(await client.uploadFixture('text-en.pdf'));
    const working = tickOnce(client, accepted.id); // reaches the embedding step and waits there
    await waitUntil(() => gate.entered > 0, 'the first tick to reach the embedding step');
    const others = await Promise.all([1, 2, 3].map(() => tickOnce(client, accepted.id)));
    for (const other of others) {
      expect(other.status).toBe('running');
      expect(other.progress.stage).toBe('embedding');
      expect(other.retryAfterMs).toBeGreaterThan(0);
    }
    expect(gate.entered).toBe(1); // nobody else embedded anything
    gate.open();
    expect((await working).status).toBe('ready');
    expect(
      await count(
        'SELECT count(*)::int AS n FROM chunk_embeddings e JOIN document_chunks c ON c.id = e.chunk_id WHERE c.document_id = $1',
        [accepted.id],
      ),
    ).toBe(5);
  }, 120_000);
});

describe('a tick that dies', () => {
  /** What an instance that is stopped in the middle of a tick leaves: a lease nobody gives back. */
  async function abandonLease(id: string, attempts?: number): Promise<void> {
    await db.query(
      `UPDATE ingest_jobs SET lease_id = $2, lease_until = now() - interval '1 second', attempts = COALESCE($3, attempts) WHERE document_id = $1`,
      [id, randomUUID(), attempts ?? null],
    );
  }

  it('is replaced by the next tick once its lease has run out, and the document is read to the end', async () => {
    const started = await server(SMALL_TICKS);
    const client = started.client();
    const accepted = summaryOf(await client.uploadFixture('text-en.pdf'));
    await tickOnce(client, accepted.id);
    await tickOnce(client, accepted.id);
    // While the lease is live nobody else may work.
    await db.query(
      `UPDATE ingest_jobs SET lease_id = $2, lease_until = now() + interval '1 minute' WHERE document_id = $1`,
      [accepted.id, randomUUID()],
    );
    expect((await tickOnce(client, accepted.id)).retryAfterMs).toBeGreaterThan(0);
    await abandonLease(accepted.id);
    const taken = await tickOnce(client, accepted.id);
    expect(['running', 'ready']).toContain(taken.status);
    expect((await tickUntilDone(client, accepted.id)).at(-1)?.status ?? taken.status).toBe('ready');
    expect((await detailOf(client, accepted.id)).chunkCount).toBe(5);
  }, 120_000);

  it('does not count against the document once a later tick has saved something (the run of dead ticks ends)', async () => {
    const started = await server(SMALL_TICKS);
    const client = started.client();
    const accepted = summaryOf(await client.uploadFixture('text-en.pdf'));
    await tickOnce(client, accepted.id);
    await abandonLease(accepted.id, 1);
    await tickOnce(client, accepted.id);
    expect((await ingestJobsRepo.find(db, accepted.id))?.attempts).toBe(0);
  }, 60_000);

  it('gives the document up when it keeps happening (INGEST_MAX_ATTEMPTS), cleaning up after it', async () => {
    const started = await server({ ...SMALL_TICKS, INGEST_MAX_ATTEMPTS: '3' });
    const client = started.client();
    const accepted = summaryOf(await client.uploadFixture('text-en.pdf'));
    await tickOnce(client, accepted.id);
    await abandonLease(accepted.id, 2); // two ticks died already; this lease is the third
    const answer = await tickOnce(client, accepted.id);
    expect(answer.status).toBe('failed');
    expect(answer.error).toMatchObject({ code: 'INGEST_INTERRUPTED' });
    expect(await ingestJobsRepo.find(db, accepted.id)).toBeNull();
    expect(
      await count('SELECT count(*)::int AS n FROM ingest_stage_data WHERE document_id = $1', [accepted.id]),
    ).toBe(0);
    expect(await started.app.ingestion.storage.stat(`${accepted.id}.pdf`)).toBeNull();
    expect((await detailOf(client, accepted.id)).status).toBe('failed');
  }, 60_000);

  it('is not a failure when it ran into its hard limit with an embedding batch that outlasted it: the batch is asked for again by the next tick', async () => {
    const gate = new Gate();
    const started = await server(
      { INGEST_TICK_BUDGET_MS: '1000', INGEST_TICK_HARD_LIMIT_MS: '8000' },
      new FakeEmbeddings({ onPassages: gate.hold }),
    );
    const client = started.client();
    const accepted = summaryOf(await client.uploadFixture('text-en.pdf'));
    let answer = await tickOnce(client, accepted.id);
    while (answer.progress.stage !== 'embedding') answer = await tickOnce(client, accepted.id);
    // This tick holds in the embedding step: the call is bounded by what is left of the tick (3 s of the 8, after a margin of
    // 5), not left to run into the hard limit with nothing saved.
    const asked = Date.now();
    answer = await tickOnce(client, accepted.id);
    expect(Date.now() - asked).toBeLessThan(7000);
    expect(answer).toMatchObject({ status: 'running', progress: { stage: 'embedding' } });
    // It counts as a tick that failed for a passing reason, not as an attempt, and the lease is back. (The tick that first
    // reached the embedding step may have been held by the gate too, when it still had time: that is one more, and the third
    // would end the document.)
    const job = await ingestJobsRepo.find(db, accepted.id);
    expect(job).toMatchObject({ lease_id: null, attempts: 0 });
    const transient = (job?.cursor as { transient: number }).transient;
    expect(transient).toBeGreaterThanOrEqual(1);
    expect(transient).toBeLessThan(3);
    // Each tick in a row waits three times longer than the one before (5 s, 15 s): the wait says how many there were.
    expect(answer.retryAfterMs).toBe(5000 * 3 ** (transient - 1));
    expect(await started.app.ingestion.storage.stat(`${accepted.id}.pdf`)).not.toBeNull();
    gate.open();
    expect((await tickUntilDone(client, accepted.id)).at(-1)?.status).toBe('ready');
  }, 120_000);
});

describe('a daily quota that is used up', () => {
  it('parks the document until the quota starts again, and the next ticks do nothing', async () => {
    const options: FakeEmbeddingOptions = {
      failWith: new EmbeddingError('quota', { rateLimited: true, dailyQuota: true, status: 429 }),
    };
    const embeddings = new FakeEmbeddings(options);
    const started = await server({}, embeddings);
    const client = started.client();
    const accepted = summaryOf(await client.uploadFixture('text-en.pdf'));
    const parked = (await tickUntilDone(client, accepted.id)).at(-1);
    expect(parked).toMatchObject({
      status: 'parked',
      progress: { stage: 'embedding', completed: 0, total: 5, detail: 'daily quota reached' },
    });
    // The quota starts again at the next midnight Pacific: between a minute and a day and a bit from now.
    expect(parked?.retryAfterMs).toBeGreaterThan(0);
    expect(parked?.retryAfterMs).toBeLessThanOrEqual(25 * 3_600_000);

    // Nothing is attempted meanwhile: the model is not asked, the document is still the session's.
    const asked = embeddings.passageCalls;
    for (let i = 0; i < 3; i += 1) expect((await tickOnce(client, accepted.id)).status).toBe('parked');
    expect(embeddings.passageCalls).toBe(asked);
    expect(
      IngestTickResponseSchema.parse((await client.get(`/api/documents/${accepted.id}/progress`)).json())
        .status,
    ).toBe('parked');
    expect(
      SessionDocumentResponseSchema.parse((await client.get('/api/session/document')).json()).document,
    ).toMatchObject({ id: accepted.id, status: 'processing' });

    // The quota is back (the time passes): nothing on the server resumes the job, the next tick of the client finds the parking
    // over and the document is finished.
    options.failWith = undefined;
    await db.query(
      `UPDATE ingest_jobs SET parked_until = now() - interval '1 minute' WHERE document_id = $1`,
      [accepted.id],
    );
    expect((await tickUntilDone(client, accepted.id)).at(-1)?.status).toBe('ready');
    expect((await detailOf(client, accepted.id)).chunkCount).toBe(5);
  }, 120_000);

  it('parks a document whose day’s budget of embedded texts is spent, without asking the model', async () => {
    const embeddings = new FakeEmbeddings();
    const started = await server({ GEMINI_DAILY_BUDGET_EMBED: '2', ...SECRET }, embeddings);
    const client = started.client();
    const accepted = summaryOf(await client.uploadFixture('text-en.pdf')); // five chunks, a budget of two texts
    const parked = (await tickUntilDone(client, accepted.id)).at(-1);
    expect(parked).toMatchObject({ status: 'parked', progress: { detail: 'daily quota reached' } });
    expect(embeddings.passageCalls).toBe(0);
    // Tomorrow's budget is there: the same document goes on to the end.
    await resetCounters(db);
    await db.query(`UPDATE ingest_jobs SET parked_until = NULL WHERE document_id = $1`, [accepted.id]);
    const bigger = await startServer(db, testConfig({ GEMINI_DAILY_BUDGET_EMBED: '50', ...SECRET }), {
      embeddings,
    });
    servers.push(bigger);
    const again = bigger.client();
    again.cookie = client.cookie;
    expect((await tickUntilDone(again, accepted.id)).at(-1)?.status).toBe('ready');
  }, 120_000);

  it('does not park for a rate limit that is not the daily quota: the client is asked to come back, and after five it is a failure', async () => {
    const options: FakeEmbeddingOptions = {
      failWith: new EmbeddingError('slow down', { rateLimited: true, status: 429 }),
    };
    const started = await server({}, new FakeEmbeddings(options));
    const client = started.client();
    const accepted = summaryOf(await client.uploadFixture('text-en.pdf'));
    let answer = await tickOnce(client, accepted.id);
    while (answer.progress.stage !== 'embedding' || answer.retryAfterMs === undefined)
      answer = await tickOnce(client, accepted.id);
    expect(answer).toMatchObject({ status: 'running', retryAfterMs: 20_000 });
    for (let i = 0; i < 3; i += 1) expect((await tickOnce(client, accepted.id)).status).toBe('running');
    const last = await tickOnce(client, accepted.id);
    expect(last).toMatchObject({ status: 'failed', error: { code: 'RATE_LIMITED' } });
    // A rate limit says nothing about the file: it is kept (retention removes it), never deleted for it.
    expect(await started.app.ingestion.storage.stat(`${accepted.id}.pdf`)).not.toBeNull();
  }, 120_000);
});

describe('the passages that are embedded', () => {
  it('carry the title of their section, or the document’s name (gemini-embedding-2 embeds "title: ... | text: ...")', async () => {
    const embeddings = new TitleRecordingEmbeddings();
    const started = await server({}, embeddings);
    const client = started.client();
    const ready = await waitForDocument(client, summaryOf(await client.uploadFixture('text-en.pdf')).id);
    const chunks = await chunksRepo.forDocument(db, ready.id);
    expect(embeddings.titles.flat()).toEqual(chunks.map((chunk) => chunk.section_title ?? 'text-en.pdf'));
    expect(embeddings.titles.flat()).toContain('The Founding');
  }, 90_000);

  it('are embedded in the order of the document, a batch at a time, whatever the batch size', async () => {
    const started = await server({ EMBEDDING_BATCH_SIZE: '2' });
    const client = started.client();
    const ready = await waitForDocument(client, summaryOf(await client.uploadFixture('text-en.pdf')).id);
    expect(ready.chunkCount).toBe(5);
    expect(
      await count(
        'SELECT count(*)::int AS n FROM chunk_embeddings e JOIN document_chunks c ON c.id = e.chunk_id WHERE c.document_id = $1',
        [ready.id],
      ),
    ).toBe(5);
  }, 90_000);
});

describe('a document that fails', () => {
  it('ends with the code and nothing left behind: no job, no scratch data, no file', async () => {
    const started = await server();
    const client: Client = started.client();
    const accepted = summaryOf(await client.uploadFixture('empty.pdf'));
    const answers = await tickUntilDone(client, accepted.id);
    expect(answers.at(-1)).toMatchObject({
      status: 'failed',
      progress: { stage: 'failed' },
      error: { code: 'PDF_EMPTY' },
    });
    expect(await ingestJobsRepo.find(db, accepted.id)).toBeNull();
    expect(
      await count('SELECT count(*)::int AS n FROM ingest_stage_data WHERE document_id = $1', [accepted.id]),
    ).toBe(0);
    expect(await started.app.ingestion.storage.stat(`${accepted.id}.pdf`)).toBeNull();
    // Another tick on it only repeats the verdict.
    expect((await tickOnce(client, accepted.id)).status).toBe('failed');
  }, 60_000);
});

describe('keepTicking', () => {
  it('is what a browser tab does: it stops at a removed document', async () => {
    const started = await server();
    const client = started.client();
    const accepted = summaryOf(await client.uploadFixture('text-en.pdf'));
    await started.app.ingestion.service.removeDocument(accepted.id);
    expect((await keepTicking(client, accepted.id)).stoppedBy).toEqual({
      statusCode: 404,
      code: 'DOCUMENT_NOT_FOUND',
    });
  });
});
