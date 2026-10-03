import { readdir, stat, unlink } from 'node:fs/promises';
import path from 'node:path';
import type { Db } from '../db/client.js';
import { retryOnDeadlock } from '../db/errors.js';
import { documentsRepo } from '../db/repositories/documents.js';
import { sessionsRepo } from '../db/repositories/sessions.js';
import { uploadTicketsRepo } from '../db/repositories/upload-tickets.js';
import { INGEST_CACHE_DIRECTORY, INGEST_CACHE_SUFFIX } from '../ingest/bytes.js';
import type { StorageProvider } from './provider.js';

const HOUR_MS = 3_600_000;
/** A half-written upload (in storage or in the scratch directory) older than this is abandoned. */
export const STALE_TEMPORARY_MS = HOUR_MS;
/** Where the upload route stages files in flight, inside TMP_DIR. */
export const UPLOAD_SCRATCH_DIRECTORY = 'uploads';
export const UPLOAD_SCRATCH_SUFFIX = '.part';

/** A ticket nobody claimed keeps its blob this long after the ticket expired (the browser may be finishing its upload). */
export const UNCLAIMED_BLOB_GRACE_MS = HOUR_MS;
/** Rows of settled tickets are kept this long (a pathname must never be accepted twice while its token could still be replayed). */
export const TICKET_ROW_RETENTION_MS = 7 * 24 * HOUR_MS;

export interface SweepResult {
  /** The pass was refused: this is a preview that was not told it has data of its own (nothing was deleted). */
  refused?: true;
  /** Documents whose expiry passed (rows, with pages, chunks and embeddings, and their files). */
  expiredDocuments: number;
  /** Files with no document row that were older than the retention window. */
  orphanFiles: number;
  /** Abandoned half-written files in storage and in the upload scratch directory. */
  staleTemporaryFiles: number;
  /** Blobs deleted for upload tickets that were over (an hour after the ticket expired) and had no document. */
  ticketBlobs?: number;
  /** Sessions with no documents that had not been seen for the retention window. */
  staleSessions: number;
}

/**
 * Settles the upload tickets whose expiry is an hour old: a blob at their pathname that no document has is deleted (a browser
 * that uploaded a file and never asked for the document, a visitor who left, or a blob put again by a client token after its
 * document was deleted or its file refused), one that a document has is that document's and stays; the ticket then stops
 * counting against the store's byte budget. It is called by the ticket route as well as by the daily sweep, so that on a plan
 * whose cron runs once a day the store does not fill up with abandoned uploads. At most `limit` per call.
 */
export async function reclaimTicketBlobs(
  deps: {
    db: Db;
    storage: StorageProvider;
    log?: { warn(object: object, message: string): void };
    now?: () => Date;
  },
  limit = 10,
): Promise<number> {
  const now = (deps.now ?? (() => new Date()))();
  const due = await uploadTicketsRepo.dueBefore(
    deps.db,
    new Date(now.getTime() - UNCLAIMED_BLOB_GRACE_MS),
    limit,
  );
  const owned = await documentsRepo.existingStorageKeys(deps.db, due);
  let reclaimed = 0;
  for (const pathname of due) {
    try {
      if (!owned.has(pathname)) {
        await deps.storage.delete(pathname);
        reclaimed += 1;
      }
      await uploadTicketsRepo.markReleased(deps.db, pathname);
    } catch (error) {
      deps.log?.warn({ err: error }, 'retention: could not settle the blob of an upload ticket');
    }
  }
  return reclaimed;
}

export interface SweepDeps {
  db: Db;
  storage: StorageProvider;
  /** DOCUMENT_RETENTION_HOURS. */
  retentionHours: number;
  /** TMP_DIR: its upload scratch directory is cleaned too. */
  tmpDir: string;
  /** Called for every expired document before it is removed: cancels its job, forgets its progress. */
  onExpired?: (documentId: string) => Promise<void> | void;
  now?: () => Date;
  /**
   * False: delete nothing that is in the database or the store (see `mayDeleteData`); only this process's own scratch files
   * are cleaned. Default true.
   */
  mayDelete?: boolean;
  /** Where a failure to delete one thing is told (it never stops the pass). */
  log?: { warn(object: object, message: string): void };
}

/**
 * One retention pass:
 *  1. documents with expires_at in the past are removed (cascade) together with their files, running jobs first;
 *  2. files without a document row, older than the retention window, are removed (what is newer may belong to an
 *     upload that is still being stored);
 *  3. half-written files older than an hour (storage and the upload scratch directory) are removed, and so are cached copies
 *     of documents (see ingest/bytes.ts) older than the retention window;
 *  4. sessions without documents that were last seen before the retention window are removed.
 * Only files named like stored PDFs or like this server's temporary files are ever touched, and in a Blob store only those
 * this database issued an upload ticket for (a store shared with another environment keeps what is not ours). A thing that
 * cannot be deleted is told and skipped: it never stops the pass.
 */
