import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import { CreateDocumentFromBlobSchema, type UploadTicket } from '@enchanted/shared';
import type { HandleUploadBody } from '@vercel/blob/client';
import type { IncomingMessage } from 'node:http';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Config } from '../config.js';
import type { Db } from '../db/client.js';
import { documentsRepo, toDocumentSummary } from '../db/repositories/documents.js';
import { uploadTicketsRepo } from '../db/repositories/upload-tickets.js';
import {
  DETAIL_MULTIPART_REFUSED,
  DETAIL_NO_SUCH_BLOB,
  DETAIL_TICKET_REFUSED,
  DETAIL_TICKET_USED,
  detailTooLarge,
} from '../ingest/detail.js';
import type { Ingestion } from '../ingest/index.js';
import { sanitizeDisplayFilename } from '../storage/filename.js';
import { StorageError, isStorageKey } from '../storage/provider.js';
import { archiveBusy, createDocumentFor, isVerdictAboutFile, validateScratchPdf } from './accept-upload.js';
import { AppError } from './errors.js';
import { uploadLimits } from './upload-limits.js';
import { UPLOAD_SCRATCH_DIRECTORY, UPLOAD_SCRATCH_SUFFIX } from '../storage/retention.js';
import { streamToScratch } from './upload.js';

/*
 * Uploads that bypass the function body limit (4.5 MB on Vercel): the browser sends the file straight to a PRIVATE Vercel Blob
 * store and tells the server where it is.
 *
 *   1. POST /api/uploads/ticket   the server chooses the pathname (`<uuid>.pdf`), records the ticket (`upload_tickets`) under
 *      the budgets of the Blob store, and signs it for this session;
 *   2. the browser calls `upload(pathname, file, { access: 'private', handleUploadUrl: '/api/uploads/blob', clientPayload })`,
 *      which asks POST /api/uploads/blob for a client token, valid for that pathname, PDFs and MAX_UPLOAD_MB only, and only
 *      while the ticket is open (not used, not expired, this session's);
 *   3. POST /api/documents { blobPathname, filename, ticket }: the server checks the ticket (its signature, the session, the
 *      pathname, and that it was not used), streams the blob back into TMP_DIR and runs the same checks as for a multipart
 *      upload (accept-upload.ts). The ticket is claimed in the transaction that makes the document, so ONE ticket makes at most
 *      one document, even after that document was deleted, and a file that is refused burns it. A repeated call for a ticket
 *      that made a document returns that document.
 *
 * The completion webhook of Blob (`onUploadCompleted`) is not used: it cannot reach a development machine and a missing one
 * must not lose a document; step 3 is what makes the document.
 *
 * This is a demo's protection, not a hardened one (see the README): a client token binds a pathname, a size and a type, and
 * nothing says "one put", so a holder of a ticket can still use the SDK's multipart calls with it.
 */

/** How long a ticket may be used: a large file on a slow line takes a while. */
const TICKET_TTL_MS = 30 * 60_000;
/** How long the client token of the Blob SDK that the ticket buys is good for: long enough to start a single put. */
export const CLIENT_TOKEN_TTL_MS = 10 * 60_000;
export const BLOB_TOKEN_ROUTE = '/api/uploads/blob';

interface TicketPayload {
  /** The session the ticket was issued to, as a keyed hash (the page sees the ticket: it must not see the session id). */
  sub: string;
  pathname: string;
  /** Milliseconds since the epoch. */
  exp: number;
}

const base64url = (value: Buffer | string): string => Buffer.from(value).toString('base64url');

function signature(secret: string, body: string): Buffer {
  // Domain-separated: the session secret signs cookies too, and a cookie must never be usable as a ticket.
  return createHmac('sha256', `upload-ticket:${secret}`).update(body).digest();
}

/** What a ticket carries for a session: a keyed hash of its id, so that the page's copy of the ticket does not show the id. */
export function ticketSubject(secret: string, sessionId: string): string {
  return createHmac('sha256', `upload-ticket-subject:${secret}`)
    .update(sessionId)
    .digest('base64url')
    .slice(0, 22);
}

/** `<payload>.<signature>`: what the browser carries as `clientPayload`. */
export function signTicket(secret: string, payload: TicketPayload): string {
  const body = base64url(JSON.stringify(payload));
  return `${body}.${base64url(signature(secret, body))}`;
}

