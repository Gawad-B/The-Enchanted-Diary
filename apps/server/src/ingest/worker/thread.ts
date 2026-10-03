import { Worker } from 'node:worker_threads';
import { AppError } from '../../http/errors.js';
import type { WorkerEntry } from './entry.js';
import type { HostMessage, WorkerMessage, WorkerTask } from './protocol.js';

/*
 * Running one task in one worker thread, watched from outside. The host cannot make a thread stop itself while pdf.js
 * spins, so it watches in three ways:
 *  - time: a thread that takes longer than its limit is terminated (the limit is the caller's to set and move, as the
 *    task reports progress);
 *  - memory: decoded images are typed arrays, which the heap limit of a worker does not cover, so the resident memory
 *    of the whole process is sampled while a thread works on a page, and one that makes it grow by more than
 *    INGEST_WORKER_MAX_RSS_GROWTH_MB (counted from the start of that page) is terminated like one that timed out. Only
 *    page work is watched: opening a document and analysing its text are bounded by the size of their input, and a watch
 *    there would blame them for growth that comes from elsewhere in the process (another upload being validated, a
 *    download being processed), as RSS is process-wide;
 *  - DELETE (an aborted signal) terminates the thread, unless it is idle between two pages.
 *
 * A thread that is healthy is never terminated while it works: `worker.terminate()` tears the thread's environment down, and
 * inside pdf.js that can abort the WHOLE Node process (node_zlib.cc "close before init" while a DecompressionStream is being
 * made: seen about once in 650 stops). So when the host is done with a thread (its task finished, a tick ran out of time
 * between two pages) it asks it to stop (`stop`, which the thread honours between pages and which a paced parse waits for),
 * and the thread ends by itself. `terminate()` is the fallback after STOP_GRACE_MS, for a thread that does not, and the
 * immediate end of a thread that is misbehaving (timed out, too much memory, crashed) or is inside a page when its document
 * is deleted. The residual: a page that is stuck, or a delete in the middle of a page, still terminates a thread that is inside
 * pdf.js, so that can, rarely, take the process down (the lease runs out and the next tick goes on; on Vercel the platform
 * starts a new instance; self-hosted, a supervisor restarts the server).
 */

export const MB = 1024 * 1024;
/** How long a thread that was asked to stop is given to end by itself before it is terminated. */
export const STOP_GRACE_MS = 2000;
const UNEXPECTED_ERROR_MESSAGE = 'The document could not be processed because of an unexpected error.';

export interface HostLimits {
  /** INGEST_WORKER_MAX_OLD_MB: the heap limit of a worker thread. */
  maxOldGenerationSizeMb: number;
  /** INGEST_PAGE_TIMEOUT_MS: one page's extraction. */
  pageTimeoutMs: number;
  /** INGEST_WORKER_MAX_RSS_GROWTH_MB: how much the process may grow, resident, while a worker extracts one page. */
  maxRssGrowthMb: number;
}

export interface HostLogger {
  warn(object: object, message: string): void;
}

export interface MemoryWatch {
  limitBytes: number;
  sampleMs: number;
  rssBytes: () => number;
  paused: () => boolean;
}

/** What every task of the host needs to run a thread. */
export interface ThreadContext {
  entry: WorkerEntry;
  log: HostLogger | undefined;
  limits: HostLimits;
  memory: MemoryWatch;
  /** How long opening a document (and reading its outline) may take. */
  openTimeout: number;
  /** How long starting the OCR engine may take. */
  ocrOpenTimeout: number;
  /** How long a thread that was asked to stop may take to end by itself before it is terminated (default STOP_GRACE_MS). */
  stopGraceMs?: number | undefined;
}

export type ThreadEnd =
  | { kind: 'finished' }
  | { kind: 'watchdog' }
  | { kind: 'memory'; growthMb: number }
  | { kind: 'aborted' }
  | { kind: 'crashed'; message: string; outOfMemory: boolean };

/** How a thread ended without finishing its task and without being cancelled. */
export type Abnormal = Exclude<ThreadEnd, { kind: 'finished' | 'aborted' }>;

/** What a thread reported, filled in by its message handler (a closure: plain `let` variables would not narrow). */
export interface Outcome<T> {
  result: T | null;
  failure: AppError | null;
}

export interface Control {
  /** Restarts the watchdog with a new limit, or switches it off with null. */
  watchdog(ms: number | null): void;
  /**
   * Starts (true) or stops (false) comparing the process's resident memory with a baseline taken now. Off until the
   * handler turns it on, which the page tasks do for the duration of each page.
   */
  watchMemory(on: boolean): void;
  /** The task is complete (or the host has no more use for the thread): the thread is asked to stop, and the run resolves as finished. */
  finish(): void;
  /** (A paced parse task) lets the thread start its next page. */
  next(): void;
}

export interface ThreadOptions {
  entry: WorkerEntry;
  task: WorkerTask;
  bytes?: Uint8Array;
  maxOldGenerationSizeMb: number;
  signal: AbortSignal | undefined;
  initialWatchdogMs: number | null;
  memory: MemoryWatch;
  /** How long a thread asked to stop may take (default STOP_GRACE_MS). */
  stopGraceMs?: number | undefined;
  onMessage(message: WorkerMessage, control: Control): void;
}

export function abortError(signal: AbortSignal | undefined): Error {
  return signal?.reason instanceof Error
    ? signal.reason
    : new DOMException('The ingestion was cancelled', 'AbortError');
}

