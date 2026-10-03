import {
  CreateDocumentResponseSchema,
  UploadTicketSchema,
  type DocumentSummary,
  type UploadTicket,
} from '@enchanted/shared';
import { ApiError, isAbortError, postJson, readApiError } from './client';
import { flavourOf, ticketIsGone } from './errorDetail';

/*
 * Offering a file to the server, the two ways the server's ticket can say (global section P):
 *  - direct (development, self-hosting): one multipart POST by XHR, with the real bytes sent as progress;
 *  - Blob: the browser puts the file in the private Blob store under a single-use ticket (the SDK's `upload()` with the
 *    server's `handleUpload` route, one single put, never multipart), then asks the server to make the document from it. The
 *    put costs one of the store's few writes a day; the create is cheap and can be repeated a little: so the two are SEPARATE
 *    steps. The ticket and the fact that the put landed are remembered for the offer, and a create that failed for a reason
 *    that passes (the line is full, a dropped connection) is repeated with the SAME ticket, at most twice (the server reads the
 *    store three times for a ticket), instead of throwing the blob away and paying a new ticket and a new write.
 */

export interface UploadProgress {
  loaded: number;
  total: number;
}

export interface UploadOptions {
  signal?: AbortSignal;
  /** Real bytes sent so far. */
  onProgress?: (progress: UploadProgress) => void;
  /** The upload is pausing by itself until `retryAt` (epoch ms), or goes on again (null): the archive is busy, the net dropped. */
  onWaiting?: (retryAt: number | null) => void;
  /** The id the document will have, as soon as the file may be on its way to being one (Blob mode: the blob's name). */
  onDocumentId?: (id: string) => void;
  /** Replaceable in tests: resolves after `ms`, or when `signal` aborts. */
  wait?: (ms: number, signal: AbortSignal | undefined) => Promise<void>;
  now?: () => number;
}

type BlobTicket = Extract<UploadTicket, { mode: 'blob' }>;

/** How long a ticket is worth reusing: the server's is good for half an hour; a repeat that late would only be refused. */
export const TICKET_REUSE_MS = 25 * 60_000;
/**
 * Creates that are repeated after the first (a busy 429 or no answer at all; never a 5xx, which may have read the store): the
 * server reads the store at most three times for one ticket, so at most three creates are sent for it, 3 attempts in all.
 */
export const CREATE_RETRIES = 2;
export const MAX_CREATES_PER_TICKET = CREATE_RETRIES + 1;
/** A busy archive that sent no `Retry-After`: its places come free about this often. */
export const BUSY_WAIT_MS = 10_000;
/** The longest a `Retry-After` is waited for; a longer one is told to the reader instead of waited out. */
export const BUSY_WAIT_CAP_MS = 120_000;
/** The server keeps 120 characters of a file name, and refuses a request whose name is over 255. */
export const FILENAME_MAX_CHARS = 120;

const tooLarge = (maxBytes: number): ApiError =>
  new ApiError(
    'FILE_TOO_LARGE',
    'The file is larger than the maximum upload size.',
    null,
    `limit ${String(maxBytes)} bytes`,
  );

const cancelled = (): DOMException => new DOMException('The upload was cancelled', 'AbortError');

/** A file name that fits what the server accepts, keeping the end of it (the extension). */
export function clampFilename(name: string): string {
  const letters = Array.from(name);
  if (letters.length <= FILENAME_MAX_CHARS) return name;
  const extension = /\.[a-z0-9]{1,8}$/iu.exec(name)?.[0] ?? '';
  return `${letters.slice(0, FILENAME_MAX_CHARS - extension.length).join('')}${extension}`;
}

