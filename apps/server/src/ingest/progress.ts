import type { IngestTickResponse, ProgressEvent } from '@enchanted/shared';
import type { Queryable } from '../db/client.js';
import type { DocumentRow } from '../db/repositories/documents.js';
import { ingestJobsRepo, type IngestJobRow } from '../db/repositories/ingest-jobs.js';
import { DAILY_QUOTA_DETAIL } from '../gemini/index.js';
import { loadDocumentDetail } from './detail.js';

/** A job that has not been touched for this long has lost its reader: it no longer holds a place in the line. */
export const ACTIVE_JOB_WINDOW_MS = 10 * 60_000;
/** What a client waiting for its turn is asked to do between two ticks. */
export const QUEUE_RETRY_MS = 2000;

/** The stages after which the document's direction is known (the analysis reports it as soon as it has it). */
const DIRECTION_KNOWN_FROM = new Set(['chunking', 'embedding', 'storing']);

export function progressOf(row: DocumentRow, queuePosition?: number): ProgressEvent {
  if (row.status === 'ready') return { stage: 'ready', completed: 1, total: 1, unit: 'steps' };
  if (row.status === 'failed') return { stage: 'failed', completed: 0, total: 0, unit: 'steps' };
  if (row.stage === 'queued') {
    return {
      stage: 'queued',
      completed: 0,
      total: 0,
      unit: 'queue',
      ...(queuePosition === undefined ? {} : { queuePosition }),
    };
  }
  return {
    stage: row.stage,
    completed: row.progress_completed,
    total: row.progress_total,
    unit: row.progress_unit,
    ...(row.progress_detail === null ? {} : { detail: row.progress_detail }),
    ...(DIRECTION_KNOWN_FROM.has(row.stage) ? { direction: row.direction } : {}),
  };
}

export interface ResponseOptions {
  /** The job's row, when the caller has it (a read of the progress does not need it for a finished document). */
  job?: IngestJobRow | null;
  /** Asks the client to wait this long before the next tick. */
  retryAfterMs?: number;
}

/**
 * The answer of a tick, and of a read of the progress, for the document as the database has it: the finished document with
 * `ready`, the error with `failed`, the real progress otherwise (`parked` when a quota keeps the job waiting).
 */
export async function tickResponseOf(
  db: Queryable,
  row: DocumentRow,
  options: ResponseOptions = {},
): Promise<IngestTickResponse> {
  if (row.status === 'ready') {
    return { status: 'ready', progress: progressOf(row), document: await loadDocumentDetail(db, row) };
  }
  if (row.status === 'failed') {
    return {
      status: 'failed',
      progress: progressOf(row),
      error: {
        code: row.error_code ?? 'INTERNAL',
        message: row.error_detail ?? 'The document could not be processed.',
      },
    };
  }
  const job = options.job === undefined ? await ingestJobsRepo.find(db, row.id) : options.job;
  const parkedUntil = job?.parked_until ?? null;
  if (parkedUntil !== null && parkedUntil.getTime() > Date.now()) {
    return {
      status: 'parked',
      progress: { ...progressOf(row), detail: row.progress_detail ?? DAILY_QUOTA_DETAIL },
      retryAfterMs: parkedUntil.getTime() - Date.now(),
    };
  }
  const queuePosition =
    row.stage === 'queued' && job !== null
      ? await ingestJobsRepo.queuePosition(db, row.id, ACTIVE_JOB_WINDOW_MS)
      : undefined;
  return {
    status: 'running',
    progress: progressOf(row, queuePosition),
    ...(options.retryAfterMs === undefined ? {} : { retryAfterMs: options.retryAfterMs }),
  };
}
