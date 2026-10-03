import type { Direction } from '@enchanted/shared';
import type { ChunkingOptions } from '../../chunking/chunker.js';
import type { OutlineEntry } from '../../pdf/outline.js';
import { AppError } from '../../http/errors.js';
import type { Analysis, PageEvidenceFlags } from '../analyze.js';
import { resolveWorkerEntry, type WorkerEntry } from './entry.js';
import { checkOcrEngine, readPagesWithOcr, type OcrOptions, type OcrRun } from './host-ocr.js';
import { parsePageRange, type ParseRangeOptions, type ParseRangeResult } from './host-parse-range.js';
import { parseDocument, type ParseOptions, type ParseResult } from './host-parse.js';
import type { OcrSettings, SerializedPage } from './protocol.js';
import {
  MB,
  abortError,
  runThread,
  stopDetail,
  workerFailure,
  type HostLimits,
  type HostLogger,
  type Outcome,
  type ThreadContext,
  type ThreadEnd,
} from './thread.js';

/*
 * The main-thread side of the ingestion workers. Each task (validate, parse, analyse, OCR) runs in its own worker
 * thread with a heap limit, watched from outside (thread.ts): by time, by the resident memory of the process while a
 * page is worked on, and by DELETE. Tasks that go through pages over restartable threads, text extraction
 * (host-parse.ts) and OCR (host-ocr.ts), share their bookkeeping (ledger.ts).
 */

export { MAX_CONSECUTIVE_PAGE_FAILURES, type PageFailure } from './ledger.js';
export { MAX_OCR_STOPS, type OcrOptions, type OcrRun } from './host-ocr.js';
export type { ParseOptions, ParseProgress, ParseResult } from './host-parse.js';
export type { ParseRangeOptions, ParseRangeResult } from './host-parse-range.js';
export type { HostLimits, HostLogger } from './thread.js';

/** Opening a document includes starting the thread and importing pdf.js, so it gets at least this long. */
export const MIN_OPEN_TIMEOUT_MS = 30_000;
/** The analyse task reports progress as it goes; this long without a word from it (chunking is silent) is a hang. */
export const ANALYZE_IDLE_TIMEOUT_MS = 60_000;
/** Starting the OCR engine (the WebAssembly core, language data, possibly a first download) may take this long. */
export const MIN_OCR_OPEN_TIMEOUT_MS = 90_000;
/** How often the resident memory is sampled while a worker runs. */
export const MEMORY_SAMPLE_MS = 100;

export interface HostOptions {
  /** How long a worker thread that was asked to stop may take to end by itself before it is terminated (default 2 s). */
  stopGraceMs?: number;
  log?: HostLogger;
  /** Where the worker thread starts (tests). */
  entry?: WorkerEntry;
  /** Resident memory of the process in bytes (tests). */
  rssBytes?: () => number;
  /**
   * While this returns true the memory baseline follows the process instead of being compared with it: the embedding
   * model loading (about 0.6 GB) must not count against a worker that happens to run at the same time.
   */
  pauseMemoryWatch?: () => boolean;
  memorySampleMs?: number;
  /** How long opening a document (and reading its outline) may take; default: the page timeout, at least 30 s. */
  openTimeoutMs?: number;
  /** How long the analyse task may go without a word; default 60 s. */
  analyzeIdleTimeoutMs?: number;
  /** How long starting the OCR engine may take; default 90 s (at least the open timeout). */
  ocrOpenTimeoutMs?: number;
}

/** What the ingestion code asks of its workers. The default implementation is {@link IngestWorkerHost}. */
export interface IngestWorkers {
  validate(
    bytes: Uint8Array,
    options: { maxPages: number; signal?: AbortSignal },
  ): Promise<{ pageCount: number }>;
  parse(bytes: Uint8Array, options: ParseOptions): Promise<ParseResult>;
  /**
   * One tick's share of the text extraction: the pages from `startPage` on until `shouldStop` says the tick is out of time,
   * each page handed to `onPage` / `onFailure` as it is read (see host-parse-range.ts).
   */
  parseRange(bytes: Uint8Array, options: ParseRangeOptions): Promise<ParseRangeResult>;
  analyze(
    pages: (SerializedPage & PageEvidenceFlags)[],
    options: {
      outline: OutlineEntry[];
      chunking: Omit<ChunkingOptions, 'countTokens'>;
      signal?: AbortSignal;
      onProgress?: (
        step: 'analyzing' | 'chunking',
        completed: number,
        total: number,
        direction?: Direction,
      ) => void;
    },
  ): Promise<Analysis>;
  /** Renders and reads `pages` with OCR (one engine per thread, languages chosen on the first page). */
  ocr(bytes: Uint8Array, options: OcrOptions): Promise<OcrRun>;
  /** Whether the OCR engine can start, asked of a throwaway thread (never of the main thread). */
  checkOcr(settings: OcrSettings, options?: { signal?: AbortSignal }): Promise<boolean>;
}

