import type { IngestStage, IngestTickResponse } from '@enchanted/shared';
import { documentsRepo, type DocumentRow } from '../../db/repositories/documents.js';
import { ingestJobsRepo, type IngestJobRow } from '../../db/repositories/ingest-jobs.js';
import { AppError } from '../../http/errors.js';
import { EMPTY_CURSOR, readCursor } from '../cursor.js';
import { DETAIL_TOOK_TOO_LONG, detailInterrupted } from '../detail.js';
import { isAbortError, toAppError, transientOf } from '../errors.js';
import { QUEUE_RETRY_MS, tickResponseOf } from '../progress.js';
import {
  TickContext,
  LeaseLostError,
  type StepResult,
  type TickDeps,
  type TransientTickError,
} from './context.js';
import { deletesFileFor, failDocument } from './finish.js';
import { analyzeStep } from './step-analyze.js';
import { embedStep } from './step-embed.js';
import { ocrStep } from './step-ocr.js';
import { parseStep, validateStep } from './step-parse.js';

/** How much longer each tick in a row that failed for the same passing reason is asked to wait, and the longest wait. */
const TRANSIENT_BACKOFF = 3;
const MAX_TRANSIENT_RETRY_MS = 60_000;

/** Another tick has the job: the client is asked to look again after this long. */
export const HELD_RETRY_MS = 1000;

type Step = (ctx: TickContext) => Promise<StepResult>;

/** The work of each stage of a job. */
const STEPS: Partial<Record<IngestStage, Step>> = {
  queued: validateStep,
  validating: validateStep,
  parsing: parseStep,
  ocr: ocrStep,
  analyzing: analyzeStep,
  chunking: analyzeStep,
  embedding: embedStep,
  storing: embedStep,
};

const removed = (): AppError => new AppError('DOCUMENT_NOT_FOUND', 'This document was removed.');

interface Running {
  documentId: string;
  controller: AbortController;
  finished: Promise<unknown>;
}

/** The three ways a tick can be stopped from outside, and what ended it. */
interface Stops {
  /** The document was removed, the lease was lost, or the server is shutting down. */
  controller: AbortController;
  /** The tick ran into its hard limit. */
  hardLimit: AbortController;
  /** The job has worked as long as INGEST_JOB_TIMEOUT_MS allows, over all its ticks. */
  jobDeadline: AbortController;
}

/**
 * Ingestion in ticks. A document is read in short steps, each one a request of the client: `tick` takes the job's lease (one
 * tick at a time per document, INGEST_CONCURRENCY documents at a time overall), does as much work as fits in
 * INGEST_TICK_BUDGET_MS, saves where it got to after every unit of work, and answers with the real progress. Whatever is
 * saved survives the tick: an instance that dies mid-tick costs the unit it was working on, and the lease it held runs out by
 * itself (INGEST_LEASE_MS). Removing the document stops a tick running in this process at once and any other at its next
 * save.
 */
export class TickRunner {
  /** The ticks running in this process, by their lease (two ticks of one document can overlap here if one lost its lease). */
  private readonly running = new Map<string, Running>();
  private closed = false;

  constructor(private readonly deps: TickDeps) {}

  /** The progress of a document as the database has it; reads only. */
  progress(row: DocumentRow): Promise<IngestTickResponse> {
    return tickResponseOf(this.deps.db, row);
  }

  async tick(documentId: string): Promise<IngestTickResponse> {
    const { db, config } = this.deps;
    const row = await documentsRepo.findById(db, documentId);
    if (row === null) throw removed();
    if (row.status !== 'processing' || this.closed) return tickResponseOf(db, row);
    // The copies of documents this instance keeps for its ticks: those of documents that were removed elsewhere go (at most
    // once a minute; nothing waits for it).
    void this.deps.bytes
      .sweep((ids) => documentsRepo.existingIds(db, ids))
      .catch((error: unknown) => {
        this.deps.log.warn({ err: error }, 'could not sweep the cached copies of documents');
      });

    let acquired = await ingestJobsRepo.acquire(db, documentId, {
      leaseMs: config.ingestLeaseMs,
      concurrency: config.ingestConcurrency,
    });
    if (acquired.kind === 'missing') {
      // A document that is processing always has a job; if the row is missing something went wrong between the two writes.
      // (A document that ended or was removed meanwhile gets none.)
      await ingestJobsRepo.createForProcessing(db, documentId);
      acquired = await ingestJobsRepo.acquire(db, documentId, {
        leaseMs: config.ingestLeaseMs,
        concurrency: config.ingestConcurrency,
      });
    }
    switch (acquired.kind) {
      case 'acquired':
        return this.work(row, acquired.job, acquired.lease);
      case 'held':
        return tickResponseOf(db, row, { job: acquired.job, retryAfterMs: HELD_RETRY_MS });
      case 'parked':
        return tickResponseOf(db, row, { job: acquired.job });
      case 'busy':
        return tickResponseOf(db, row, { job: acquired.job, retryAfterMs: QUEUE_RETRY_MS });
      case 'missing':
        return tickResponseOf(db, (await documentsRepo.findById(db, documentId)) ?? row);
    }
  }

