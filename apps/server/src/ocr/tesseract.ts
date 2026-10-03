import type * as TesseractModule from 'tesseract.js';
import type { Worker as TesseractWorker } from 'tesseract.js';
import { CachedAvailability } from './availability.js';
import { ensureLanguagePacks } from './tessdata.js';
import {
  OcrUnavailableError,
  isPdfPage,
  type OCRProvider,
  type OcrLine,
  type OcrPage,
  type OcrRecognizeOptions,
  type OcrResult,
} from './types.js';

/*
 * The Tesseract provider (tesseract.js 7: the WebAssembly build of Tesseract's LSTM engine). One worker, created
 * lazily on the first page, reused for every page of a job, re-initialised when the languages change and terminated
 * when it has been idle for a minute or the provider is disposed.
 *
 * Things about tesseract.js that shape this file (tech-verification section 3.2):
 *  - its default `cachePath` is the working directory, so language data would land wherever the server was started;
 *    it is always set (and `cacheMethod: 'none'` stops it from writing decompressed copies next to the packs);
 *  - since version 6 the default output is text only: line boxes need `blocks: true`;
 *  - it neither rejects `createWorker` nor resolves it when a pack is missing or broken (the promise just never
 *    settles), and its `errorHandler` throws when absent. Packs are therefore made sure of first (tessdata.ts), the
 *    worker is given the local directory, and creation is raced against the error handler and a timeout.
 */

/** tesseract.js's `createWorker`. The package is loaded when the engine is first used, never at start-up (see `loadLibrary`). */
export type CreateWorker = typeof TesseractModule.createWorker;

export interface TesseractOptions {
  /** OCR_CACHE_DIR: where `<code>.traineddata.gz` live. */
  cacheDir: string;
  /** The worker is terminated after this long without a page. Default 60 s. */
  idleTimeoutMs?: number;
  /** Starting the engine (loading the WebAssembly core and the language data) may take this long. Default 60 s. */
  initTimeoutMs?: number;
  /** How long a failed availability check is remembered. Default 60 s. */
  failureCacheMs?: number;
  /** The languages `isAvailable` starts the engine with. Default English. */
  probeLanguages?: readonly string[];
  /** Where missing packs are fetched from (tests). */
  tessdataBaseUrl?: string;
  /** tesseract.js's `createWorker` (tests count calls); by default the one of the package, loaded on first use. */
  createWorker?: CreateWorker;
}

const DEFAULT_IDLE_MS = 60_000;
const DEFAULT_INIT_TIMEOUT_MS = 60_000;
const DEFAULT_FAILURE_CACHE_MS = 60_000;
const DEFAULT_PROBE_LANGUAGES = ['eng'] as const;

const abortError = (signal: AbortSignal): Error =>
  signal.reason instanceof Error ? signal.reason : new DOMException('The OCR was cancelled', 'AbortError');

/** Rejects when the signal aborts; resolves never. */
function whenAborted(signal: AbortSignal | undefined): { promise: Promise<never>; stop(): void } {
  if (signal === undefined) return { promise: new Promise<never>(() => undefined), stop: () => undefined };
  let listener: (() => void) | undefined;
  const promise = new Promise<never>((_resolve, reject) => {
    if (signal.aborted) {
      reject(abortError(signal));
      return;
    }
    listener = () => reject(abortError(signal));
    signal.addEventListener('abort', listener, { once: true });
  });
  return {
    promise,
    stop: () => {
      if (listener !== undefined) signal.removeEventListener('abort', listener);
    },
  };
}

export class TesseractOcrProvider implements OCRProvider {
  readonly name = 'tesseract';
  readonly input = 'png';
  readonly selectsLanguages = true;
  readonly pagesPerRequest = 1;

  private readonly cacheDir: string;
  private readonly idleMs: number;
  private readonly initTimeoutMs: number;
  private readonly failureCacheMs: number;
  private readonly probeLanguages: readonly string[];
  private readonly baseUrl: string | undefined;
  private readonly create: CreateWorker | undefined;
  private library: Promise<typeof TesseractModule> | null = null;

  private worker: TesseractWorker | null = null;
  /** The languages the worker is initialised for, as `eng+ara`. */
  private loaded = '';
  private idleTimer: NodeJS.Timeout | null = null;
  /** Calls run one after the other: the worker holds one language setting at a time. */
  private queue: Promise<unknown> = Promise.resolve();
  private readonly availability: CachedAvailability;

  constructor(options: TesseractOptions) {
    this.cacheDir = options.cacheDir;
    this.idleMs = options.idleTimeoutMs ?? DEFAULT_IDLE_MS;
    this.initTimeoutMs = options.initTimeoutMs ?? DEFAULT_INIT_TIMEOUT_MS;
    this.failureCacheMs = options.failureCacheMs ?? DEFAULT_FAILURE_CACHE_MS;
    this.probeLanguages = options.probeLanguages ?? DEFAULT_PROBE_LANGUAGES;
    this.baseUrl = options.tessdataBaseUrl;
    this.create = options.createWorker;
    // The probe starts the engine; the worker it leaves behind is the one the first page uses.
    this.availability = new CachedAvailability(
      () =>
        this.serialise(async () => {
          await this.ensurePacks(this.probeLanguages);
          await this.ensureWorker(this.probeLanguages);
        }).then(
          () => true,
          () => false,
        ),
      { failureCacheMs: this.failureCacheMs },
    );
  }

