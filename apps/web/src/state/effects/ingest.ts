import type { DocumentDetail, IngestTickResponse } from '@enchanted/shared';
import { ApiError, isAbortError, type UiError } from '../../api/client';
import { deleteDocument, progressDocument, tickDocument } from '../../api/documents';
import { fallbackText } from '../../i18n/fallbackText';
import { documentStore, type DocumentStore } from '../documentStore';
import { experienceStore, type ExperienceStore } from '../experience';

/** Pauses between ticks after a failure: 1 s, 2 s, 4 s, ... up to this. */
export const BACKOFF_CAP_MS = 15_000;
/** A rate-limited tick waits at least this long (the tick limit is per minute). */
export const RATE_LIMIT_WAIT_MS = 20_000;
/** Consecutive failed ticks (no answer, 5xx) before the diary gives up: the server's own rule is three; a network is patient. */
export const MAX_CONSECUTIVE_FAILURES = 8;
/** A tab that does not drive the ingestion (another tab does) looks at how far it is this often. */
export const FOLLOW_POLL_MS = 4000;

/** The part of `navigator.locks` the effect uses (absent in older browsers and in tests: then one tab simply drives). */
export interface LockApi {
  request<T>(
    name: string,
    options: { ifAvailable: true },
    callback: (lock: object | null) => Promise<T> | T,
  ): Promise<T>;
}

export interface IngestEffectOptions {
  experience?: Pick<ExperienceStore, 'getState' | 'subscribe'>;
  documents?: Pick<DocumentStore, 'getState'>;
  tick?: (documentId: string, signal: AbortSignal) => Promise<IngestTickResponse>;
  /** `GET /progress`: how far another tab's ticking has got (this tab does not drive that document). */
  follow?: (documentId: string, signal: AbortSignal) => Promise<IngestTickResponse>;
  /** One tab per document drives the ingestion: the one that holds this lock. Undefined: no lock, this tab drives. */
  locks?: LockApi | null;
  /** False while the browser knows it is offline: the loop waits for the network instead of counting failures. */
  online?: () => boolean;
  /** Resolves when the network is back (or on abort). */
  whenOnline?: (signal: AbortSignal) => Promise<void>;
  remove?: (documentId: string) => Promise<void>;
  /** Resolves after `ms`, or sooner when the page is shown or comes back online (parked documents), or when aborted. */
  wait?: (ms: number, signal: AbortSignal, wakeEarly: boolean) => Promise<void>;
  now?: () => number;
}

/** Waits `ms`, ends early on abort, and (for a long wait) when the reader returns to the page or the network comes back. */
export function waitWithWake(ms: number, signal: AbortSignal, wakeEarly: boolean): Promise<void> {
  return new Promise((resolve) => {
    const finish = (): void => {
      clearTimeout(timer);
      signal.removeEventListener('abort', finish);
      if (wakeEarly) {
        document.removeEventListener('visibilitychange', onVisible);
        window.removeEventListener('online', finish);
      }
      resolve();
    };
    const onVisible = (): void => {
      if (document.visibilityState === 'visible') finish();
    };
    const timer = setTimeout(finish, ms);
    signal.addEventListener('abort', finish, { once: true });
    if (wakeEarly) {
      document.addEventListener('visibilitychange', onVisible);
      window.addEventListener('online', finish, { once: true });
    }
  });
}

/** Resolves when the browser says the network is back, or when aborted. */
export function waitForOnline(signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const finish = (): void => {
      window.removeEventListener('online', finish);
      signal.removeEventListener('abort', finish);
      resolve();
    };
    window.addEventListener('online', finish, { once: true });
    signal.addEventListener('abort', finish, { once: true });
  });
}

function defaultLocks(): LockApi | null {
  return typeof navigator !== 'undefined' && 'locks' in navigator ? navigator.locks : null;
}

function backoff(failures: number): number {
  return Math.min(1000 * 2 ** Math.max(0, failures - 1), BACKOFF_CAP_MS);
}

function failureOf(error: unknown): UiError {
  return error instanceof ApiError
    ? error.toUiError()
    : { code: 'INTERNAL', message: fallbackText().readingInterrupted };
}