  /** Stops the ticks of this document that run in this process, if any, and waits until they have let go. */
  async cancel(documentId: string): Promise<void> {
    const ticks = [...this.running.values()].filter((running) => running.documentId === documentId);
    for (const running of ticks) {
      running.controller.abort(new DOMException('The document was removed', 'AbortError'));
    }
    await Promise.all(ticks.map((running) => running.finished.catch(() => undefined)));
  }

  /** Stops every tick of this process (the server is shutting down). Later ticks only report the progress. */
  async close(): Promise<void> {
    this.closed = true;
    const all = [...this.running.values()];
    for (const running of all)
      running.controller.abort(new DOMException('The server is shutting down', 'AbortError'));
    await Promise.all(all.map((running) => running.finished.catch(() => undefined)));
  }

  private work(row: DocumentRow, job: IngestJobRow, lease: string): Promise<IngestTickResponse> {
    const { config } = this.deps;
    const controller = new AbortController();
    const hardLimit = new AbortController();
    const jobDeadline = new AbortController();
    const timer = setTimeout(
      () => hardLimit.abort(new DOMException('The tick took too long', 'TimeoutError')),
      config.ingestTickHardLimitMs,
    );
    // INGEST_JOB_TIMEOUT_MS is the time the job may work in all, over its ticks: what is left of it ends this one.
    const left = Math.max(0, config.ingestJobTimeoutMs - readCursor(job.cursor).workMs);
    const jobTimer = setTimeout(
      () => jobDeadline.abort(new DOMException('The ingestion took too long', 'TimeoutError')),
      left,
    );
    const finished = this.runTick(row, job, lease, { controller, hardLimit, jobDeadline }).finally(() => {
      clearTimeout(timer);
      clearTimeout(jobTimer);
      this.running.delete(lease);
    });
    this.running.set(lease, { documentId: row.id, controller, finished });
    return finished;
  }

  private async runTick(
    row: DocumentRow,
    job: IngestJobRow,
    lease: string,
    stops: Stops,
  ): Promise<IngestTickResponse> {
    const { db, config, log } = this.deps;
    const { controller, hardLimit, jobDeadline } = stops;
    const cursor = readCursor(job.cursor ?? EMPTY_CURSOR);
    const ctx = new TickContext(
      this.deps,
      row,
      job.stage,
      cursor,
      lease,
      AbortSignal.any([controller.signal, hardLimit.signal, jobDeadline.signal]),
    );
    // The lease is renewed while a long unit of work runs; if it cannot be (the job is gone, someone else holds it) the tick
    // stops. So does a tick that has not been able to extend its lease for as long as the lease lasts (the database does not
    // answer): another tick may hold the job by now, and this one must not go on believing it is the only one.
    let renewedAt = Date.now();
    const keepAlive = setInterval(
      () => {
        ingestJobsRepo.renew(db, row.id, lease, config.ingestLeaseMs).then(
          (held) => {
            if (held) renewedAt = Date.now();
            else controller.abort(new LeaseLostError());
          },
          (error: unknown) => {
            log.warn({ err: error, documentId: row.id }, 'could not renew the lease of a job');
            if (Date.now() - Math.max(renewedAt, ctx.touchedAt) >= config.ingestLeaseMs) {
              controller.abort(new LeaseLostError());
            }
          },
        );
      },
      Math.max(250, Math.floor(config.ingestLeaseMs / 3)),
    );
    keepAlive.unref();

    try {
      if (job.attempts >= config.ingestMaxAttempts) {
        throw new AppError(
          'INGEST_INTERRUPTED',
          'Reading this document was interrupted again and again; upload it again.',
          detailInterrupted(job.attempts),
        );
      }
      if (cursor.workMs > config.ingestJobTimeoutMs) {
        throw new AppError('PDF_UNREADABLE', 'The pages appear damaged or unreadable.', DETAIL_TOOK_TOO_LONG);
      }
      const result = await this.loop(ctx);
      const fresh = await documentsRepo.findById(db, row.id);
      if (fresh === null) throw removed();
      return await tickResponseOf(db, fresh, {
        ...(result.kind === 'wait' ? { retryAfterMs: result.retryAfterMs } : {}),
      });
    } catch (error) {
      return await this.afterFailure(ctx, row, lease, error, stops);
    } finally {
      clearInterval(keepAlive);
      // Gives the lease back so that the next tick need not wait for it to run out (a no-op once the job has ended).
      await ingestJobsRepo.release(db, row.id, lease).catch((error: unknown) => {
        log.warn({ err: error, documentId: row.id }, 'could not release the lease of a job');
      });
    }
  }

