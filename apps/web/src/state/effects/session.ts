import { SessionDocumentResponseSchema, type SessionDocumentResponse } from '@enchanted/shared';
import { ApiError, getJson } from '../../api/client';
import { documentStore, type DocumentStore } from '../documentStore';
import { experienceStore, type ExperienceStore } from '../experience';

/** Longest the first screen waits for the session check before assuming there is no document. */
export const SESSION_CHECK_TIMEOUT_MS = 2000;

export interface SessionEffectOptions {
  timeoutMs?: number;
  fetchSessionDocument?: (signal: AbortSignal) => Promise<SessionDocumentResponse>;
  experience?: Pick<ExperienceStore, 'getState'>;
  documents?: Pick<DocumentStore, 'getState'>;
}

/** How long a check that has been given up on is still listened to (a cold function plus a sleeping database take a while). */
export const LATE_ANSWER_LIMIT_MS = 20_000;

/** Waits before asking again after a transient failure (network or 5xx); the last one repeats. */
export const SESSION_RETRY_MS: readonly number[] = [500, 1000, 2000, 4000, 5000];
const SESSION_RETRY_LAST_MS = 5000;

/**
 * Boot check: asks the server whether this session already holds a document, then dispatches SESSION_CHECKED. The
 * experience must never wait on the network: a timeout, a 404 (the session has nothing, or the endpoint does not exist yet)
 * and any failure all mean "no document" to the start button; a network or 5xx failure is also asked again with a backoff
 * (0.5 s, 1 s, 2 s, 4 s, then every 5 s), so a document that exists still arrives once the API is up. After a timeout the request is NOT cancelled: if it answers within
 * `LATE_ANSWER_LIMIT_MS` with a document while the closed book is still untouched, that is dispatched too (a second
 * SESSION_CHECKED, which the reducer accepts only for a document), so a reload on a slow cold start still resumes a reading
 * or restores a book. Returns the function that cancels the check.
 */
export function startSessionEffect(options: SessionEffectOptions = {}): () => void {
  const {
    timeoutMs = SESSION_CHECK_TIMEOUT_MS,
    fetchSessionDocument = (signal) =>
      getJson('/api/session/document', SessionDocumentResponseSchema, { signal }),
    experience = experienceStore,
    documents = documentStore,
  } = options;

  let finished = false;
  let stopped = false;
  let attemptController: AbortController | undefined;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;

  const finish = (document: SessionDocumentResponse['document']): void => {
    if (stopped) return;
    if (finished) {
      // Late: only worth anything while the book is closed and has been asked nothing.
      const { phase, restored, documentId } = experience.getState();
      if (document && phase === 'discovery' && !restored && documentId === null) {
        documents.getState().setDocument(document);
        experience.getState().dispatch({ type: 'SESSION_CHECKED', document });
      }
      return;
    }
    finished = true;
    clearTimeout(timer);
    if (document) documents.getState().setDocument(document);
    experience.getState().dispatch({ type: 'SESSION_CHECKED', document });
  };

  // The start button never waits longer than this, whatever the network does: after it, "no document" is assumed.
  const timer = setTimeout(() => {
    finish(null);
  }, timeoutMs);

  const attempt = (number: number): void => {
    const controller = new AbortController();
    attemptController = controller;
    let settled = false;
    const retry = (): void => {
      if (settled || stopped) return;
      settled = true;
      const delay = SESSION_RETRY_MS[Math.min(number, SESSION_RETRY_MS.length - 1)] ?? SESSION_RETRY_LAST_MS;
      retryTimer = setTimeout(() => {
        attempt(number + 1);
      }, delay);
    };
    const limit = setTimeout(() => {
      controller.abort();
      retry(); // a request that hangs is as good as a failed one
    }, LATE_ANSWER_LIMIT_MS);
    fetchSessionDocument(controller.signal).then(
      (response) => {
        clearTimeout(limit);
        if (settled) return;
        settled = true;
        finish(response.document);
      },
      (error: unknown) => {
        clearTimeout(limit);
        if (settled || stopped) return;
        const transient =
          error instanceof ApiError &&
          (error.code === 'NETWORK' || (error.status !== null && error.status >= 500));
        if (transient) {
          // The API may still be starting (a 502 from the proxy): ask again, a little later each time.
          retry();
          return;
        }
        settled = true;
        const expected = error instanceof ApiError && error.status === 404;
        if (!expected && import.meta.env.DEV) {
          console.warn('[session] could not check for an existing document', error);
        }
        finish(null);
      },
    );
  };
  attempt(0);

  return () => {
    stopped = true;
    clearTimeout(timer);
    clearTimeout(retryTimer);
    attemptController?.abort();
  };
}