/** Direct mode (development and self-hosting): a multipart POST by XHR, which, unlike fetch, reports the bytes it has sent. */
export function uploadDirect(file: File, options: UploadOptions = {}): Promise<DocumentSummary> {
  const { signal, onProgress } = options;
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    const form = new FormData();
    form.append('file', file, file.name);
    const finish = (settle: () => void): void => {
      signal?.removeEventListener('abort', onAbort);
      settle();
    };
    const onAbort = (): void => {
      request.abort();
    };
    request.open('POST', '/api/documents');
    request.responseType = 'text';
    request.setRequestHeader('Accept', 'application/json');
    request.upload.onprogress = (event) => {
      if (!event.lengthComputable) return;
      // The multipart body is a few hundred bytes more than the file: never report more than the file has.
      onProgress?.({ loaded: Math.min(event.loaded, file.size), total: file.size });
    };
    request.onload = () => {
      let body: unknown;
      try {
        body = JSON.parse(request.responseText);
      } catch {
        body = undefined;
      }
      if (request.status >= 200 && request.status < 300) {
        const parsed = CreateDocumentResponseSchema.safeParse(body);
        finish(() => {
          if (parsed.success) resolve(parsed.data.document);
          else
            reject(
              new ApiError('INTERNAL', 'The server sent a response in an unexpected shape', request.status),
            );
        });
        return;
      }
      void readApiError(
        new Response(request.responseText, { status: request.status, statusText: request.statusText }),
      ).then((error) => {
        finish(() => {
          reject(error);
        });
      });
    };
    request.onerror = () => {
      finish(() => {
        reject(new ApiError('NETWORK', 'The upload could not be sent'));
      });
    };
    request.onabort = () => {
      finish(() => {
        reject(cancelled());
      });
    };
    if (signal?.aborted) {
      reject(cancelled());
      return;
    }
    signal?.addEventListener('abort', onAbort, { once: true });
    request.send(form);
  });
}

/** What the browser keeps of one Blob offer between attempts: the ticket, and whether the file is in the store already. */
interface BlobOffer {
  key: string;
  ticket: BlobTicket;
  issuedAt: number;
  putDone: boolean;
  /** Creates sent for this ticket so far (the server allows its store reads three times). */
  creates: number;
}

let remembered: BlobOffer | null = null;

/** Lets go of the remembered offer (the session was reset, or a test starts afresh). */
export function forgetBlobOffer(): void {
  remembered = null;
}

const offerKey = (file: File): string =>
  `${file.name}\u0000${String(file.size)}\u0000${String(file.lastModified)}`;

/** What `blobError` says when the SDK could not get a client token from the server's route. */
const CLIENT_TOKEN_REFUSED = 'Failed to retrieve the client token';
const isTokenRefused = (error: unknown): boolean =>
  error instanceof ApiError && (error.detail ?? '').includes(CLIENT_TOKEN_REFUSED);

/** The Blob SDK's errors carry a message of its own; a browser that could not reach the store is a network failure. */
function blobError(error: unknown): ApiError {
  const message = error instanceof Error ? error.message : 'The file could not be sent to the archive';
  if (error instanceof ApiError) return error;
  if (error instanceof TypeError || /fetch|network/iu.test(message)) return new ApiError('NETWORK', message);
  if (/too many requests|rate.?limit/iu.test(message)) {
    const seconds = Number(/retry in (\d+)/iu.exec(message)?.[1]);
    return new ApiError(
      'RATE_LIMITED',
      'The store is busy.',
      null,
      message.slice(0, 200),
      Number.isFinite(seconds) ? seconds * 1000 : undefined,
    );
  }
  if (/client token/iu.test(message)) {
    // The store's token route refused (the ticket is spent or not this session's): a new ticket is needed.
    return new ApiError(
      'STORAGE_FAILED',
      'The archive gave no place to put the file.',
      null,
      CLIENT_TOKEN_REFUSED,
    );
  }
  return new ApiError('STORAGE_FAILED', 'The file could not be stored.', null, message.slice(0, 200));
}

async function putBlob(file: File, ticket: BlobTicket, options: UploadOptions): Promise<void> {
  const { signal, onProgress } = options;
  const { upload } = await import('@vercel/blob/client');
  try {
    await upload(ticket.pathname, file, {
      access: 'private',
      handleUploadUrl: ticket.handleUploadUrl,
      clientPayload: ticket.clientPayload,
      multipart: false,
      contentType: 'application/pdf',
      ...(signal ? { abortSignal: signal } : {}),
      onUploadProgress: ({ loaded, total }) => {
        onProgress?.({ loaded: Math.min(loaded, file.size), total: total > 0 ? total : file.size });
      },
    });
  } catch (error) {
    if (isAbortError(error) || signal?.aborted) throw cancelled();
    throw blobError(error);
  }
}

