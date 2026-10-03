import { createReadStream } from 'node:fs';
import { readFile } from 'node:fs/promises';
import type { Config } from '../config.js';
import type { Db } from '../db/client.js';
import { retryOnDeadlock } from '../db/errors.js';
import { documentsRepo, type DocumentRow } from '../db/repositories/documents.js';
import { ingestJobsRepo } from '../db/repositories/ingest-jobs.js';
import { uploadTicketsRepo } from '../db/repositories/upload-tickets.js';
import { DETAIL_ARCHIVE_BUSY, DETAIL_NO_PDF_HEADER, DETAIL_TICKET_USED } from '../ingest/detail.js';
import type { Ingestion } from '../ingest/index.js';
import { AppError } from './errors.js';
import { hasPdfHeader, type ScratchUpload } from './upload.js';

/*
 * What happens to an upload once its bytes are in a scratch file, whichever way they got there (a multipart upload to this
 * server, or a blob the browser sent straight to the store and the server streamed back): the SAME checks, then the document
 * and its job are created. One module, so that the two ways cannot drift apart.
 */

const HOUR_MS = 3_600_000;
/** The first key of the advisory lock that serialises the uploads of one session (the second is a hash of the session id). */
const SESSION_UPLOAD_LOCK = 727_277;

/** What a client refused for a busy archive is told to wait before it asks again: a place in the line takes a while to come free. */
export const BUSY_RETRY_AFTER_SECONDS = 10;

export const archiveBusy = (): AppError =>
  new AppError('RATE_LIMITED', 'The archive is busy. Wait a moment and try again.', DETAIL_ARCHIVE_BUSY, {
    retryAfterSeconds: BUSY_RETRY_AFTER_SECONDS,
  });

export interface AcceptDeps {
  db: Db;
  config: Config;
  ingestion: Ingestion;
}

/** What an error that ends an upload says: whether it is a verdict about the FILE (which ends the file) or about anything else. */
const FILE_VERDICTS = new Set([
  'FILE_NOT_PDF',
  'FILE_TOO_LARGE',
  'PDF_ENCRYPTED',
  'PDF_MALFORMED',
  'PDF_EMPTY',
  'PDF_UNREADABLE',
  'TOO_MANY_PAGES',
]);

/**
 * Whether `error` is a verdict about the uploaded file itself (it is not a PDF, it is empty, encrypted, damaged, too big, has
 * too many pages): such a file is deleted, and the ticket that brought it is spent. Anything else (a busy archive, a store or a
 * database that did not answer, an unexpected fault) says nothing about the file, and the file is never deleted for it.
 */
export function isVerdictAboutFile(error: unknown): boolean {
  if (!(error instanceof AppError)) return false;
  // An empty file is FILE_MISSING ("The uploaded file is empty"); a blob that never arrived is FILE_MISSING too, but that one
  // is never raised here (it is found before the file is read).
  return FILE_VERDICTS.has(error.code) || (error.code === 'FILE_MISSING' && error.detail === undefined);
}

/**
 * The checks every upload passes: not empty, `%PDF-` within the first 1024 bytes, and the structure parsed in a worker thread
 * (encrypted, malformed, empty, too many pages). Returns the page count. The file's size was bounded while it was streamed.
 */
export async function validateScratchPdf(
  deps: Pick<AcceptDeps, 'config' | 'ingestion'>,
  file: ScratchUpload,
  signal?: AbortSignal,
): Promise<{ pageCount: number }> {
  if (file.size === 0) throw new AppError('FILE_MISSING', 'The uploaded file is empty.');
  if (!(await hasPdfHeader(file.path))) {
    throw new AppError('FILE_NOT_PDF', 'The file is not a PDF.', DETAIL_NO_PDF_HEADER);
  }
  return deps.ingestion.workers.validate(new Uint8Array(await readFile(file.path)), {
    maxPages: deps.config.maxPages,
    ...(signal === undefined ? {} : { signal }),
  });
}