/** The payload of a ticket signed with `secret`, or null for anything else (forged, damaged, expired). */
export function readTicket(secret: string, ticket: string | null, now = Date.now()): TicketPayload | null {
  if (ticket === null) return null;
  const [body, tag, ...rest] = ticket.split('.');
  if (body === undefined || tag === undefined || rest.length > 0) return null;
  const expected = signature(secret, body);
  const given = Buffer.from(tag, 'base64url');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  try {
    const parsed = z
      .object({ sub: z.string(), pathname: z.string(), exp: z.number() })
      .parse(JSON.parse(Buffer.from(body, 'base64url').toString('utf8')));
    return parsed.exp > now ? parsed : null;
  } catch {
    return null;
  }
}

/** What the server asks of the Blob SDK's `handleUpload` (replaced by a test). */
export type HandleUpload = (options: {
  body: HandleUploadBody;
  request: IncomingMessage;
  token?: string;
  onBeforeGenerateToken: (
    pathname: string,
    clientPayload: string | null,
    multipart: boolean,
  ) => Promise<{
    allowedContentTypes: string[];
    maximumSizeInBytes: number;
    addRandomSuffix: boolean;
    allowOverwrite: boolean;
    validUntil: number;
    tokenPayload?: string | null;
  }>;
}) => Promise<unknown>;

export interface UploadRouteDeps {
  db: Db;
  ingestion: Ingestion;
  /** Defaults to `handleUpload` of `@vercel/blob/client`, loaded on first use. */
  handleUpload?: HandleUpload;
}

/** The body of the request a browser's `upload()` makes to get a token (the only kind this server answers). */
const TokenRequestSchema = z.object({
  type: z.literal('blob.generate-client-token'),
  payload: z.object({
    pathname: z.string().max(200),
    multipart: z.boolean(),
    clientPayload: z.string().max(2000).nullable(),
  }),
});

const notBlobMode = (): AppError =>
  new AppError(
    'FILE_MISSING',
    'Uploads go straight to this server here: send the PDF as multipart/form-data.',
  );

const ticketRefused = (): AppError =>
  new AppError(
    'FILE_MISSING',
    'This upload was not started here; ask for a new upload ticket.',
    DETAIL_TICKET_REFUSED,
  );

const multipartRefused = (): AppError =>
  new AppError(
    'FILE_MISSING',
    'Send the file in one request (multipart: false): a multipart upload is not accepted here.',
    DETAIL_MULTIPART_REFUSED,
  );

const ticketUsed = (): AppError =>
  new AppError(
    'FILE_MISSING',
    'This upload ticket was used already; ask for a new upload ticket.',
    DETAIL_TICKET_USED,
  );

export function registerUploadRoutes(app: FastifyInstance, config: Config, deps: UploadRouteDeps): void {
  const { db, ingestion } = deps;
  const blobMode = config.storageProvider === 'vercel-blob';
  const limits = uploadLimits(app, config);

  // --- POST /api/uploads/ticket ---
  app.post('/api/uploads/ticket', async (request, reply): Promise<UploadTicket> => {
    void reply.header('Cache-Control', 'no-store');
    if (!blobMode) return { mode: 'direct', maxBytes: config.maxUploadBytes };
    // The line first, before anything is counted: a visitor turned away because the archive is busy has not used up an upload.
    if (await ingestion.isFull(request.sessionId)) throw archiveBusy();
    // A ticket is the start of an upload: it is what the per-session and per-address upload limits count in this mode (the
    // multipart route counts them in the other). Given back when the archive's own budgets turn the ticket away below.
    await limits.ip(request, reply);
    await limits.session(request, reply);
    return limits.refundingRefusals(request, async () => {
      // The blobs of tickets that are over are settled here too: the cron runs once a day, and a store this small cannot wait.
      await ingestion.reclaimTicketBlobs();
      const pathname = `${randomUUID()}.pdf`;
      const expiresAt = new Date(Date.now() + TICKET_TTL_MS);
      // Under the budgets of the store: its bytes and its write operations (429 "the archive is full for today" otherwise).
      await ingestion.blobBudgets.issueTicket(db, {
        pathname,
        sessionId: request.sessionId,
        maxBytes: config.maxUploadBytes,
        expiresAt,
      });
      return {
        mode: 'blob',
        maxBytes: config.maxUploadBytes,
        pathname,
        clientPayload: signTicket(config.sessionSecret, {
          sub: ticketSubject(config.sessionSecret, request.sessionId),
          pathname,
          exp: expiresAt.getTime(),
        }),
        handleUploadUrl: BLOB_TOKEN_ROUTE,
      };
    });
  });

  // --- POST /api/uploads/blob: the token the browser uploads with ---
  app.post(BLOB_TOKEN_ROUTE, async (request, reply) => {
    if (!blobMode) throw notBlobMode();
    void reply.header('Cache-Control', 'no-store');
    const body = TokenRequestSchema.parse(request.body);
    const handleUpload = deps.handleUpload ?? (await import('@vercel/blob/client')).handleUpload;
    return handleUpload({
      body,
      request: request.raw,
      ...(config.blobReadWriteToken === null ? {} : { token: config.blobReadWriteToken }),
      onBeforeGenerateToken: async (pathname, clientPayload, multipart) => {
        // A single put, never a multipart upload: that is several advanced operations of a small quota for one file, and a
        // client token does not bind it, so the server is the only one who can refuse it.
        if (multipart) throw multipartRefused();
        const ticket = readTicket(config.sessionSecret, clientPayload);
        // Only the pathname this session was given, and only while its ticket is open: the client cannot name its own (a name
        // that is another document's key), a ticket of another session is worth nothing, and a ticket that made a document (or
        // was refused) is not given a token again. The token carries no payload: nothing of the session goes to the page.
        const valid =
          ticket !== null &&
          ticket.sub === ticketSubject(config.sessionSecret, request.sessionId) &&
          ticket.pathname === pathname &&
          isStorageKey(pathname) &&
          (await uploadTicketsRepo.isOpenFor(db, pathname, request.sessionId));
        if (!valid) throw ticketRefused();
        return {
          allowedContentTypes: ['application/pdf'],
          maximumSizeInBytes: config.maxUploadBytes,
          addRandomSuffix: false,
          allowOverwrite: false,
          // Minutes, not the ticket's half hour: the token is a bearer, good until then for whoever holds it, and a blob can be
          // put again under the pathname once its document is deleted. (The ticket stays open for the upload to ask again.)
          validUntil: Math.min(ticket.exp, Date.now() + CLIENT_TOKEN_TTL_MS),
        };
      },
    });
  });
}