  isAvailable(): Promise<boolean> {
    return this.availability.isAvailable();
  }

  recognize(page: OcrPage, options: OcrRecognizeOptions): Promise<OcrResult> {
    if (isPdfPage(page)) {
      return Promise.reject(
        new OcrUnavailableError('The Tesseract provider reads renderings, not PDF pages.'),
      );
    }
    const image = page;
    return this.serialise(async () => {
      const aborted = whenAborted(options.signal);
      try {
        // A pack that is missing (or cannot be fetched) fails here, with the engine that is running left alone: the
        // next language is read by it without a cold start.
        await Promise.race([this.ensurePacks(options.languages), aborted.promise]);
      } catch (error) {
        aborted.stop();
        throw error;
      }
      try {
        const worker = await Promise.race([this.ensureWorker(options.languages), aborted.promise]);
        const { data } = await Promise.race([
          worker.recognize(image.png, {}, { text: true, blocks: true }),
          aborted.promise,
        ]);
        this.armIdleTimer();
        return {
          text: data.text.trim(),
          confidence: Number.isFinite(data.confidence) ? Math.min(100, Math.max(0, data.confidence)) : 0,
          lines: linesOf(data),
          languagesUsed: [...options.languages],
        };
      } catch (error) {
        // After an abort the worker is still busy with the page and cannot be told to stop; after any other
        // failure its state is not worth trusting. Either way the next page gets a fresh one.
        await this.discard();
        throw error;
      } finally {
        aborted.stop();
      }
    });
  }

  async dispose(): Promise<void> {
    await this.serialise(() => this.discard());
  }

  private serialise<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(task, task);
    this.queue = run.catch(() => undefined);
    return run;
  }

  private armIdleTimer(): void {
    if (this.idleTimer !== null) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      void this.serialise(() => this.discard());
    }, this.idleMs);
    this.idleTimer.unref();
  }

  private async discard(): Promise<void> {
    if (this.idleTimer !== null) clearTimeout(this.idleTimer);
    this.idleTimer = null;
    const worker = this.worker;
    this.worker = null;
    this.loaded = '';
    await worker?.terminate();
  }

  /** Makes sure the language packs are on disk (fetching missing ones); the engine is not touched. */
  private async ensurePacks(languages: readonly string[]): Promise<void> {
    if (languages.length === 0) throw new OcrUnavailableError('No OCR language was given.');
    await ensureLanguagePacks(this.cacheDir, languages, {
      ...(this.baseUrl === undefined ? {} : { baseUrl: this.baseUrl }),
    });
  }

  /** The worker, started or re-initialised for `languages` (whose packs are on disk). */
  private async ensureWorker(languages: readonly string[]): Promise<TesseractWorker> {
    const wanted = languages.join('+');
    if (this.worker !== null && this.loaded === wanted) return this.worker;
    if (this.worker !== null) {
      try {
        await this.worker.reinitialize(wanted, (await this.loadLibrary()).OEM.LSTM_ONLY);
        this.loaded = wanted;
        return this.worker;
      } catch (error) {
        await this.discard();
        throw new OcrUnavailableError(`The OCR engine could not load ${wanted}.`, { cause: error });
      }
    }
    this.worker = await this.start(languages);
    this.loaded = wanted;
    return this.worker;
  }

  /**
   * The tesseract.js package, imported the first time the engine is used: with OCR_PROVIDER=gemini (the default) it is
   * never loaded, so its WebAssembly core and its size cost nothing.
   */
  private loadLibrary(): Promise<typeof TesseractModule> {
    this.library ??= import('tesseract.js');
    return this.library;
  }

  private async start(languages: readonly string[]): Promise<TesseractWorker> {
    const library = await this.loadLibrary();
    const create = this.create ?? library.createWorker;
    let fail: (error: Error) => void = () => undefined;
    const failed = new Promise<never>((_resolve, reject) => {
      fail = reject;
    });
    let timer: NodeJS.Timeout | undefined;
    const timedOut = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(
        () => reject(new OcrUnavailableError('The OCR engine did not start in time.')),
        this.initTimeoutMs,
      );
    });
    try {
      return await Promise.race([
        create([...languages], library.OEM.LSTM_ONLY, {
          langPath: this.cacheDir,
          cachePath: this.cacheDir,
          cacheMethod: 'none',
          gzip: true,
          errorHandler: (data: unknown) =>
            fail(new OcrUnavailableError(`The OCR engine failed to start: ${String(data)}`)),
        }),
        failed,
        timedOut,
      ]);
    } finally {
      clearTimeout(timer);
    }
  }
}

/** Every line of the page with its box, confidence and text, in Tesseract's reading order. */
function linesOf(data: { blocks: unknown }): OcrLine[] {
  const lines: OcrLine[] = [];
  if (!Array.isArray(data.blocks)) return lines;
  for (const block of data.blocks as { paragraphs?: { lines?: unknown[] }[] }[]) {
    for (const paragraph of block.paragraphs ?? []) {
      for (const line of (paragraph.lines ?? []) as {
        text: string;
        confidence: number;
        bbox: { x0: number; y0: number; x1: number; y1: number };
      }[]) {
        const text = line.text.trim();
        if (text === '') continue;
        lines.push({
          text,
          confidence: Number.isFinite(line.confidence) ? line.confidence : 0,
          bbox: { x0: line.bbox.x0, y0: line.bbox.y0, x1: line.bbox.x1, y1: line.bbox.y1 },
        });
      }
    }
  }
  return lines;
}
