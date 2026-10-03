import type { Config } from '../config.js';
import type { Db, Queryable } from '../db/client.js';
import { countersRepo } from '../db/repositories/counters.js';
import { documentsRepo } from '../db/repositories/documents.js';
import { uploadTicketsRepo } from '../db/repositories/upload-tickets.js';
import { DETAIL_ARCHIVE_FULL, DETAIL_TICKET_TRIES } from '../ingest/detail.js';
import { AppError } from '../http/errors.js';

/*
 * What the app lets itself use of a Vercel Blob store. The free (Hobby) store holds 1 GB and allows 2,000 advanced
 * operations (writes and listings), 10,000 simple operations (reads) and 10 GB of transfer a month, and going over blocks the
 * store for 30 days, for every visitor: so the app keeps itself under a budget of its own, counted in the database, for all
 * visitors and instances together:
 *   - BLOB_MAX_TOTAL_MB: the bytes stored (the documents, plus what the tickets that are not settled may still bring);
 *   - BLOB_MAX_WRITES_PER_DAY: write operations. A ticket costs TICKET_WRITE_OPERATIONS of them (see there);
 *   - FILE_READS_PER_DOC_PER_DAY: how often the file of one document is opened (every open reads the store);
 *   - TICKET_MAX_STORE_READS: how often the store is asked for the blob of ONE ticket when the document is made of it.
 * A limit of 0 means no limit (the last one is fixed). Over a budget the answer is "the archive is full for today" (429
 * RATE_LIMITED). None of this applies to the local disk.
 *
 * This is a demo's protection, not a hardened one (see the README): the transfer of the store is not budgeted globally, and a
 * client token can still be used for a multipart upload.
 */

const DAY_MS = 24 * 3_600_000;
/** Any constant: it only has to be the same in every process that issues tickets (takes the byte budget). */
const TICKET_LOCK_KEY = 727_276;
/**
 * Write operations one upload ticket may cost the store: the single put the browser makes (a token for a multipart upload is
 * refused, which would be several), plus the one put more that the client token of a ticket whose document was deleted, or
 * whose file was refused, can still make before it expires (the blob is gone then, and the pathname free). The server's own
 * deletes are not counted: they do not use the quota that blocks the store.
 */
export const TICKET_WRITE_OPERATIONS = 2;
/**
 * How many times the store is asked for the blob of one ticket (a head and a read of up to MAX_UPLOAD_MB each time) when the
 * document is made of it: the first time, and two retries after a store or database that did not answer. A busy archive is
 * refused BEFORE the store is touched, so waiting for a place in the line costs none of these.
 */
export const TICKET_MAX_STORE_READS = 3;
/** How long the ticket of a file the SERVER wrote itself (a multipart upload) lives: only the failures of the write are left to it. */
const SERVER_WRITE_TICKET_MS = 10 * 60_000;

export const archiveFull = (): AppError =>
  new AppError('RATE_LIMITED', 'The archive is full for today. Try again tomorrow.', DETAIL_ARCHIVE_FULL);

export type BlobBudgetConfig = Pick<
  Config,
  'storageProvider' | 'blobMaxTotalBytes' | 'blobMaxWritesPerDay' | 'fileReadsPerDocumentPerDay'
>;

export class BlobBudgets {
  constructor(
    private readonly config: BlobBudgetConfig,
    private readonly now: () => Date = () => new Date(),
  ) {}

  private get active(): boolean {
    return this.config.storageProvider === 'vercel-blob';
  }

  /**
   * Issues an upload ticket under the budgets: there is room for the bytes it may bring (the documents stored plus the tickets
   * that are not settled plus this one), and the day's write operations are not used up. Atomic across instances (one
   * transaction under an advisory lock): the budgets cannot be passed by two tickets that are issued at once. Throws
   * `archiveFull()` otherwise.
   */
  async issueTicket(
    db: Db,
    ticket: { pathname: string; sessionId: string; maxBytes: number; expiresAt: Date },
    writeOperations: number = TICKET_WRITE_OPERATIONS,
  ): Promise<void> {
    await db.transaction(async (tx) => {
      if (this.active) {
        await tx.query('SELECT pg_advisory_xact_lock($1)', [TICKET_LOCK_KEY]);
        await this.requireRoom(tx, ticket.maxBytes);
        await this.requireWrite(tx, writeOperations);
      }
      await uploadTicketsRepo.issue(tx, ticket);
    });
  }

  /**
   * The server is about to write a file to the store itself (the multipart route): the same budgets as for a ticket (the room
   * for its bytes, one write operation), and the write is recorded as a ticket, so that the file is counted while it is being
   * written and belongs to the namespace the sweep cleans (the document the upload makes claims it). True when it was recorded
   * (the store is a Blob store); false for the local disk, which has no budget.
   */
  async recordServerWrite(
    db: Db,
    write: { pathname: string; sessionId: string; bytes: number },
  ): Promise<boolean> {
    if (!this.active) return false;
    await this.issueTicket(
      db,
      {
        pathname: write.pathname,
        sessionId: write.sessionId,
        maxBytes: write.bytes,
        expiresAt: new Date(this.now().getTime() + SERVER_WRITE_TICKET_MS),
      },
      1,
    );
    return true;
  }

  private async requireRoom(q: Queryable, bytes: number): Promise<void> {
    const limit = this.config.blobMaxTotalBytes;
    if (limit <= 0) return;
    const stored = await documentsRepo.totalBytes(q);
    const promised = await uploadTicketsRepo.openBytes(q);
    if (stored + promised + bytes > limit) throw archiveFull();
  }

  /** `operations` write operations of today's budget, or `archiveFull()`. */
  private async requireWrite(q: Queryable, operations: number): Promise<void> {
    const limit = this.config.blobMaxWritesPerDay;
    if (limit <= 0) return;
    const now = this.now();
    const result = await countersRepo.consume(q, {
      key: 'blob:writes',
      limit,
      amount: operations,
      windowMs: DAY_MS,
      now,
    });
    if (!result.allowed) throw archiveFull();
  }

  /**
   * The store is about to be asked for the blob of this ticket (to make a document of it): one of its few turns, or the
   * refusal that says to ask for a new ticket. Nothing is counted for the local disk.
   */
  async requireTicketRead(db: Queryable, pathname: string): Promise<void> {
    if (!this.active) return;
    const result = await countersRepo.consume(db, {
      key: `ticket-reads:${pathname}`,
      limit: TICKET_MAX_STORE_READS,
      windowMs: DAY_MS,
      now: this.now(),
    });
    if (!result.allowed) {
      throw new AppError(
        'RATE_LIMITED',
        'This upload has been tried too often; start it again with a new upload ticket.',
        DETAIL_TICKET_TRIES,
      );
    }
  }

  /** The file of the document is about to be read from the store: one of today's reads of this document, or `archiveFull()`. */
  async requireFileRead(db: Queryable, documentId: string): Promise<void> {
    const limit = this.config.fileReadsPerDocumentPerDay;
    if (!this.active || limit <= 0) return;
    const result = await countersRepo.consume(db, {
      key: `file-reads:${documentId}`,
      limit,
      windowMs: DAY_MS,
      now: this.now(),
    });
    if (!result.allowed) throw archiveFull();
  }
}