export async function sweepRetention(deps: SweepDeps): Promise<SweepResult> {
  const now = (deps.now ?? (() => new Date()))();
  const retentionCutoff = new Date(now.getTime() - deps.retentionHours * HOUR_MS);
  const temporaryCutoff = new Date(now.getTime() - STALE_TEMPORARY_MS);

  if (deps.mayDelete === false) {
    // Cleaning this process's own scratch files hurts nobody; everything else is somebody's data.
    const scratch =
      (await sweepScratch(
        path.join(deps.tmpDir, UPLOAD_SCRATCH_DIRECTORY),
        [UPLOAD_SCRATCH_SUFFIX],
        temporaryCutoff,
      )) +
      (await sweepScratch(
        path.join(deps.tmpDir, INGEST_CACHE_DIRECTORY),
        [INGEST_CACHE_SUFFIX, '.tmp'],
        retentionCutoff,
      ));
    return {
      refused: true,
      expiredDocuments: 0,
      orphanFiles: 0,
      staleTemporaryFiles: scratch,
      staleSessions: 0,
    };
  }
  const attempt = async (what: string, work: () => unknown): Promise<boolean> => {
    try {
      await work();
      return true;
    } catch (error) {
      deps.log?.warn({ err: error }, `retention: could not ${what}`);
      return false;
    }
  };

  // A running job is stopped BEFORE its document goes (otherwise it would hit the missing rows). A document that
  // expires between the two statements is cancelled afterwards.
  const due = new Set(await documentsRepo.expiredIds(deps.db, now));
  for (const id of due) await deps.onExpired?.(id);
  const expired = await retryOnDeadlock(() => documentsRepo.removeExpired(deps.db, now));
  for (const document of expired) {
    if (!due.has(document.id))
      await attempt('stop the job of an expired document', () => deps.onExpired?.(document.id));
    await attempt('delete the file of an expired document', () => deps.storage.delete(document.storageKey));
  }

  const known = await documentsRepo.allStorageKeys(deps.db);
  // A store the server shares with nobody has only its own files; a Blob store may be shared with another environment, whose
  // blobs are none of this database's business: only a pathname it issued a ticket for is its to delete.
  const issued = deps.storage.name === 'local' ? null : await uploadTicketsRepo.issuedPathnames(deps.db);
  let orphanFiles = 0;
  let staleTemporaryFiles = 0;
  for (const object of await deps.storage.list()) {
    if (object.temporary) {
      if (object.mtime < temporaryCutoff) {
        if (await attempt('delete a half-written file', () => deps.storage.deleteTemporary(object.key))) {
          staleTemporaryFiles += 1;
        }
      }
    } else if (
      !known.has(object.key) &&
      object.mtime < retentionCutoff &&
      (issued === null || issued.has(object.key))
    ) {
      if (await attempt('delete an orphan file', () => deps.storage.delete(object.key))) orphanFiles += 1;
    }
  }
  staleTemporaryFiles += await sweepScratch(
    path.join(deps.tmpDir, UPLOAD_SCRATCH_DIRECTORY),
    [UPLOAD_SCRATCH_SUFFIX],
    temporaryCutoff,
  );
  // The copies of documents that a remote store gave to the ticks are only a cache: old ones go (a tick fetches again).
  staleTemporaryFiles += await sweepScratch(
    path.join(deps.tmpDir, INGEST_CACHE_DIRECTORY),
    [INGEST_CACHE_SUFFIX, '.tmp'],
    retentionCutoff,
  );

  const staleSessions = await sessionsRepo.removeStaleEmpty(deps.db, retentionCutoff);
  const ticketBlobs = await reclaimTicketBlobs(
    {
      db: deps.db,
      storage: deps.storage,
      ...(deps.log === undefined ? {} : { log: deps.log }),
      now: () => now,
    },
    500,
  );
  await uploadTicketsRepo.deleteSettledBefore(deps.db, new Date(now.getTime() - TICKET_ROW_RETENTION_MS));
  return {
    expiredDocuments: expired.length,
    orphanFiles,
    staleTemporaryFiles,
    staleSessions,
    ticketBlobs,
  };
}

/** Removes the files of a scratch directory with one of `suffixes` that were last written before `cutoff`. */
async function sweepScratch(directory: string, suffixes: readonly string[], cutoff: Date): Promise<number> {
  let names: string[];
  try {
    names = await readdir(directory);
  } catch {
    return 0; // nothing was ever staged here
  }
  let removed = 0;
  for (const name of names) {
    if (!suffixes.some((suffix) => name.endsWith(suffix))) continue;
    const file = path.join(directory, name);
    try {
      if ((await stat(file)).mtime < cutoff) {
        await unlink(file);
        removed += 1;
      }
    } catch {
      // Gone already (the upload finished): nothing to do.
    }
  }
  return removed;
}

export interface RetentionTimer {
  /** Runs a pass now (skipped when one is running) and returns its result. */
  runNow(): Promise<SweepResult | null>;
  stop(): void;
}

export interface RetentionLogger {
  info(object: object, message: string): void;
  error(object: object, message: string): void;
}

/**
 * Runs `sweep` immediately and then every `intervalMinutes`. The timer is unref'd (it never keeps the process
 * alive), passes never overlap, and a failing pass is logged, not thrown.
 */
export function startRetentionTimer(
  sweep: () => Promise<SweepResult>,
  intervalMinutes: number,
  log: RetentionLogger,
): RetentionTimer {
  let running: Promise<SweepResult | null> | null = null;
  const runNow = (): Promise<SweepResult | null> => {
    if (running !== null) return running;
    running = sweep()
      .then((result) => {
        if (
          result.expiredDocuments + result.orphanFiles + result.staleTemporaryFiles + result.staleSessions >
          0
        ) {
          log.info(result, 'retention sweep removed expired data');
        }
        return result;
      })
      .catch((error: unknown) => {
        log.error({ err: error }, 'retention sweep failed');
        return null;
      })
      .finally(() => {
        running = null;
      });
    return running;
  };
  void runNow();
  const timer = setInterval(() => void runNow(), Math.max(1000, intervalMinutes * 60_000));
  timer.unref();
  return { runNow, stop: () => clearInterval(timer) };
}