function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve) => {
    const done = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener('abort', done, { once: true });
  });
}

const isBusy = (error: ApiError): boolean => error.status === 429 || error.code === 'RATE_LIMITED';

/**
 * Whether a failed create is a "not now" worth repeating with the same ticket: the line is full (not the day's budget, not a
 * worn-out ticket) or no answer came. Anything else, a 5xx included (it may have read the store), is told to the reader.
 */
function passes(error: unknown): error is ApiError {
  if (!(error instanceof ApiError)) return false;
  if (isBusy(error)) {
    const flavour = flavourOf(error);
    return flavour !== 'archiveFull' && flavour !== 'ticketTries';
  }
  return error.code === 'NETWORK';
}

/** The pause before the create is repeated, or null when repeating cannot help (a verdict, the day's budget, too long a wait). */
function pauseBeforeRepeat(error: unknown, failures: number): number | null {
  if (!passes(error)) return null;
  if (isBusy(error)) {
    // The line is full (or a limit holds): a place comes free later. Wait as the server said, if it is not for long.
    const wait = Math.max(error.retryAfterMs ?? BUSY_WAIT_MS, 1000);
    return wait <= BUSY_WAIT_CAP_MS ? wait : null;
  }
  return 1000 * 2 ** failures;
}

/** `POST /api/documents { blobPathname, filename, ticket }`, repeated (same ticket) while the answer is "not now". */
async function createFromBlob(
  offer: BlobOffer,
  file: File,
  options: UploadOptions,
  repeats: boolean,
): Promise<DocumentSummary> {
  const { signal, onWaiting } = options;
  const wait = options.wait ?? sleep;
  const now = options.now ?? Date.now;
  const body = {
    blobPathname: offer.ticket.pathname,
    filename: clampFilename(file.name),
    ticket: offer.ticket.clientPayload,
  };
  let failures = 0;
  // From here on the document may exist on the server (a withdrawal must ask for it to be deleted).
  options.onDocumentId?.(offer.ticket.pathname.replace(/\.pdf$/u, ''));
  for (;;) {
    if (signal?.aborted) throw cancelled();
    try {
      offer.creates += 1;
      const created = await postJson('/api/documents', body, CreateDocumentResponseSchema, signal);
      onWaiting?.(null);
      return created.document;
    } catch (error) {
      if (isAbortError(error) || signal?.aborted) throw cancelled();
      // Three creates in all for a ticket (the server's store reads): the last failure is the news.
      const pause =
        repeats && offer.creates < MAX_CREATES_PER_TICKET ? pauseBeforeRepeat(error, failures) : null;
      if (pause === null) {
        onWaiting?.(null);
        throw error;
      }
      if (!(error instanceof ApiError && isBusy(error))) failures += 1;
      onWaiting?.(now() + pause);
      await wait(pause, signal);
    }
  }
}

/** Whether a failed create says only that the blob is not in the store (so a put, not a create, is what is missing). */
const isNoSuchBlob = (error: unknown): boolean =>
  error instanceof ApiError && flavourOf(error) === 'noSuchBlob';

/**
 * Blob mode: put the file (once) and make the document from it (repeated while it says "not now"). `offer` remembers how far
 * the offer got, so a second call for it goes on from there.
 */
