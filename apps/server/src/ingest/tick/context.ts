import type { IngestStage } from '@enchanted/shared';
import type { Config } from '../../config.js';
import { AppError } from '../../http/errors.js';
import type { Db, Queryable } from '../../db/client.js';
import { documentsRepo, type DocumentRow, type ProgressRecord } from '../../db/repositories/documents.js';
import { ingestJobsRepo } from '../../db/repositories/ingest-jobs.js';
import type { EmbeddingProvider } from '../../embeddings/provider.js';
import type { GeminiBudgets } from '../../limits/gemini-budget.js';
import { nextQuotaReset } from '../../limits/quota-day.js';
import type { OcrAvailability } from '../../ocr/availability.js';
import type { StorageProvider } from '../../storage/provider.js';
import type { DocumentBytes } from '../bytes.js';
import type { JobCursor } from '../cursor.js';
import type { OcrStageConfig } from '../ocr-stage.js';
import type { IngestWorkers } from '../worker/host.js';

/** The configuration a tick reads. */
export type TickConfig = OcrStageConfig &
  Pick<
    Config,
    | 'maxPages'
    | 'ingestConcurrency'
    | 'ingestJobTimeoutMs'
    | 'ingestTickBudgetMs'
    | 'ingestLeaseMs'
    | 'ingestTickHardLimitMs'
    | 'ingestMaxAttempts'
    | 'ocrMinChars'
    | 'chunkTargetChars'
    | 'chunkMaxChars'
    | 'chunkMinChars'
    | 'chunkOverlapChars'
    | 'embeddingBatchSize'
    | 'modelCacheDir'
    | 'storageDir'
    | 'tmpDir'
  >;

export interface TickLogger {
  warn(object: object, message: string): void;
  error(object: object, message: string): void;
  info(object: object, message: string): void;
}

/** Everything the steps of a tick work with. */
export interface TickDeps {
  db: Db;
  storage: StorageProvider;
  workers: IngestWorkers;
  /** Whether OCR can be used (a cached answer; the engine itself runs in the worker threads). */
  ocr: OcrAvailability;
  embeddings: EmbeddingProvider;
  budgets: GeminiBudgets;
  bytes: DocumentBytes;
  config: TickConfig;
  log: TickLogger;
}

/** The tick no longer holds the job: it was removed, or its lease ran out and someone else took it. Unwinds the tick. */
export class LeaseLostError extends Error {
  constructor() {
    super('The ingestion job is no longer held by this tick');
    this.name = 'LeaseLostError';
  }
}

/**
 * A failure that may pass by itself (the database or the store did not answer, a service is rate limiting): the tick answers
 * "running, ask again in `retryAfterMs`" and counts it; the document fails only after `limit` such ticks in a row, with
 * `failure`, and its file is kept (a transient cause is never a verdict on the file).
 */
export class TransientTickError extends Error {
  constructor(
    message: string,
    readonly options: {
      /** How long the client waits before the next tick. */
      retryAfterMs: number;
      /** Ticks in a row this may cost before the document is given up on. */
      limit: number;
      /** What is said when it is. */
      failure: AppError;
      /** What the trouble is (`database`, `store`, `embedding-rate-limit`, ...): ticks in a row count only when it is the same. */
      kind: string;
      /**
       * Each tick in a row waits this many times longer than the one before (default 3: 3 s, 9 s, 27 s, never more than a
       * minute), so that an episode of a few seconds (a database restarting, a store with a bad minute) is ridden out and not
       * counted three times in ten seconds. 1: always `retryAfterMs`.
       */
      backoff?: number;
      cause?: unknown;
    },
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'TransientTickError';
  }
}

/** What a client waits (to start with) after a tick in which the store did not answer, and how many such ticks in a row end the document. */
const STORE_RETRY_MS = 3000;
const STORE_TICK_LIMIT = 3;

/** The part of a tick's hard limit that a unit of work leaves free, so that it can wind down and save before the tick is stopped. */
export const HARD_LIMIT_MARGIN_MS = 5000;

/** What a step reports to the loop of the tick. */
export type StepResult =
  /** The step did its unit of work; the next call goes on (the tick's time is checked in between). */
  | { kind: 'again' }
  /** Nothing more can be done right now, though nothing is wrong (a rate limit): the client should come back in a moment. */
  | { kind: 'wait'; retryAfterMs: number }
  /** A Gemini daily quota is used up: the job is parked until the quota starts again. */
  | { kind: 'parked' }
  /** The document is ready. */
  | { kind: 'finished' };

export const AGAIN: StepResult = { kind: 'again' };

/** How far a stage has come, in the counts of its unit (the stage itself is the context's). */
export type StageProgress = Omit<ProgressRecord, 'stage'>;

/** One tick's view of its job: who it is, how long it may go on, how to save what it did. */
export class TickContext {
  readonly startedAt = Date.now();
  stage: IngestStage;
  cursor: JobCursor;
  private readonly baseWorkMs: number;
  private loaded: Promise<Uint8Array> | null = null;
  /** When the lease was last extended by a save of this tick (the runner's own renewals are the other source). */
  touchedAt = Date.now();

  constructor(
    readonly deps: TickDeps,
    /** The document row as it was when the tick began (its `page_count`, `sha256` and key do not change). */
    readonly row: DocumentRow,
    stage: IngestStage,
    cursor: JobCursor,
    readonly leaseId: string,
    /** Aborted when the document is removed, the lease is lost, the server shuts down or the tick's hard limit is reached. */
    readonly signal: AbortSignal,
  ) {
    this.stage = stage;
    this.cursor = cursor;
    this.baseWorkMs = cursor.workMs;
  }

  get documentId(): string {
    return this.row.id;
  }

