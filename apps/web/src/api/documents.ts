import {
  IngestTickResponseSchema,
  PublicConfigSchema,
  type IngestTickResponse,
  type PublicConfig,
} from '@enchanted/shared';
import { ApiError, fetchApi, getJson, isAbortError, postJson, readApiError } from './client';

// The upload calls live in ./uploads (they are long enough to have their own file); everything is still read from here.
export {
  clampFilename,
  forgetBlobOffer,
  requestUploadTicket,
  uploadDirect,
  uploadDocument,
  uploadViaBlob,
  type UploadOptions,
  type UploadProgress,
} from './uploads';

/*
 * Everything the browser asks the server about documents, in one place. Only the effects layer (state/effects) calls
 * these: components dispatch events and never touch the network.
 */

/** A tick can run 45 s plus the unit in flight and 240 s at the hard limit: the client waits longer than that. */
export const TICK_TIMEOUT_MS = 310_000;

export function fetchPublicConfig(signal?: AbortSignal): Promise<PublicConfig> {
  return getJson('/api/config', PublicConfigSchema, signal ? { signal } : {});
}

/** `POST /api/documents/:id/tick`: a bounded step of the ingestion; the answer carries the real progress. */
export function tickDocument(documentId: string, signal?: AbortSignal): Promise<IngestTickResponse> {
  const timeout = new AbortController();
  const timer = setTimeout(() => {
    timeout.abort(new DOMException('The step took too long', 'TimeoutError'));
  }, TICK_TIMEOUT_MS);
  const onAbort = (): void => {
    timeout.abort();
  };
  signal?.addEventListener('abort', onAbort, { once: true });
  return postJson(
    `/api/documents/${encodeURIComponent(documentId)}/tick`,
    undefined,
    IngestTickResponseSchema,
    timeout.signal,
  )
    .catch((error: unknown) => {
      // A step that outran its time is "tick again" (a dead tick's lease expires on the server), not a user's abort.
      if (!signal?.aborted && isAbortError(error)) throw new ApiError('NETWORK', 'The step took too long');
      throw error;
    })
    .finally(() => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    });
}

/** `GET /api/documents/:id/progress`: where the ingestion stands, without driving it (a second tab, a poll). */
export function progressDocument(documentId: string, signal?: AbortSignal): Promise<IngestTickResponse> {
  return getJson(`/api/documents/${encodeURIComponent(documentId)}/progress`, IngestTickResponseSchema, {
    ...(signal ? { signal } : {}),
  });
}

/**
 * `GET /api/documents/:id/file` (or the file URL the store holds): the stored PDF's bytes. Each of these is a read of the
 * Blob store that the server counts against a small global budget (section S.15: 260 MB a day), so the caller fetches a
 * document's file at most once per page load and keeps the bytes.
 */
export async function fetchDocumentFile(url: string, signal?: AbortSignal): Promise<ArrayBuffer> {
  const response = await fetchApi(url, { method: 'GET', ...(signal ? { signal } : {}) });
  if (!response.ok) throw await readApiError(response);
  return response.arrayBuffer();
}

/** `DELETE /api/documents/:id`. A 404 means it is gone already, which is what was asked for. */
export async function deleteDocument(documentId: string, signal?: AbortSignal): Promise<void> {
  const response = await fetchApi(`/api/documents/${encodeURIComponent(documentId)}`, {
    method: 'DELETE',
    ...(signal ? { signal } : {}),
  });
  if (response.ok || response.status === 404) return;
  throw await readApiError(response);
}

/** `POST /api/session/reset`: every document of this session is removed and the browser gets a new, empty session. */
export async function resetSession(signal?: AbortSignal): Promise<void> {
  const response = await fetchApi('/api/session/reset', { method: 'POST', ...(signal ? { signal } : {}) });
  if (!response.ok) throw await readApiError(response);
}
