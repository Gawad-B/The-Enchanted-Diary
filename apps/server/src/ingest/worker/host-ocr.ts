import { DAILY_QUOTA_DETAIL } from '../../gemini/index.js';
import type { AppError } from '../../http/errors.js';
import { PageLedger, driveThreads, type PageFailure } from './ledger.js';
import type { OcrPageResult, OcrSettings } from './protocol.js';
import { abortError, runThread, stopDetail, workerFailure, type ThreadContext } from './thread.js';
import type { ParseProgress } from './host-parse.js';

/** The outcome of reading pages with OCR. */
export interface OcrRun {
  /** Pages that were read, in page order. */
  results: OcrPageResult[];
  /** Pages that could not be, with why: they are recorded with a warning and the job carries on. */
  failures: PageFailure[];
  /** The engine could not start: nothing was read and nothing failed. */
  unavailable: boolean;
  /** The language packs the pages were read with (null if no page was read). */
  languages: string[] | null;
  /** The model service's daily quota ran out: the pages left are in `failures` with the reason `quota`. */
  quotaReached: boolean;
  /** The service refuses the configuration (key, model): the curated reason; the pages left are in `failures` with the reason `config`. Null otherwise. */
  configFault: string | null;
  /**
   * Requests the worker sent to the model service, retries included (counted from what it announced, so a run that was
   * stopped still has its count); null when it announced none (an engine that makes no requests, or none was made).
   */
  requests: number | null;
}

export interface OcrOptions {
  /** The pages to read, in order. */
  pages: number[];
  /** Text of the document's own pages, for choosing the languages to try first. */
  languageSample: string;
  settings: OcrSettings;
  signal?: AbortSignal;
  onProgress?: (progress: ParseProgress) => void;
  /**
   * How long OCR may take for the document, in all (OCR_MAX_SECONDS): when it is used up the thread is stopped and the
   * pages not yet read are recorded as failed. Without a budget the pages are only held to their own timeouts.
   */
  budgetMs?: number;
}

/** Pages lost to a timeout or the memory watchdog, in all, after which OCR gives up on the document. */
export const MAX_OCR_STOPS = 3;

const NOT_READ = 'the page could not be read by OCR';

/** How long a thread may take over what it just announced: its factor of page timeouts, or the time it named if that is more. */
const allowance = (pageTimeoutMs: number, message: { timeoutFactor: number; timeoutMs?: number }): number =>
  Math.max(pageTimeoutMs * Math.max(1, message.timeoutFactor), message.timeoutMs ?? 0);

/**
 * Reads `pages` with OCR. The engine starts in the first thread; a page that takes too long (rendering gets twice the page
 * timeout, reading one per read, the language trial on the first page the time of all its reads), grows the process too
 * much, kills its thread or throws is recorded in `failures` and skipped, and the next page is read by a fresh thread
 * that continues with the languages decided so far. OCR gives up, recording the pages left as failed, after five
 * failures in a row, after {@link MAX_OCR_STOPS} pages stopped by the time or memory limits in all, or when the budget for
 * the document is used up: a page that costs a core for 40 seconds is cheap to put in a file, and a file of them must
 * not hold the only ingestion slot.
 */