/**
 * The ingestion side effect. While the diary is `reading`, the browser drives the server's work: it asks
 * `POST /documents/:id/tick` over and over (each call is a bounded step that returns the real progress) until the document
 * is `ready` or `failed`. One loop per document; it starts when `reading` is entered (after an upload, or when a session
 * that left a processing document is restored) and stops when `reading` is left.
 *  - `retryAfterMs` is honoured (the line is full, a rate limit holds it, another tick holds the lease).
 *  - A parked document (the daily quota of the model service is used up) shows its pause and ticks again when it is
 *    due, or as soon as the reader comes back to the page.
 *  - A dropped connection, a 504 and a 5xx are "tick again", with a growing pause; a 429 waits out the rate limit; a 404
 *    means the document is gone (deleted, replaced or expired) and ends the reading.
 *  - A rate limit waits as long as the server's `Retry-After` says (at least a second, 20 s when it says nothing).
 *  - While the browser is offline the loop waits for the network and counts nothing: a spell without a connection does
 *    not end the reading.
 *  - One tab drives a document (it holds the Web Lock `ed-tick:<id>`); another tab that restores the same reading only
 *    follows it with `GET /progress` and takes over if the driver goes away: two loops would share the tick limit and
 *    stall each other.
 *  - Withdrawing (CANCEL) stops the loop and deletes the document.
 * On `ready` the document goes into the document store BEFORE INGEST_READY is dispatched (the book is built from it).
 */