/** Runs one task in a fresh worker thread and resolves when it is done, died, timed out, grew too big or was aborted. */
export function runThread(options: ThreadOptions): Promise<ThreadEnd> {
  return new Promise((resolve) => {
    if (options.signal?.aborted === true) {
      resolve({ kind: 'aborted' });
      return;
    }
    // The bytes are copied for the thread: pdf.js detaches what it is given, and a restarted job needs them again.
    const taskData: WorkerTask = { ...options.task };
    const transfer: ArrayBuffer[] = [];
    if (options.bytes !== undefined && 'bytes' in taskData) {
      const copy = new Uint8Array(options.bytes.byteLength);
      copy.set(options.bytes);
      taskData.bytes = copy;
      transfer.push(copy.buffer);
    }
    let baseline = 0;
    let watching = false;
    const worker = new Worker(options.entry.url, {
      workerData: taskData,
      transferList: transfer,
      execArgv: options.entry.execArgv,
      resourceLimits: { maxOldGenerationSizeMb: options.maxOldGenerationSizeMb },
    });

    let settled = false;
    let timer: NodeJS.Timeout | null = null;
    const memoryTimer = setInterval(() => {
      if (!watching) return;
      const rss = options.memory.rssBytes();
      if (options.memory.paused()) {
        baseline = rss;
        return;
      }
      if (rss - baseline > options.memory.limitBytes) {
        settle({ kind: 'memory', growthMb: Math.round((rss - baseline) / MB) });
      }
    }, options.memory.sampleMs);
    const settle = (end: ThreadEnd): void => {
      if (settled) return;
      settled = true;
      if (timer !== null) clearTimeout(timer);
      clearInterval(memoryTimer);
      options.signal?.removeEventListener('abort', onAbort);
      // A thread that is done with its task, or idle between two pages of a parse that is cancelled, is asked to end by itself.
      // One that timed out, grew too big, died, or is inside a page when the document is deleted is terminated at once (a page
      // that is under way is what a cancel must not wait for, and a bomb must not be given two more seconds).
      const idle = options.task.task === 'parse' && !watching;
      if (end.kind === 'finished' || (end.kind === 'aborted' && idle))
        stopGracefully(worker, options.stopGraceMs);
      else void worker.terminate();
      resolve(end);
    };
    const watchdog = (ms: number | null): void => {
      if (timer !== null) clearTimeout(timer);
      timer = ms === null ? null : setTimeout(() => settle({ kind: 'watchdog' }), ms);
    };
    const onAbort = (): void => settle({ kind: 'aborted' });
    options.signal?.addEventListener('abort', onAbort, { once: true });
    watchdog(options.initialWatchdogMs);

    const control: Control = {
      watchdog,
      watchMemory: (on) => {
        watching = on;
        if (on) baseline = options.memory.rssBytes();
      },
      finish: () => settle({ kind: 'finished' }),
      next: () => {
        if (!settled) worker.postMessage({ type: 'next' } satisfies HostMessage);
      },
    };
    worker.on('message', (message: WorkerMessage) => {
      if (!settled) options.onMessage(message, control);
    });
    worker.on('error', (error: Error & { code?: string }) => {
      settle({
        kind: 'crashed',
        message: error.message,
        outOfMemory: error.code === 'ERR_WORKER_OUT_OF_MEMORY',
      });
    });
    worker.on('exit', (code) => {
      settle({ kind: 'crashed', message: `The worker exited with code ${String(code)}`, outOfMemory: false });
    });
  });
}

/**
 * Asks a thread to end by itself, and terminates it if it has not after `graceMs`. (The timer does not keep the process alive; a
 * thread that has ended cancels it.)
 */
function stopGracefully(worker: Worker, graceMs: number = STOP_GRACE_MS): void {
  try {
    worker.postMessage({ type: 'stop' } satisfies HostMessage);
  } catch {
    void worker.terminate();
    return;
  }
  const timer = setTimeout(() => {
    void worker.terminate();
  }, graceMs);
  timer.unref();
  worker.once('exit', () => {
    clearTimeout(timer);
  });
}

/** A curated sentence about why a worker was stopped (never the raw text of an exception). */
export function stopDetail(end: Abnormal, limits: HostLimits): string {
  switch (end.kind) {
    case 'watchdog':
      return 'it took too long';
    case 'memory':
      return `it used more than ${String(limits.maxRssGrowthMb)} MB of memory`;
    case 'crashed':
      return end.outOfMemory ? 'the worker ran out of memory' : 'the worker stopped unexpectedly';
  }
}

/** The reason a page is recorded as lost for, from how its thread ended. */
export const stopReason = (end: Abnormal): 'timeout' | 'memory' | 'crash' =>
  end.kind === 'watchdog' ? 'timeout' : end.kind === 'memory' ? 'memory' : 'crash';

/** A worker's own verdict as an AppError. Raw exception text from the worker is logged, never sent to a client. */
export function workerFailure(
  context: Pick<ThreadContext, 'log'>,
  message: Extract<WorkerMessage, { type: 'failure' }>,
): AppError {
  if (message.code === 'INTERNAL') {
    context.log?.warn({ raw: message.raw ?? message.message }, 'an ingestion worker failed unexpectedly');
    return new AppError('INTERNAL', UNEXPECTED_ERROR_MESSAGE);
  }
  return new AppError(message.code, message.message);
}
