import type { Config } from '../config.js';
import type { Db } from '../db/client.js';
import { countersRepo } from '../db/repositories/counters.js';
import { ingestJobsRepo } from '../db/repositories/ingest-jobs.js';
import { createEmbeddingProvider } from '../embeddings/index.js';
import type { EmbeddingProvider } from '../embeddings/provider.js';
import { BlobBudgets } from '../limits/blob-budget.js';
import { GeminiBudgets, budgetLimitsOf } from '../limits/gemini-budget.js';
import {
  CachedAvailability,
  NO_OCR,
  geminiKeyAvailability,
  type OcrAvailability,
} from '../ocr/availability.js';
import { mayDeleteData } from '../config.js';
import { createStorage } from '../storage/index.js';
import type { StorageProvider } from '../storage/provider.js';
import {
  reclaimTicketBlobs,
  startRetentionTimer,
  sweepRetention,
  type RetentionTimer,
  type SweepResult,
} from '../storage/retention.js';
import { DocumentBytes } from './bytes.js';
import { ocrSettingsOf } from './ocr-settings.js';
import { ACTIVE_JOB_WINDOW_MS } from './progress.js';
import { DocumentService } from './service.js';
import { TickRunner } from './tick/runner.js';
import { IngestWorkerHost, type IngestWorkers } from './worker/host.js';

export interface IngestLogger {
  info(object: object, message: string): void;
  warn(object: object, message: string): void;
  error(object: object, message: string): void;
}

/** Pieces that tests (and later tasks) can replace; everything else is built from the configuration. */
export interface IngestionOverrides {
  storage?: StorageProvider;
  embeddings?: EmbeddingProvider;
  workers?: IngestWorkers;
  /** Whether OCR can be used (tests). */
  ocr?: OcrAvailability;
  budgets?: GeminiBudgets;
  blobBudgets?: BlobBudgets;
}

export interface Ingestion {
  storage: StorageProvider;
  embeddings: EmbeddingProvider;
  workers: IngestWorkers;
  /** Whether the OCR engine can start: asked once in a worker thread, then remembered. */
  ocr: OcrAvailability;
  /** What the app lets itself use of Gemini's daily quotas, counted in the database. */
  budgets: GeminiBudgets;
  /** What the app lets itself use of the Blob store (bytes, write operations, reads of a file); nothing with the local disk. */
  blobBudgets: BlobBudgets;
  /** Runs the ticks of the documents' jobs. */
  runner: TickRunner;
  service: DocumentService;
  /**
   * The line is full: INGEST_CONCURRENCY documents are being read and MAX_QUEUED_JOBS more are waiting. A soft limit (see the
   * README): the jobs of `sessionId`, which an upload of that session replaces, do not count.
   */
  isFull(sessionId?: string): Promise<boolean>;
  /** One retention pass now (and the removal of counters of windows long over). */
  sweep(now?: Date): Promise<SweepResult>;
  /** Settles the upload tickets that expired an hour ago (deletes the blobs that have no document); a few per call, never throws. */
  reclaimTicketBlobs(): Promise<number>;
  /** Starts the retention timer and warms the embedding model. A process that listens calls this once; a function does not. */
  startBackground(): void;
  close(): Promise<void>;
}

/** Counters of windows that ended this long ago are of no use any more. */
const COUNTER_RETENTION_MS = 2 * 86_400_000;

/** Builds the ingestion machinery: storage, workers, embeddings, budgets, the tick runner and the document service. */
export async function createIngestion(
  config: Config,
  db: Db,
  log: IngestLogger,
  overrides: IngestionOverrides = {},
): Promise<Ingestion> {
  const storage = overrides.storage ?? (await createStorage(config));
  const embeddings = overrides.embeddings ?? createEmbeddingProvider(config);
  const workers =
    overrides.workers ??
    new IngestWorkerHost(
      {
        maxOldGenerationSizeMb: config.ingestWorkerMaxOldMb,
        pageTimeoutMs: config.ingestPageTimeoutMs,
        maxRssGrowthMb: config.ingestWorkerMaxRssGrowthMb,
      },
      { log, pauseMemoryWatch: () => embeddings.loadState?.() === 'loading' },
    );
  // Shutting down stops the check of the OCR engine, if it is still running.
  const closing = new AbortController();
  const ocr =
    overrides.ocr ??
    (config.ocrProvider === 'none'
      ? NO_OCR
      : config.ocrProvider === 'gemini'
        ? geminiKeyAvailability(config)
        : new CachedAvailability(() => workers.checkOcr(ocrSettingsOf(config), { signal: closing.signal }), {
            onFailure: (error) => {
              if (!closing.signal.aborted) log.warn({ err: error }, 'the OCR engine could not be checked');
            },
          }));
  const budgets = overrides.budgets ?? new GeminiBudgets(db, budgetLimitsOf(config));
  const blobBudgets = overrides.blobBudgets ?? new BlobBudgets(config);
  const bytes = new DocumentBytes(storage, config.tmpDir);
  const runner = new TickRunner({ db, storage, workers, ocr, embeddings, budgets, bytes, config, log });
  const service = new DocumentService({ db, storage, runner, bytes, log });

  const sweep = async (now?: Date): Promise<SweepResult> => {
    const result = await sweepRetention({
      db,
      storage,
      retentionHours: config.documentRetentionHours,
      tmpDir: config.tmpDir,
      onExpired: (documentId) => service.cancelJob(documentId),
      // A preview that has not been told it has a database and a store of its own deletes nothing.
      mayDelete: mayDeleteData(config),
      log,
      ...(now === undefined ? {} : { now: () => now }),
    });
    if (result.refused === true) return result;
    await countersRepo.deleteOlderThan(db, new Date((now ?? new Date()).getTime() - COUNTER_RETENTION_MS));
    return result;
  };

  let timer: RetentionTimer | null = null;

  return {
    storage,
    embeddings,
    workers,
    ocr,
    budgets,
    blobBudgets,
    runner,
    service,
    async isFull(sessionId) {
      const active = await ingestJobsRepo.countActive(db, ACTIVE_JOB_WINDOW_MS, sessionId ?? null);
      return active >= config.ingestConcurrency + config.maxQueuedJobs;
    },
    sweep,
    async reclaimTicketBlobs() {
      if (!mayDeleteData(config)) return 0;
      try {
        return await reclaimTicketBlobs({ db, storage, log });
      } catch (error) {
        log.warn({ err: error }, 'could not settle the blobs of upload tickets');
        return 0;
      }
    },
    startBackground() {
      timer ??= startRetentionTimer(() => sweep(), config.cleanupIntervalMinutes, log);
      // Load the embedding model now rather than at the first upload (a model that runs in this process); then find out
      // whether OCR works (started after the model, so the two never load at the same time).
      void (embeddings.warmup?.() ?? Promise.resolve())
        .catch((error: unknown) => log.error({ err: error }, 'the embedding model could not be loaded'))
        .then(() => ocr.isAvailable())
        .catch(() => undefined);
    },
    async close() {
      timer?.stop();
      timer = null;
      closing.abort();
      await runner.close();
      await embeddings.dispose?.();
    },
  };
}