export class IngestWorkerHost implements IngestWorkers {
  private readonly context: ThreadContext;
  private readonly analyzeIdleTimeout: number;

  constructor(limits: HostLimits, options: HostOptions = {}) {
    const openTimeout = options.openTimeoutMs ?? Math.max(limits.pageTimeoutMs, MIN_OPEN_TIMEOUT_MS);
    this.analyzeIdleTimeout = options.analyzeIdleTimeoutMs ?? ANALYZE_IDLE_TIMEOUT_MS;
    this.context = {
      entry: options.entry ?? resolveWorkerEntry(),
      log: options.log,
      limits,
      openTimeout,
      ocrOpenTimeout: options.ocrOpenTimeoutMs ?? Math.max(openTimeout, MIN_OCR_OPEN_TIMEOUT_MS),
      stopGraceMs: options.stopGraceMs,
      memory: {
        limitBytes: limits.maxRssGrowthMb * MB,
        sampleMs: options.memorySampleMs ?? MEMORY_SAMPLE_MS,
        rssBytes: options.rssBytes ?? ((): number => process.memoryUsage.rss()),
        paused: options.pauseMemoryWatch ?? ((): boolean => false),
      },
    };
  }

  /** Opens the PDF in a worker and checks it: not encrypted, not malformed, 1..maxPages pages. */
  async validate(
    bytes: Uint8Array,
    options: { maxPages: number; signal?: AbortSignal },
  ): Promise<{ pageCount: number }> {
    const { context } = this;
    const outcome: Outcome<{ pageCount: number }> = { result: null, failure: null };
    const end = await runThread({
      entry: context.entry,
      stopGraceMs: context.stopGraceMs,
      task: { task: 'validate', bytes, maxPages: options.maxPages },
      bytes,
      maxOldGenerationSizeMb: context.limits.maxOldGenerationSizeMb,
      signal: options.signal,
      initialWatchdogMs: context.openTimeout,
      memory: context.memory,
      onMessage: (message, control) => {
        if (message.type === 'validated') outcome.result = { pageCount: message.pageCount };
        else if (message.type === 'failure') outcome.failure = workerFailure(context, message);
        else return;
        control.finish();
      },
    });
    return this.settle(end, 'opening the PDF', options.signal, outcome);
  }

  parse(bytes: Uint8Array, options: ParseOptions): Promise<ParseResult> {
    return parseDocument(this.context, bytes, options);
  }

  parseRange(bytes: Uint8Array, options: ParseRangeOptions): Promise<ParseRangeResult> {
    return parsePageRange(this.context, bytes, options);
  }

  /** Language detection, sections and chunking of the extracted pages, off the main thread. */
  async analyze(
    pages: (SerializedPage & PageEvidenceFlags)[],
    options: {
      outline: OutlineEntry[];
      chunking: Omit<ChunkingOptions, 'countTokens'>;
      signal?: AbortSignal;
      onProgress?: (
        step: 'analyzing' | 'chunking',
        completed: number,
        total: number,
        direction?: Direction,
      ) => void;
    },
  ): Promise<Analysis> {
    const { context } = this;
    const outcome: Outcome<Analysis> = { result: null, failure: null };
    const end = await runThread({
      entry: context.entry,
      stopGraceMs: context.stopGraceMs,
      task: { task: 'analyze', pages, outline: options.outline, chunking: options.chunking },
      maxOldGenerationSizeMb: context.limits.maxOldGenerationSizeMb,
      signal: options.signal,
      initialWatchdogMs: this.analyzeIdleTimeout,
      memory: context.memory,
      onMessage: (message, control) => {
        if (message.type === 'progress') {
          control.watchdog(this.analyzeIdleTimeout);
          options.onProgress?.(message.step, message.completed, message.total, message.direction);
        } else if (message.type === 'analysis') {
          outcome.result = message.analysis;
          control.finish();
        } else if (message.type === 'failure') {
          outcome.failure = workerFailure(context, message);
          control.finish();
        }
      },
    });
    return this.settle(end, 'analysing the text', options.signal, outcome);
  }

  ocr(bytes: Uint8Array, options: OcrOptions): Promise<OcrRun> {
    return readPagesWithOcr(this.context, bytes, options);
  }

  checkOcr(settings: OcrSettings, options: { signal?: AbortSignal } = {}): Promise<boolean> {
    return checkOcrEngine(this.context, settings, options);
  }

  /** Turns how a one-result thread ended into its result or the right error. */
  private settle<T>(end: ThreadEnd, doing: string, signal: AbortSignal | undefined, outcome: Outcome<T>): T {
    if (end.kind === 'aborted') throw abortError(signal);
    if (outcome.failure !== null) throw outcome.failure;
    if (end.kind === 'finished' && outcome.result !== null) return outcome.result;
    const why = end.kind === 'finished' ? 'it ended without a result' : stopDetail(end, this.context.limits);
    throw new AppError(
      'PDF_UNREADABLE',
      'The pages appear damaged or unreadable.',
      `${doing} failed: ${why}`,
    );
  }
}