/**
 * The blobs being made into documents right now: a second call for one of them (a retry) joins the first, and shares its work.
 * The work is stopped only when EVERY request that joined it has gone (`live` counts those still there): a client that retries
 * after its own timeout has closed its first connection, and that must not abort what the retry is waiting for.
 */
interface SharedWork {
  promise: Promise<ReturnType<typeof toDocumentSummary>>;
  controller: AbortController;
  live: number;
}
const inFlight = new Map<string, SharedWork>();

/** A request takes part in `work`; its going away stops the work only if it was the last one. */
function join(work: SharedWork, signal: AbortSignal): void {
  work.live += 1;
  const leave = (): void => {
    work.live -= 1;
    if (work.live === 0) {
      work.controller.abort(
        signal.reason instanceof Error
          ? signal.reason
          : new DOMException('The client went away', 'AbortError'),
      );
    }
  };
  if (signal.aborted) {
    leave();
    return;
  }
  signal.addEventListener('abort', leave, { once: true });
  const done = (): void => signal.removeEventListener('abort', leave);
  work.promise.then(done, done);
}

/**
 * `POST /api/documents` with a JSON body: makes the document from the blob the browser uploaded under a ticket. Returns the
 * summary (202), or throws. A repeated call for the same ticket returns the same document, and nothing else: a ticket makes
 * one document.
 */
export function createDocumentFromBlob(
  config: Config,
  deps: { db: Db; ingestion: Ingestion },
  request: { body: unknown; sessionId: string },
  signal: AbortSignal,
): Promise<ReturnType<typeof toDocumentSummary>> {
  if (config.storageProvider !== 'vercel-blob') return Promise.reject(notBlobMode());
  const { blobPathname, filename, ticket } = CreateDocumentFromBlobSchema.parse(request.body);
  // Before anything is asked of the database or the store: the ticket is the server's own, for this session and this blob.
  const payload = readTicket(config.sessionSecret, ticket);
  if (
    payload?.pathname !== blobPathname ||
    payload.sub !== ticketSubject(config.sessionSecret, request.sessionId)
  ) {
    return Promise.reject(ticketRefused());
  }
  const id = blobPathname.slice(0, -'.pdf'.length);
  const mapKey = `${request.sessionId}:${id}`;
  let work = inFlight.get(mapKey);
  if (work === undefined || work.controller.signal.aborted) {
    // (Work that every request had left is dead: a new request starts it again.)
    const controller = new AbortController();
    const started: SharedWork = {
      controller,
      live: 0,
      promise: makeDocumentFromBlob(
        config,
        deps,
        { id, filename, sessionId: request.sessionId },
        controller.signal,
      ).finally(() => {
        if (inFlight.get(mapKey) === started) inFlight.delete(mapKey);
      }),
    };
    inFlight.set(mapKey, started);
    work = started;
  }
  join(work, signal);
  return work.promise;
}