export async function readPagesWithOcr(
  context: ThreadContext,
  bytes: Uint8Array,
  options: OcrOptions,
): Promise<OcrRun> {
  const { limits, log } = context;
  const ledger = new PageLedger<OcrPageResult>(
    options.pages,
    () => options.onProgress?.({ completed: ledger.settled, total: options.pages.length }),
    { maxStops: MAX_OCR_STOPS },
  );
  let languages: string[] | null = null;
  let unavailable = false;
  let quotaReached = false;
  let configFault: string | null = null;
  let requests: number | null = null;
  /** What the thread now running reported. */
  const thread: { ready: boolean; thrown: AppError | null } = { ready: false, thrown: null };
  // (Read through a function: the handler that sets it runs later, which the compiler cannot see.)
  const thrownBy = (): AppError | null => thread.thrown;

  const budget = new AbortController();
  const timer =
    options.budgetMs === undefined ? undefined : setTimeout(() => budget.abort(), options.budgetMs);
  const signal =
    options.signal === undefined ? budget.signal : AbortSignal.any([options.signal, budget.signal]);

  /** The engine did not start: if nothing was read yet that is "unavailable", else the pages left failed with it. */
  const engineMissing = (why: string): void => {
    if (ledger.settled === 0) {
      unavailable = true;
      ledger.abandon();
    } else {
      ledger.failRemaining('error', why);
    }
  };

  try {
    const drive = await driveThreads(ledger, {
      ready: () => thread.ready,
      detail: (end) => stopDetail(end, limits),
      onLost: (page, end) => log?.warn({ page, reason: end.kind }, 'a page could not be read by OCR'),
      run: async () => {
        thread.ready = false;
        thread.thrown = null;
        const end = await runThread({
          entry: context.entry,
          stopGraceMs: context.stopGraceMs,
          task: {
            task: 'ocr',
            bytes,
            settings: options.settings,
            pages: [...ledger.remaining],
            languageSample: options.languageSample,
            languages,
          },
          bytes,
          maxOldGenerationSizeMb: limits.maxOldGenerationSizeMb,
          signal,
          initialWatchdogMs: context.ocrOpenTimeout,
          memory: context.memory,
          onMessage: (message, control) => {
            switch (message.type) {
              case 'ocr-ready':
                thread.ready = true;
                if (!message.available) {
                  engineMissing('the OCR engine did not start again');
                  control.finish();
                }
                break;
              case 'ocr-page-start':
                ledger.begin(message.pageNumber);
                control.watchdog(allowance(limits.pageTimeoutMs, message));
                control.watchMemory(true);
                break;
              case 'ocr-reading':
                control.watchdog(allowance(limits.pageTimeoutMs, message));
                break;
              case 'ocr-quota':
                quotaReached = true;
                ledger.failRemaining('quota', DAILY_QUOTA_DETAIL);
                control.watchdog(context.openTimeout);
                control.watchMemory(false);
                control.finish();
                break;
              case 'ocr-languages':
                languages = message.languages;
                break;
              case 'ocr-request':
                requests = (requests ?? 0) + 1;
                break;
              case 'ocr-page':
                ledger.complete(message.page.pageNumber, message.page);
                control.watchdog(context.openTimeout);
                control.watchMemory(false);
                break;
              case 'ocr-config-fault':
                configFault = message.detail;
                log?.warn({ detail: message.detail }, 'the OCR service refuses the configuration');
                ledger.failRemaining('config', message.detail);
                control.watchdog(context.openTimeout);
                control.watchMemory(false);
                control.finish();
                break;
              case 'ocr-request-failed':
                log?.warn(
                  { pages: message.pageNumbers, raw: message.raw },
                  'a request to the OCR service failed',
                );
                ledger.failRequest(
                  message.pageNumbers,
                  message.service ? 'service' : 'error',
                  message.message,
                );
                control.watchdog(context.openTimeout);
                control.watchMemory(false);
                if (ledger.shouldGiveUp()) control.finish();
                break;
              case 'ocr-page-error':
                log?.warn({ page: message.pageNumber, raw: message.raw }, 'a page could not be read by OCR');
                ledger.fail(message.pageNumber, 'error', message.message);
                control.watchdog(context.openTimeout);
                control.watchMemory(false);
                if (ledger.shouldGiveUp()) control.finish();
                break;
              case 'ocr-done':
                control.finish();
                break;
              case 'failure':
                thread.thrown = workerFailure(context, message);
                control.finish();
                break;
              default:
                break;
            }
          },
        });
        const thrown = thrownBy();
        if (thrown !== null) {
          // An unexpected failure of the whole task: the pages that were not read stay unread.
          log?.warn({ code: thrown.code }, 'the OCR task failed');
          ledger.failRemaining('error', NOT_READ);
        }
        return end;
      },
    });

    switch (drive.status) {
      case 'aborted':
        if (options.signal?.aborted === true) throw abortError(options.signal);
        ledger.failRemaining('budget', 'the time allowed for OCR on this document was used up');
        break;
      case 'gave-up':
        if (ledger.lastFailureReason === 'service') {
          // Request after request went unanswered: the pages left are not damaged, the service is not there to read them.
          ledger.failRemaining('service', 'OCR stopped: the model service did not answer');
        } else {
          ledger.failRemaining(
            'error',
            ledger.stoppedPages >= MAX_OCR_STOPS
              ? 'OCR stopped after pages that took too long or too much memory'
              : 'OCR stopped after repeated failures',
          );
        }
        break;
      case 'not-started':
        log?.warn({ end: drive.end.kind }, 'the OCR engine did not start');
        engineMissing('the OCR engine did not start again');
        break;
      case 'done':
        break;
    }
  } finally {
    clearTimeout(timer);
  }

  return {
    results: [...ledger.results.values()].sort((a, b) => a.pageNumber - b.pageNumber),
    failures: [...ledger.failures].sort((a, b) => a.pageNumber - b.pageNumber),
    unavailable,
    languages,
    quotaReached,
    configFault,
    requests,
  };
}

/** Whether the OCR engine can start, asked of a throwaway thread. */
export async function checkOcrEngine(
  context: ThreadContext,
  settings: OcrSettings,
  options: { signal?: AbortSignal } = {},
): Promise<boolean> {
  const outcome = { available: false };
  const end = await runThread({
    entry: context.entry,
    stopGraceMs: context.stopGraceMs,
    task: { task: 'ocr', settings, pages: [], languageSample: '', languages: null },
    maxOldGenerationSizeMb: context.limits.maxOldGenerationSizeMb,
    signal: options.signal,
    initialWatchdogMs: context.ocrOpenTimeout,
    memory: context.memory,
    onMessage: (message, control) => {
      if (message.type !== 'ocr-ready') return;
      outcome.available = message.available;
      control.finish();
    },
  });
  if (end.kind === 'aborted') throw abortError(options.signal);
  return outcome.available;
}