  /** The tick has used its time: no new unit of work is started (the one that runs is allowed to finish). */
  expired(): boolean {
    return Date.now() - this.startedAt >= this.deps.config.ingestTickBudgetMs;
  }

  /** Milliseconds the job has worked over all its ticks, this one's time so far included. */
  workMsNow(): number {
    return this.baseWorkMs + (Date.now() - this.startedAt);
  }

  /**
   * How long a unit of work may still take before the tick's hard limit, less `marginMs` to wind down and save in. A unit that
   * bounds itself by this (an OCR call, an embedding batch with its retries) ends by itself, and the tick saves what it did,
   * instead of being stopped with nothing saved.
   */
  msLeft(marginMs: number = HARD_LIMIT_MARGIN_MS): number {
    return Math.max(0, this.deps.config.ingestTickHardLimitMs - (Date.now() - this.startedAt) - marginMs);
  }

  /**
   * The tick's signal plus a deadline of `msLeft()`: for a unit of work that retries inside (a provider's own retries). When
   * the deadline is what stopped it, `capped()` says so (the signal of the tick itself did not abort). Call `done()` when the
   * unit is over.
   */
  cappedSignal(): { signal: AbortSignal; capped: () => boolean; done: () => void } {
    const deadline = new AbortController();
    const timer = setTimeout(
      () => deadline.abort(new DOMException('The tick is out of time', 'TimeoutError')),
      this.msLeft(),
    );
    return {
      signal: AbortSignal.any([this.signal, deadline.signal]),
      capped: () => deadline.signal.aborted && !this.signal.aborted,
      done: () => clearTimeout(timer),
    };
  }

  /**
   * The document's file, read (and checked against its hash) once per tick. The read is bounded by what is left of the tick
   * and stopped with it: a store that does not answer in time is a passing trouble of the store (a transient tick), never a
   * tick stopped at its hard limit with nothing said, and never a reason to delete the file.
   */
  bytes(): Promise<Uint8Array> {
    this.loaded ??= this.loadBytes();
    return this.loaded;
  }

  private async loadBytes(): Promise<Uint8Array> {
    const unit = this.cappedSignal();
    try {
      return await this.deps.bytes.load(this.row, unit.signal);
    } catch (error) {
      if (unit.capped()) {
        throw new TransientTickError('the store did not answer within the tick', {
          retryAfterMs: STORE_RETRY_MS,
          limit: STORE_TICK_LIMIT,
          failure: new AppError(
            'STORAGE_FAILED',
            'The uploaded document could not be read back from storage.',
          ),
          kind: 'store',
          cause: error,
        });
      }
      throw error;
    } finally {
      unit.done();
    }
  }

  /**
   * Saves what the tick has done so far, atomically: the stage and cursor of the job, the progress of the document, and
   * whatever `writes` adds (the page just extracted, the chunks just stored). The lease is renewed by it. Throws
   * LeaseLostError when the job is no longer this tick's, which also covers "the document was removed".
   */
  async commit(update: {
    stage?: IngestStage;
    progress: StageProgress;
    writes?: (tx: Queryable) => Promise<void>;
    /**
     * Only a label (the stage is named before the work that may fail begins): not a unit of work, so it does not end the run
     * of failed ticks (`transient`, `attempts`). Without this a store that never answers would reset both on every tick, and
     * the document would be asked again for ever.
     */
    label?: boolean;
  }): Promise<void> {
    if (update.stage !== undefined) this.stage = update.stage;
    this.cursor.workMs = this.workMsNow();
    if (update.label !== true) {
      // A unit of work was saved: the run of ticks that failed for a passing reason is over.
      this.cursor.transient = 0;
      delete this.cursor.transientCause;
    }
    await this.deps.db.transaction(async (tx) => {
      // The document row is locked FIRST and the job row second: removing a document (DELETE, a replaced upload, a session
      // reset, retention) locks them in that order too, so the two cannot wait for each other. A write of a tick that has
      // lost its lease is rolled back by the error below, whatever it did before.
      if (
        !(await documentsRepo.setProgress(tx, this.documentId, { ...update.progress, stage: this.stage }))
      ) {
        throw new LeaseLostError();
      }
      const held = await ingestJobsRepo.save(
        tx,
        this.documentId,
        this.leaseId,
        { stage: this.stage, cursor: this.cursor },
        this.deps.config.ingestLeaseMs,
        { keepAttempts: update.label === true },
      );
      if (!held) throw new LeaseLostError();
      await update.writes?.(tx);
    });
    this.touchedAt = Date.now();
  }

  /**
   * Stops the job until the Gemini quotas start again. The progress says why. `writes` (what the unit that ran into the
   * quota had got done) is saved in the same transaction.
   */
  async park(
    progress: StageProgress,
    detail: string,
    writes?: (tx: Queryable) => Promise<void>,
  ): Promise<StepResult> {
    this.cursor.workMs = this.workMsNow();
    const until = nextQuotaReset(new Date());
    await this.deps.db.transaction(async (tx) => {
      // Document first, job second (see `commit`).
      if (
        !(await documentsRepo.setProgress(tx, this.documentId, { ...progress, stage: this.stage, detail }))
      ) {
        throw new LeaseLostError();
      }
      const held = await ingestJobsRepo.save(
        tx,
        this.documentId,
        this.leaseId,
        { stage: this.stage, cursor: this.cursor },
        this.deps.config.ingestLeaseMs,
      );
      if (!held) throw new LeaseLostError();
      if (!(await ingestJobsRepo.park(tx, this.documentId, this.leaseId, until, detail))) {
        throw new LeaseLostError();
      }
      await writes?.(tx);
    });
    this.touchedAt = Date.now();
    return { kind: 'parked' };
  }
}