async function makeDocumentFromBlob(
  config: Config,
  deps: { db: Db; ingestion: Ingestion },
  blob: { id: string; filename: string | undefined; sessionId: string },
  signal: AbortSignal,
): Promise<ReturnType<typeof toDocumentSummary>> {
  const { db, ingestion } = deps;
  const { id, sessionId } = blob;
  const key = `${id}.pdf`;

  // The ticket the server recorded: this session's, and not used before. A ticket that made a document gives that document
  // again (a client that did not see the answer); a ticket that was used for anything else is worth nothing.
  const ticket = await uploadTicketsRepo.find(db, key);
  if (ticket?.session_id !== sessionId) throw ticketRefused();
  if (ticket.claimed_at !== null) {
    const made = ticket.document_id === null ? null : await documentsRepo.findById(db, ticket.document_id);
    if (made?.session_id === sessionId) return toDocumentSummary(made);
    throw ticketUsed();
  }

  // A busy archive is refused BEFORE the store is touched: waiting for a place in the line costs no read of a blob of up to
  // MAX_UPLOAD_MB (the blob and the ticket stay, and the answer says how long to wait). The in-transaction check of the line
  // in `createDocumentFor` stays, for the race.
  if (await ingestion.isFull(sessionId)) throw archiveBusy();
  // And the store is asked for the blob of one ticket only a few times.
  await ingestion.blobBudgets.requireTicketRead(db, key);

  // A blob that cannot be asked about right now (the store did not answer) is a reason to try again, not a verdict: the
  // blob stays, and so does the ticket.
  const info = await ingestion.storage.stat(key).catch((error: unknown) => {
    if (error instanceof StorageError) throw storageUnavailable();
    throw error;
  });
  if (info === null) throw missingBlob();
  // From here on a verdict about the FILE (too big, not a PDF, ...) ends the blob and the ticket; anything else leaves both.
  const refuse = async (): Promise<void> => {
    await uploadTicketsRepo.burn(db, key).catch(() => undefined);
    await ingestion.storage.delete(key).catch(() => undefined);
  };
  if (info.size > config.maxUploadBytes) {
    await refuse();
    throw new AppError(
      'FILE_TOO_LARGE',
      'The file is larger than the maximum upload size.',
      detailTooLarge(config.maxUploadBytes),
    );
  }

  let scratchPath: string | null = null;
  try {
    const scratch = await streamToScratch(
      ingestion.storage.createReadStream(key),
      path.join(config.tmpDir, UPLOAD_SCRATCH_DIRECTORY),
      `${randomUUID()}${UPLOAD_SCRATCH_SUFFIX}`,
      config.maxUploadBytes,
    );
    scratchPath = scratch.path;
    const { pageCount } = await validateScratchPdf({ config, ingestion }, scratch, signal);
    const row = await createDocumentFor(
      { db, config, ingestion },
      {
        id,
        sessionId,
        filename: sanitizeDisplayFilename(blob.filename ?? 'document.pdf'),
        size: scratch.size,
        sha256: scratch.sha256,
        pageCount,
        storageKey: key,
        ticket: key,
      },
    );
    return toDocumentSummary(row);
  } catch (error) {
    // The document was made meanwhile by another request for the same ticket (another instance): that is the answer, and the
    // blob is its file. (Nothing is deleted before this look.)
    const raced = await documentsRepo.findById(db, id).catch(() => null);
    if (raced?.session_id === sessionId) return toDocumentSummary(raced);
    // Only a verdict about the file ends the blob (not a PDF, too many pages, ...). A busy archive, a store that did not
    // answer, a database that dropped the connection: the blob and the ticket stay for the retry.
    if (isVerdictAboutFile(error)) await refuse();
    // A blob that cannot be read back is a store that does not answer right now.
    if (error instanceof StorageError) {
      throw error.kind === 'NOT_FOUND' ? missingBlob() : storageUnavailable();
    }
    throw error;
  } finally {
    if (scratchPath !== null) await rm(scratchPath, { force: true });
  }
}

const missingBlob = (): AppError =>
  new AppError(
    'FILE_MISSING',
    'The upload did not arrive; try uploading the file again.',
    DETAIL_NO_SUCH_BLOB,
  );

const storageUnavailable = (): AppError =>
  new AppError('STORAGE_FAILED', 'The upload could not be read just now; try again in a moment.');
