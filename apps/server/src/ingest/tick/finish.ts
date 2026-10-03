import type { AppError } from '../../http/errors.js';
import { chunksRepo } from '../../db/repositories/chunks.js';
import { documentsRepo, type DocumentRow } from '../../db/repositories/documents.js';
import { ingestJobsRepo } from '../../db/repositories/ingest-jobs.js';
import { stageDataRepo } from '../../db/repositories/ingest-stage.js';
import { pagesRepo } from '../../db/repositories/pages.js';
import type { TickDeps } from './context.js';

/**
 * The failures that are a verdict about the FILE (it is damaged, encrypted, empty, too long, unreadable in the time allowed, or it
 * keeps killing the tick that reads it): such a file has no use any more, and a hostile one should not stay. For any other
 * failure (a rate limit, a store or a database that did not answer, an embedding service that failed, an unexpected fault) the
 * file says nothing, and it is kept until retention removes it.
 */
const FILE_VERDICTS: ReadonlySet<string> = new Set([
  'PDF_ENCRYPTED',
  'PDF_MALFORMED',
  'PDF_EMPTY',
  'PDF_UNREADABLE',
  'TOO_MANY_PAGES',
  'FILE_NOT_PDF',
  'FILE_TOO_LARGE',
  'INGEST_INTERRUPTED',
]);

/** Whether the file of a document that failed with `code` is deleted with it. */
export const deletesFileFor = (code: string): boolean => FILE_VERDICTS.has(code);

export interface FailOptions {
  /**
   * The lease of the tick that ends the job: the failure is recorded only while it is still the job's (a tick whose lease was
   * taken over must not fail a document that another tick is reading). Absent: not held to a lease.
   */
  lease?: string;
  /**
   * Keep the file of the document. A document that failed because of how the infrastructure behaved (a service that
   * kept rate limiting, a store or a database that did not answer) says nothing about the file: it is kept until retention
   * removes it, never deleted here.
   */
  keepFile?: boolean;
}

/**
 * Ends the job of a document that cannot be read: the document is marked failed with the code and the curated text, its
 * job, scratch data and whatever the analysis had stored go, and so does its file (a document that failed has no use for it,
 * and a hostile one should not stay), unless `keepFile`. Nothing happens if the document is no longer processing (it was
 * removed, or it ended meanwhile) or, with a lease, if the job is no longer this tick's.
 */
export async function failDocument(
  deps: TickDeps,
  row: DocumentRow,
  failure: AppError,
  options: FailOptions = {},
): Promise<boolean> {
  const text = failure.detail === undefined ? failure.message : `${failure.message} (${failure.detail})`;
  let marked = false;
  try {
    marked = await deps.db.transaction(async (tx) => {
      // Document row first, job row second: the order of every other writer (see TickContext.commit).
      const failed = await documentsRepo.markFailed(tx, row.id, failure.code, text);
      if (!failed) return false;
      if (
        options.lease !== undefined &&
        !(await ingestJobsRepo.renew(tx, row.id, options.lease, deps.config.ingestLeaseMs))
      ) {
        // Not this tick's job any more: nothing is recorded (the transaction ends with the lock released and no change).
        throw new LeaseNotHeld();
      }
      await stageDataRepo.clear(tx, row.id);
      // What the analysis had stored of a document that did not get to the end (pages, chunks, embeddings).
      await chunksRepo.removeForDocument(tx, row.id);
      await pagesRepo.removeForDocument(tx, row.id);
      await ingestJobsRepo.remove(tx, row.id);
      return true;
    });
  } catch (error) {
    if (error instanceof LeaseNotHeld) return false;
    deps.log.error({ err: error, documentId: row.id }, 'could not record the failure of a document');
  }
  if (!marked) return false;
  if (options.keepFile !== true) {
    await deps.storage.delete(row.storage_key).catch((error: unknown) => {
      deps.log.warn({ err: error, documentId: row.id }, 'could not remove the file of a failed document');
    });
  }
  await deps.bytes.forget(row.id);
  return true;
}

/** Rolls the failure back: the job was taken over by another tick. */
class LeaseNotHeld extends Error {}