async function runBlobOffer(offer: BlobOffer, file: File, options: UploadOptions): Promise<DocumentSummary> {
  if (!offer.putDone) {
    try {
      await putBlob(file, offer.ticket, options);
    } catch (putError) {
      if (isAbortError(putError)) throw putError;
      // No token was given (so nothing was put): there is no blob to look for.
      if (isTokenRefused(putError)) throw putError;
      // The put may have landed even though its answer did not (the SDK repeats a put, and a repeat of one that landed is
      // refused as "already exists"). One create settles it: the server looks for the blob.
      try {
        return await createFromBlob(offer, file, options, false);
      } catch (createError) {
        if (isAbortError(createError)) throw createError;
        if (
          isNoSuchBlob(createError) ||
          (createError instanceof ApiError && createError.code === 'NETWORK')
        ) {
          throw putError; // really not there (or nothing can be said): the put's own failure is the news
        }
        if (!passes(createError)) throw createError;
        // It is there; the archive is only busy: the create is repeated below (it has used one of its three).
      }
    }
    offer.putDone = true;
  }
  try {
    return await createFromBlob(offer, file, options, true);
  } catch (error) {
    // The store has no such blob after all: the next try puts it again (the ticket stays open for that).
    if (isNoSuchBlob(error)) offer.putDone = false;
    throw error;
  }
}

/** Blob mode for a ticket in hand: the file is put, then the document is made. Not remembered between calls. */
export function uploadViaBlob(
  file: File,
  ticket: BlobTicket,
  options: UploadOptions = {},
): Promise<DocumentSummary> {
  const now = options.now ?? Date.now;
  return runBlobOffer(
    { key: offerKey(file), ticket, issuedAt: now(), putDone: false, creates: 0 },
    file,
    options,
  );
}

/** `POST /api/uploads/ticket`: how this server wants a file uploaded (and, in Blob mode, the single-use ticket). */
export function requestUploadTicket(signal?: AbortSignal): Promise<UploadTicket> {
  return postJson('/api/uploads/ticket', undefined, UploadTicketSchema, signal);
}

/**
 * Offers a file: asks the server how (`POST /api/uploads/ticket`), checks the size against what the server says, and sends it
 * the way the ticket says. Resolves with the created (still processing) document: the server answered 202.
 * A repeat offer of the same file reuses its ticket (and the blob that is in the store already) while the ticket is open; a
 * new ticket is asked for only when the server refused or spent the old one.
 */
export async function uploadDocument(file: File, options: UploadOptions = {}): Promise<DocumentSummary> {
  const now = options.now ?? Date.now;
  for (let round = 0; ; round += 1) {
    const key = offerKey(file);
    let offer: BlobOffer;
    // (A ticket the server has read the store for three times is worn out: it would be refused as tried too often.)
    if (
      remembered?.key === key &&
      now() - remembered.issuedAt < TICKET_REUSE_MS &&
      remembered.creates < MAX_CREATES_PER_TICKET
    ) {
      offer = remembered;
    } else {
      remembered = null;
      const ticket = await requestUploadTicket(options.signal);
      if (file.size > ticket.maxBytes) throw tooLarge(ticket.maxBytes);
      if (ticket.mode === 'direct') return uploadDirect(file, options);
      offer = { key, ticket, issuedAt: now(), putDone: false, creates: 0 };
      remembered = offer;
    }
    if (file.size > offer.ticket.maxBytes) throw tooLarge(offer.ticket.maxBytes);
    try {
      const document = await runBlobOffer(offer, file, options);
      remembered = null; // the ticket made a document: it is spent
      return document;
    } catch (error) {
      if (isAbortError(error)) throw error;
      // No client token could be had: the ticket itself is refused or spent, so a new one is asked for.
      if (ticketIsGone(error) || isTokenRefused(error)) {
        remembered = null;
        if (round < 2) continue; // refused, spent or worn out: one more with a new ticket (and a new put)
        throw error;
      }
      // What a repeat can still use: the ticket, and whether the file is in the store. A verdict about the file (the server
      // deleted the blob and spent the ticket) or a token the store refused ends the offer.
      if (!keepsOffer(error)) remembered = null;
      throw error;
    }
  }
}

/** Whether the offer can be repeated after this failure (the file, the ticket and the blob are all still good). */
function keepsOffer(error: unknown): boolean {
  if (!(error instanceof ApiError)) return false;
  if (error.code === 'NETWORK' || error.code === 'STORAGE_FAILED') return true;
  if (error.status !== null && error.status >= 500) return true;
  if (error.code === 'RATE_LIMITED') return flavourOf(error) !== 'ticketTries';
  return flavourOf(error) === 'noSuchBlob';
}
