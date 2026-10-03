import type { ProgressEvent } from '@enchanted/shared';
import type { Config } from '../config.js';
import { DAILY_QUOTA_DETAIL } from '../gemini/index.js';
import { OCR_BUDGET_DETAIL, OCR_SERVICE_DETAIL } from '../ocr/types.js';
import type { OcrAvailability } from '../ocr/availability.js';
import { ocrSettingsOf } from './ocr-settings.js';
import type { OcrOutcome } from './page-policy.js';
import type { PageFailure } from './worker/ledger.js';
import type { IngestWorkers } from './worker/host.js';

/*
 * The `ocr` stage of a job: the pages that need OCR are read by an OCR worker thread (see worker/ocr-task.ts) with
 * real progress, and every one of them ends up with an outcome the page policy turns into a decision.
 */

/** The text handed to the language choice: enough to name the languages of the document, not the whole of it. */
const DEFAULT_SAMPLE_CHARS = 6000;

export type OcrStageConfig = Pick<
  Config,
  | 'ocrProvider'
  | 'ocrModel'
  | 'ocrPagesPerRequest'
  | 'geminiApiKey'
  | 'geminiMaxRpm'
  | 'ocrLanguages'
  | 'ocrExtraLanguages'
  | 'ocrMaxPages'
  | 'ocrMaxSeconds'
  | 'ocrCacheDir'
  | 'ocrDpi'
  | 'ocrMinChars'
>;

export interface OcrStageDeps {
  workers: Pick<IngestWorkers, 'ocr'>;
  ocr: OcrAvailability;
  config: OcrStageConfig;
  log: {
    info(object: object, message: string): void;
    warn(object: object, message: string): void;
    error(object: object, message: string): void;
  };
}

export interface OcrStageInput {
  bytes: Uint8Array;
  /** The pages that need OCR. */
  pages: readonly number[];
  languageSample: string;
  signal: AbortSignal;
  /** Publishes a progress event and records the stage (the first event of the stage). */
  emit(progress: ProgressEvent): Promise<void>;
  /** Publishes a later event after `previous`, never failing the job over progress. */
  chain(previous: Promise<void>, progress: ProgressEvent): Promise<void>;
}

export interface OcrStageResult {
  /** One outcome for every page that needed OCR, in page order. */
  outcomes: Map<number, OcrOutcome>;
  /** Whether the engine can read; null when it was not asked (no page needed OCR). */
  available: boolean | null;
  /**
   * Why pages were left unread beyond the usual: `daily quota reached`, `model service unavailable`, `time allowed for OCR
   * used up`, or the curated fault of the configuration (`the key was rejected`, `model not found`, ...); null when
   * nothing of the kind happened.
   */
  detail: string | null;
  /** Requests the OCR worker sent to the model service (null: it did not count, or none were made). */
  requests: number | null;
}

/**
 * Why a page was left, when it was not the page's fault: the quota, a service that did not answer, the time allowed for
 * OCR, or a configuration the service refuses (the failure's own message says which: it is curated).
 */
function failureDetail(failure: PageFailure): { detail: string } | Record<string, never> {
  switch (failure.reason) {
    case 'quota':
      return { detail: DAILY_QUOTA_DETAIL };
    case 'service':
      return { detail: OCR_SERVICE_DETAIL };
    case 'budget':
      return { detail: OCR_BUDGET_DETAIL };
    case 'config':
      return { detail: failure.message };
    default:
      return {};
  }
}

const outcomesFor = (pages: readonly number[], outcome: OcrOutcome): [number, OcrOutcome][] =>
  pages.map((page) => [page, outcome]);

/**
 * Reads the pages that need OCR. The first OCR_MAX_PAGES are read; the rest are `skipped`. Without an engine (OCR switched
 * off, or one that does not start) every page is `unavailable`. A page the engine failed on is `failed`.
 */