  /** Units of work until the tick is out of time, something else must happen (a wait, a parking) or the document is ready. */
  private async loop(ctx: TickContext): Promise<StepResult> {
    for (;;) {
      const step = STEPS[ctx.stage];
      if (step === undefined) throw new Error(`there is no work for the stage "${ctx.stage}"`);
      const result = await step(ctx);
      if (result.kind !== 'again' || ctx.expired()) return result;
    }
  }

  private async afterFailure(
    ctx: TickContext,
    row: DocumentRow,
    lease: string,
    thrown: unknown,
    stops: Stops,
  ): Promise<IngestTickResponse> {
    const { db, config, log } = this.deps;
    const { controller, hardLimit, jobDeadline } = stops;
    /** The document as the database has it now (the answer of a tick that failed nothing); 404 when it is gone. */
    const snapshot = async (): Promise<IngestTickResponse> => {
      const fresh = await documentsRepo.findById(db, row.id);
      if (fresh === null) throw removed();
      return tickResponseOf(db, fresh);
    };

    // Stopped from outside (the document was removed, the server is stopping, the lease went): the document decides.
    if (controller.signal.aborted || thrown instanceof LeaseLostError) return snapshot();
    // The job has worked as long as INGEST_JOB_TIMEOUT_MS allows over all its ticks.
    const timedOut = jobDeadline.signal.aborted;
    if (!timedOut && hardLimit.signal.aborted) {
      // The tick ran into its hard limit: nothing failed, what was saved is saved, the next tick goes on. But the time it
      // took is the job's (INGEST_JOB_TIMEOUT_MS and OCR_MAX_SECONDS count it) and the abort counts as an attempt, so that a
      // unit that always outlasts its tick ends the job (INGEST_MAX_ATTEMPTS) instead of repeating for ever.
      await ingestJobsRepo
        .releaseAborted(db, row.id, lease, {
          workMs: ctx.workMsNow(),
          ...(ctx.cursor.ocr === undefined ? {} : { ocrSpentMs: ctx.cursor.ocr.spentMs }),
        })
        .catch((error: unknown) => {
          log.warn({ err: error, documentId: row.id }, 'could not record an aborted tick');
        });
      return snapshot();
    }
    if (!timedOut && thrown instanceof AppError && thrown.code === 'DOCUMENT_NOT_FOUND') throw thrown;
    if (!timedOut && isAbortError(thrown)) return snapshot();

    const paths = [config.modelCacheDir, config.storageDir, config.tmpDir];
    const transient = timedOut ? null : transientOf(thrown, paths);
    if (transient !== null) return this.afterTransient(row, lease, transient, thrown, snapshot);

    const failure = timedOut
      ? new AppError('PDF_UNREADABLE', 'The pages appear damaged or unreadable.', DETAIL_TOOK_TOO_LONG)
      : toAppError(thrown, paths);
    if (failure.code === 'INTERNAL')
      log.error({ err: thrown, documentId: row.id }, 'ingestion failed unexpectedly');
    else log.info({ code: failure.code, documentId: row.id }, 'ingestion failed');
    // Only a verdict about the file itself deletes it: a quota, a rate limit, a store, a database or a service that failed says
    // nothing about the file (retention removes it).
    // (A document interrupted before any work on the PDF began only ever waited for the store: nothing is known against the file.)
    const beforeAnyWork = ctx.stage === 'queued' || ctx.stage === 'validating';
    await failDocument(this.deps, row, failure, {
      lease,
      keepFile: !deletesFileFor(failure.code) || (failure.code === 'INGEST_INTERRUPTED' && beforeAnyWork),
    });
    return snapshot();
  }

  /**
   * A failure that may pass: counted, and the client asked to come back (the lease goes back with the tick). After
   * `limit` of them in a row the document fails, with its file kept.
   */
  private async afterTransient(
    row: DocumentRow,
    lease: string,
    transient: TransientTickError,
    thrown: unknown,
    snapshot: () => Promise<IngestTickResponse>,
  ): Promise<IngestTickResponse> {
    const { db, log } = this.deps;
    const { retryAfterMs: first, limit, failure, kind, backoff = TRANSIENT_BACKOFF } = transient.options;
    const count = await ingestJobsRepo.recordTransient(db, row.id, lease, kind);
    if (count === null) return snapshot(); // not this tick's job any more
    if (count >= limit) {
      log.warn(
        { err: thrown, documentId: row.id, ticks: count },
        'ingestion failed after repeated passing failures',
      );
      await failDocument(this.deps, row, failure, { lease, keepFile: true });
      return snapshot();
    }
    log.warn(
      { err: thrown, documentId: row.id, ticks: count, kind },
      'a tick failed for a reason that may pass',
    );
    // Each tick in a row waits longer than the one before (3 s, 9 s, 27 s): a database restarting or a store with a bad minute is
    // ridden out, not counted three times in ten seconds.
    const retryAfterMs = Math.min(MAX_TRANSIENT_RETRY_MS, Math.round(first * backoff ** (count - 1)));
    const fresh = await documentsRepo.findById(db, row.id);
    if (fresh === null) throw removed();
    return tickResponseOf(db, fresh, { retryAfterMs });
  }
}