export function startIngestEffect(options: IngestEffectOptions = {}): () => void {
  const experience = options.experience ?? experienceStore;
  const documents = options.documents ?? documentStore;
  const tick = options.tick ?? ((id, signal) => tickDocument(id, signal));
  const remove = options.remove ?? ((id) => deleteDocument(id));
  const wait = options.wait ?? waitWithWake;
  const now = options.now ?? (() => Date.now());
  const follow = options.follow ?? ((id, signal) => progressDocument(id, signal));
  const locks = options.locks === undefined ? defaultLocks() : options.locks;
  const online = options.online ?? (() => typeof navigator === 'undefined' || navigator.onLine);
  const whenOnline = options.whenOnline ?? waitForOnline;

  let running: { controller: AbortController; documentId: string; epoch: number } | null = null;

  const live = (controller: AbortController, epoch: number): boolean =>
    !controller.signal.aborted &&
    experience.getState().phase === 'reading' &&
    experience.getState().epoch === epoch;

  const finishReady = (document: DocumentDetail): void => {
    documents.getState().setIngestPause(null);
    documents.getState().setDocument(document);
    documents.getState().setIngestProgress(null);
    experience.getState().dispatch({ type: 'INGEST_READY', document });
  };

  const fail = (error: UiError): void => {
    documents.getState().setIngestPause(null);
    experience.getState().dispatch({ type: 'INGEST_FAILED', error });
  };

  async function loop(documentId: string, controller: AbortController, epoch: number): Promise<void> {
    let failures = 0;
    while (live(controller, epoch)) {
      let response: IngestTickResponse;
      try {
        response = await tick(documentId, controller.signal);
      } catch (error) {
        if (!live(controller, epoch) || isAbortError(error)) return;
        if (error instanceof ApiError && error.code === 'DOCUMENT_NOT_FOUND') {
          fail(error.toUiError());
          return;
        }
        if (error instanceof ApiError && error.status === 429) {
          // As long as the server said (a rate limit's window), and at least a second; 20 s when it said nothing.
          const pause = Math.max(error.retryAfterMs ?? RATE_LIMIT_WAIT_MS, 1000);
          documents.getState().setIngestPause({ kind: 'waiting', retryAt: now() + pause });
          await wait(pause, controller.signal, true);
          continue;
        }
        // Offline: nothing is lost by waiting for the network, and a failure that is only the missing network is not counted.
        if (error instanceof ApiError && error.code === 'NETWORK' && !online()) {
          documents.getState().setIngestPause({ kind: 'waiting', retryAt: now() });
          await whenOnline(controller.signal);
          continue;
        }
        // A 4xx other than those is the server's verdict about the request, not a hiccup: ticking again cannot change it.
        if (
          error instanceof ApiError &&
          error.status !== null &&
          error.status >= 400 &&
          error.status < 500 &&
          error.status !== 408
        ) {
          fail(error.toUiError());
          return;
        }
        failures += 1;
        if (failures >= MAX_CONSECUTIVE_FAILURES) {
          fail(failureOf(error));
          return;
        }
        const pause = backoff(failures);
        documents.getState().setIngestPause({ kind: 'waiting', retryAt: now() + pause });
        await wait(pause, controller.signal, false);
        continue;
      }
      if (!live(controller, epoch)) return;
      failures = 0;
      documents.getState().setIngestProgress(response.progress);
      switch (response.status) {
        case 'ready':
          if (response.document) finishReady(response.document);
          else fail({ code: 'INTERNAL', message: fallbackText().readyButEmpty });
          return;
        case 'failed':
          fail(response.error ?? { code: 'INTERNAL', message: fallbackText().readingFailed });
          return;
        case 'parked': {
          const pause = response.retryAfterMs ?? RATE_LIMIT_WAIT_MS;
          documents.getState().setIngestPause({
            kind: 'parked',
            retryAt: now() + pause,
            ...(response.progress.detail === undefined ? {} : { detail: response.progress.detail }),
          });
          await wait(pause, controller.signal, true);
          break;
        }
        case 'running':
          if (response.retryAfterMs !== undefined && response.retryAfterMs > 0) {
            documents.getState().setIngestPause({ kind: 'waiting', retryAt: now() + response.retryAfterMs });
            await wait(response.retryAfterMs, controller.signal, false);
          } else {
            documents.getState().setIngestPause(null);
          }
          break;
      }
    }
  }

  /** Looks at how far another tab's ticking has got; true when the reading is over (ready, failed or gone). */
  async function followOnce(
    documentId: string,
    controller: AbortController,
    epoch: number,
  ): Promise<boolean> {
    let response: IngestTickResponse;
    try {
      response = await follow(documentId, controller.signal);
    } catch (error) {
      if (!live(controller, epoch) || isAbortError(error)) return true;
      if (error instanceof ApiError && error.status !== null && error.status >= 400 && error.status < 500) {
        fail(error.toUiError());
        return true;
      }
      return false; // no answer just now: look again
    }
    if (!live(controller, epoch)) return true;
    documents.getState().setIngestProgress(response.progress);
    if (response.status === 'ready' && response.document) {
      finishReady(response.document);
      return true;
    }
    if (response.status === 'failed') {
      fail(response.error ?? { code: 'INTERNAL', message: fallbackText().readingFailed });
      return true;
    }
    if (response.status === 'parked') {
      documents.getState().setIngestPause({
        kind: 'parked',
        retryAt: now() + (response.retryAfterMs ?? RATE_LIMIT_WAIT_MS),
        ...(response.progress.detail === undefined ? {} : { detail: response.progress.detail }),
      });
    } else {
      documents.getState().setIngestPause(null);
    }
    return false;
  }

  /** Drives the document if this tab can hold its lock; otherwise follows the tab that does, and takes over when it goes. */
  async function drive(documentId: string, controller: AbortController, epoch: number): Promise<void> {
    if (!locks) {
      await loop(documentId, controller, epoch);
      return;
    }
    while (live(controller, epoch)) {
      const led = await locks.request(`ed-tick:${documentId}`, { ifAvailable: true }, async (lock) => {
        if (lock === null) return false;
        await loop(documentId, controller, epoch);
        return true;
      });
      if (led) return;
      if (await followOnce(documentId, controller, epoch)) return;
      await wait(FOLLOW_POLL_MS, controller.signal, true);
    }
  }

  const unsubscribe = experience.subscribe((state, previous) => {
    if (state.epoch === previous.epoch) return;
    if (state.phase === 'reading' && state.documentId) {
      running?.controller.abort();
      const controller = new AbortController();
      running = { controller, documentId: state.documentId, epoch: state.epoch };
      documents.getState().setIngestPause(null);
      void drive(state.documentId, controller, state.epoch);
      return;
    }
    if (running && state.phase !== 'reading') {
      const { controller, documentId } = running;
      running = null;
      controller.abort();
      documents.getState().setIngestPause(null);
      // Withdrawn (CANCEL): the document is deleted. When the reading ended by itself (ready, failed) nothing is left to withdraw.
      if (previous.phase === 'reading' && state.phase === 'awaiting' && state.error === null) {
        remove(documentId).catch((error: unknown) => {
          console.warn('[ingest] the withdrawn document could not be deleted', error);
        });
      }
    }
  });

  return () => {
    unsubscribe();
    // Stopping the effect must not leave a loop ticking: the request in flight is aborted with it.
    if (running) {
      running.controller.abort();
      running = null;
    }
  };
}