export interface NewUpload {
  id: string;
  sessionId: string;
  /** Already sanitised for display. */
  filename: string;
  size: number;
  sha256: string;
  pageCount: number;
  /** The key the document's file has in storage. */
  storageKey: string;
  /** The file to put in storage; absent when it is already there (a blob the browser uploaded). */
  scratchPath?: string;
  /** The pathname of the upload ticket the file came with (a Blob upload): claimed, once, by the transaction that makes the document. */
  ticket?: string;
}

/**
 * Creates the document and its job. One active ingestion per session: the new document replaces any other that is still
 * being read, decided in ONE transaction under a lock of the session, so that two uploads of the session that arrive together
 * (a double click, two tabs, two instances) cannot both stay. The document being made is never one of those removed (a retry of
 * its own creation, on another instance, finds it there and fails on the primary key, which the caller reads as "already made").
 * Anything that goes wrong leaves nothing behind (no row, no file this call stored).
 */
export async function createDocumentFor(deps: AcceptDeps, upload: NewUpload): Promise<DocumentRow> {
  const { db, config, ingestion } = deps;
  if (await ingestion.isFull(upload.sessionId)) throw archiveBusy();
  let stored = false;
  let ticket = upload.ticket;
  let recordedWrite = false;
  try {
    if (upload.scratchPath !== undefined) {
      // The server writes the file to the store itself (a multipart upload): under the same budgets as a ticket (room for the
      // bytes, a write operation), and recorded as one, so that the file is counted and belongs to the sweep's namespace.
      const recorded = await ingestion.blobBudgets.recordServerWrite(db, {
        pathname: upload.storageKey,
        sessionId: upload.sessionId,
        bytes: upload.size,
      });
      if (recorded) {
        ticket = upload.storageKey;
        recordedWrite = true;
      }
      try {
        await ingestion.storage.put(upload.storageKey, createReadStream(upload.scratchPath));
        stored = true;
      } catch {
        throw new AppError('STORAGE_FAILED', 'The document could not be stored.');
      }
    }
    const { row, replaced } = await retryOnDeadlock(() =>
      db.transaction(async (tx) => {
        await tx.query('SELECT pg_advisory_xact_lock($1, hashtext($2))', [
          SESSION_UPLOAD_LOCK,
          upload.sessionId,
        ]);
        const replaced = await documentsRepo.removeProcessingForSession(tx, upload.sessionId, upload.id);
        const row = await documentsRepo.insert(tx, {
          id: upload.id,
          sessionId: upload.sessionId,
          filename: upload.filename,
          byteSize: upload.size,
          sha256: upload.sha256,
          pageCount: upload.pageCount,
          storageKey: upload.storageKey,
          expiresAt: new Date(Date.now() + config.documentRetentionHours * HOUR_MS),
        });
        await ingestJobsRepo.create(tx, upload.id);
        if (
          ticket !== undefined &&
          !(await uploadTicketsRepo.claim(tx, ticket, upload.sessionId, upload.id))
        ) {
          // Used by another request in the meantime: the caller looks for the document that request made.
          throw new AppError(
            'FILE_MISSING',
            'This upload ticket was used already; ask for a new upload ticket.',
            DETAIL_TICKET_USED,
          );
        }
        return { row, replaced };
      }),
    );
    // What the documents it replaced leave behind: their ticks stop, their copies and files go.
    for (const gone of replaced) await ingestion.service.cleanUp(gone);
    return row;
  } catch (error) {
    // The file this call stored goes again; a file that was already in the store (a blob the browser uploaded) is its caller's.
    if (stored) await ingestion.storage.delete(upload.storageKey).catch(() => undefined);
    // The file this call wrote is gone and no document claimed it: the record of the write is settled too (it counted its bytes).
    if (recordedWrite) await uploadTicketsRepo.markReleased(db, upload.storageKey).catch(() => undefined);
    throw error;
  }
}
