import type { Direction, DocumentWarning } from '@enchanted/shared';
import type { LanguageShare } from '../language/detect.js';
import type { PageFailure } from './worker/ledger.js';
import type { SectionEntry } from './analyze.js';

/*
 * What a job remembers between ticks: the cursor of `ingest_jobs`. It is small (counts, page numbers, a text sample);
 * bulky data (the extracted pages, the OCR results) is in `ingest_stage_data`, and the finished chunks in their own table.
 * The stage itself is the `stage` column of the job.
 */

/** `ingest_stage_data.kind` of an extracted page (item: page number). */
export const STAGE_PAGE = 'page';
/** `ingest_stage_data.kind` of the outline (item 0). */
export const STAGE_OUTLINE = 'outline';
/** `ingest_stage_data.kind` of a page OCR read (item: page number). */
export const STAGE_OCR = 'ocr';

export interface ParseCursor {
  /** Pages of the document (known from the upload's validation). */
  pageCount: number;
  /** The first page that is neither extracted nor given up on. */
  nextPage: number;
  /** Pages that could not be extracted (a timeout, too much memory, an error): recorded as empty with a warning. */
  failures: PageFailure[];
  /** The outline was read (it is read once, by the first thread). */
  outlineRead: boolean;
}

export interface OcrFailure {
  pageNumber: number;
  /** Why, when it was not the page's fault (`daily quota reached`, `model service unavailable`); absent for the rest. */
  detail?: string;
}

export interface OcrCursor {
  /** The pages that need OCR and will be read (the first OCR_MAX_PAGES of them), in order. */
  pages: number[];
  /** The pages that need OCR beyond OCR_MAX_PAGES: left, with a warning. */
  skipped: number[];
  /** Pages OCR has read (their results are in the stage data). */
  read: number[];
  /** Pages OCR could not read. */
  failed: OcrFailure[];
  /** The text that names the document's languages (for an engine that has to choose them), taken from its text pages. */
  languageSample: string;
  /** Milliseconds OCR has been working, over all ticks: bounded by OCR_MAX_SECONDS. */
  spentMs: number;
  /** The engine could not start: every page is left unread. */
  unavailable: boolean;
  /** Calls in a row to which the service did not answer for any page: after a few the pages left are given up on. */
  silentCalls?: number;
}

export interface AnalysisCursor {
  primaryLanguage: string;
  direction: Direction;
  languages: LanguageShare[];
  sections: SectionEntry[];
  warnings: DocumentWarning[];
  pageCount: number;
  /** Chunks stored for the document: what the embedding stage has to get through. */
  chunkCount: number;
}

export interface JobCursor {
  /** Milliseconds of work over all ticks, for INGEST_JOB_TIMEOUT_MS (parked time does not count). */
  workMs: number;
  /** Ticks in a row that ended on the same failure the next one may not have (a rate limit, a store that did not answer): given up after a few. */
  transient: number;
  /** What the failure of those ticks was (`database`, `store`, ...): another cause starts the count again. */
  transientCause?: string;
  parse?: ParseCursor;
  ocr?: OcrCursor;
  analysis?: AnalysisCursor;
}

export const EMPTY_CURSOR: JobCursor = { workMs: 0, transient: 0 };

/** A cursor read back from the database: unknown fields are ignored, missing ones take their defaults. */
export function readCursor(raw: unknown): JobCursor {
  if (typeof raw !== 'object' || raw === null) return { ...EMPTY_CURSOR };
  const stored = raw as Partial<JobCursor>;
  return {
    ...stored,
    workMs: typeof stored.workMs === 'number' ? stored.workMs : 0,
    transient: typeof stored.transient === 'number' ? stored.transient : 0,
  };
}