export async function runOcrStage(deps: OcrStageDeps, input: OcrStageInput): Promise<OcrStageResult> {
  const { config } = deps;
  const pages = [...input.pages].sort((a, b) => a - b);
  if (pages.length === 0) return { outcomes: new Map(), available: null, detail: null, requests: null };

  const available = config.ocrProvider !== 'none' && (await deps.ocr.isAvailable());
  if (!available) {
    return {
      outcomes: new Map(outcomesFor(pages, { kind: 'unavailable' })),
      available: false,
      detail: null,
      requests: null,
    };
  }

  const toRead = pages.slice(0, config.ocrMaxPages);
  const skipped = pages.slice(config.ocrMaxPages);
  const outcomes = new Map<number, OcrOutcome>();
  let detail: string | null = null;
  let requests: number | null = null;
  if (toRead.length > 0) {
    await input.emit({ stage: 'ocr', completed: 0, total: toRead.length, unit: 'pages' });
    let progress: Promise<void> = Promise.resolve();
    const run = await deps.workers.ocr(input.bytes, {
      pages: toRead,
      languageSample: input.languageSample,
      settings: ocrSettingsOf(config),
      signal: input.signal,
      budgetMs: config.ocrMaxSeconds * 1000,
      onProgress: ({ completed, total }) => {
        progress = input.chain(progress, { stage: 'ocr', completed, total, unit: 'pages' });
      },
    });
    await progress;
    requests = run.requests;
    if (run.unavailable) {
      deps.log.warn({ pages: toRead.length }, 'the OCR engine did not start in the worker thread');
      return {
        outcomes: new Map(outcomesFor(pages, { kind: 'unavailable' })),
        available: false,
        detail: null,
        requests,
      };
    }
    if (run.languages !== null) deps.log.info({ languages: run.languages }, 'OCR languages chosen');
    for (const read of run.results) {
      outcomes.set(read.pageNumber, {
        kind: 'read',
        confidence: read.confidence,
        languages: read.languages,
        text: read.text,
      });
    }
    for (const failure of run.failures) {
      outcomes.set(failure.pageNumber, { kind: 'failed', ...failureDetail(failure) });
    }
    if (run.quotaReached) {
      detail = DAILY_QUOTA_DETAIL;
      deps.log.warn(
        { pages: run.failures.filter((failure) => failure.reason === 'quota').length },
        `OCR stopped: ${DAILY_QUOTA_DETAIL}`,
      );
    }
    if (run.configFault !== null) {
      // The owner has to act (a key, a model name): said once, at error level, with what the service refused.
      detail = run.configFault;
      deps.log.error(
        {
          pages: run.failures.filter((failure) => failure.reason === 'config').length,
          fault: run.configFault,
        },
        'OCR stopped: the model service refuses the configuration (check GEMINI_API_KEY and OCR_MODEL)',
      );
    }
    const unanswered = run.failures.filter((failure) => failure.reason === 'service').length;
    if (unanswered > 0) {
      detail ??= OCR_SERVICE_DETAIL;
      deps.log.warn({ pages: unanswered }, `OCR left pages unread: ${OCR_SERVICE_DETAIL}`);
    }
    const outOfTime = run.failures.filter((failure) => failure.reason === 'budget').length;
    if (outOfTime > 0) {
      detail ??= OCR_BUDGET_DETAIL;
      deps.log.warn({ pages: outOfTime }, `OCR left pages unread: ${OCR_BUDGET_DETAIL}`);
    }
  }
  for (const page of skipped) outcomes.set(page, { kind: 'skipped' });
  return {
    outcomes: new Map([...outcomes.entries()].sort(([a], [b]) => a - b)),
    available: true,
    detail,
    requests,
  };
}

export interface SamplePage {
  pageNumber: number;
  text: string;
  charCount: number;
}

/**
 * The text that tells which languages the document is in: the pages that have enough text and are not garbage, in
 * page order, up to `maxChars`. Pages that are about to be OCR'd (scans) have none, so a scanned document has no
 * sample and the languages are tried from OCR_LANGUAGES; a mixed document is sampled from its text pages.
 */
export function languageSampleOf(
  pages: readonly SamplePage[],
  options: { minChars: number; unreliable(pageNumber: number): boolean; maxChars?: number },
): string {
  const limit = options.maxChars ?? DEFAULT_SAMPLE_CHARS;
  let sample = '';
  for (const page of pages) {
    if (sample.length >= limit) break;
    if (page.charCount < options.minChars || options.unreliable(page.pageNumber)) continue;
    sample += `${sample === '' ? '' : '\n'}${page.text}`;
  }
  return sample.slice(0, limit);
}
