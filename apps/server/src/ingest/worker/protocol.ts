import type { Direction, ErrorCode } from '@enchanted/shared';
import type { ChunkingOptions } from '../../chunking/chunker.js';
import type { Analysis, PageEvidenceFlags } from '../analyze.js';
import type { OcrPageText } from '../../ocr/ocr-page.js';
import type { OutlineEntry } from '../../pdf/outline.js';
import type { ExtractedPage } from '../../pdf/types.js';

/*
 * The messages between the main thread and an ingestion worker thread. Every task runs in its own short-lived
 * worker (resourceLimits, a page timeout and a job timeout enforced by the host, terminate on DELETE), so
 * whatever a hostile PDF does to pdf.js dies with that thread.
 */

/** What crosses the thread boundary for a page: the extraction without the raw items and the flat line list. */
export type SerializedPage = Omit<ExtractedPage, 'items' | 'lines'>;

export interface ValidateTask {
  task: 'validate';
  bytes: Uint8Array;
  maxPages: number;
}

export interface ParseTask {
  task: 'parse';
  bytes: Uint8Array;
  /** First page to extract (a worker restarted after a bad page resumes after it). */
  startPage: number;
  maxPages: number;
  /** Read the outline (only the first worker of a job does). */
  readOutline: boolean;
  /**
   * The thread does not start the next page until the host says so (`next`), or that it is time to end (`stop`): the host can
   * stop a range between two pages, when the thread is idle, and never has to terminate one that is inside pdf.js.
   */
  paced?: boolean;
}

/** What the host tells a worker thread while it runs. */
export type HostMessage =
  /** (A paced task) start the next page. */
  | { type: 'next' }
  /** Finish what is under way, close the document and end: the host has no more use for the thread. */
  | { type: 'stop' };

export interface AnalyzeTask {
  task: 'analyze';
  pages: (SerializedPage & PageEvidenceFlags)[];
  outline: OutlineEntry[];
  chunking: Omit<ChunkingOptions, 'countTokens'>;
}

/** The part of the configuration an OCR worker thread needs. */
export interface OcrSettings {
  provider: 'gemini' | 'tesseract' | 'none';
  /** OCR_MODEL (gemini). */
  model: string;
  /** OCR_PAGES_PER_REQUEST (gemini). */
  pagesPerRequest: number;
  /** GEMINI_API_KEY (gemini): carried to the thread in its start-up data only, never logged or sent anywhere but to Google. */
  geminiApiKey: string | null;
  /** GEMINI_MAX_RPM (gemini). */
  geminiMaxRpm: number;
  /**
   * The request window of the process (`geminiPacerBuffer()` of the main thread), so that this thread and every other
   * share the one budget of GEMINI_MAX_RPM. Absent: the thread has a window of its own (tests).
   */
  pacerBuffer?: SharedArrayBuffer | null;
  /** OCR_CACHE_DIR. */
  cacheDir: string;
  /** OCR_LANGUAGES: the candidates for the first page when the document's own text names none. */
  languages: string[];
  /** OCR_EXTRA_LANGUAGES. */
  extraLanguages: string[];
  /** OCR_DPI. */
  dpi: number;
}

export interface OcrTask {
  task: 'ocr';
  /** The document; absent when only checking that OCR can start. */
  bytes?: Uint8Array;
  settings: OcrSettings;
  /** The pages to read, in order. Empty: only check that OCR can start. */
  pages: number[];
  /** Text of the document's own pages, from which the first language candidates are taken. */
  languageSample: string;
  /** The language packs decided earlier (a thread restarted after a lost page continues with them); null: still to decide. */
  languages: string[] | null;
}

export type WorkerTask = ValidateTask | ParseTask | AnalyzeTask | OcrTask;

/** One page as OCR read it: its text in the shape extraction uses, and how sure the engine was. */
export interface OcrPageResult {
  pageNumber: number;
  /** Mean confidence of the page, 0..100; null when the engine reports none (Gemini). */
  confidence: number | null;
  /** The language packs the page was read with. */
  languages: string[];
  text: OcrPageText;
}

/** Error codes a worker can report; the host turns them into AppErrors. */
export type WorkerFailureCode = Extract<
  ErrorCode,
  'PDF_ENCRYPTED' | 'PDF_MALFORMED' | 'PDF_EMPTY' | 'TOO_MANY_PAGES' | 'PDF_UNREADABLE' | 'INTERNAL'
>;

export type WorkerMessage =
  | { type: 'validated'; pageCount: number }
  /** `message` is curated and may be shown; `raw` is the original exception text, for the log only. */
  | { type: 'failure'; code: WorkerFailureCode; message: string; raw?: string }
  | { type: 'opened'; pageCount: number }
  | { type: 'outline'; entries: OutlineEntry[] }
  | { type: 'page-start'; pageNumber: number }
  | { type: 'page'; page: SerializedPage }
  | { type: 'page-error'; pageNumber: number; message: string }
  | { type: 'parsed' }
  | {
      type: 'progress';
      step: 'analyzing' | 'chunking';
      completed: number;
      total: number;
      direction?: Direction;
    }
  | { type: 'analysis'; analysis: Analysis }
  /** The engine was started (or could not be): sent once, before the first page. */
  | { type: 'ocr-ready'; available: boolean }
  /**
   * A page (or, for a provider that reads several pages in one request, the first page of the batch) is about to be
   * prepared; `timeoutFactor` scales the page timeout it is given and `timeoutMs`, when present, is the least it gets.
   */
  | { type: 'ocr-page-start'; pageNumber: number; timeoutFactor: number; timeoutMs?: number }
  /** The page is rendered and is about to be read (the language trial reads it several times): the same, for the reading. */
  | { type: 'ocr-reading'; timeoutFactor: number; timeoutMs?: number }
  | { type: 'ocr-languages'; languages: string[] }
  /** One request to the model service is about to be sent (a retry is another one): what the daily OCR budget is counted in. */
  | { type: 'ocr-request' }
  | { type: 'ocr-page'; page: OcrPageResult }
  /** `message` is curated and may be shown; `raw` is the original exception text, for the log only. */
  | { type: 'ocr-page-error'; pageNumber: number; message: string; raw: string }
  /** The model service's daily quota is used up: the pages not yet read are left (OCR_PARTIAL, "daily quota reached"). */
  | { type: 'ocr-quota' }
  /**
   * The model service refuses what OCR is configured with (the key was rejected, the model is unknown, or it refuses every
   * request): nothing more is asked for the rest of the document, and the pages left are left with `detail` (curated).
   */
  | { type: 'ocr-config-fault'; detail: string }
  /**
   * One request to the model service failed for all of `pageNumbers` (counted once, not once per page). `service`: the
   * service could not answer (busy, down, refused the key); otherwise it refused the request itself. `message` is curated
   * and may be shown; `raw` is for the log only.
   */
  | { type: 'ocr-request-failed'; pageNumbers: number[]; service: boolean; message: string; raw: string }
  | { type: 'ocr-done' };
