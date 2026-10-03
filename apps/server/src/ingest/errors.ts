import { isTransientDatabaseError } from '../db/errors.js';
import { EmbeddingError } from '../embeddings/provider.js';
import { DAILY_QUOTA_DETAIL } from '../gemini/index.js';
import { DETAIL_RATE_LIMITED } from './detail.js';
import { AppError } from '../http/errors.js';
import { StorageError } from '../storage/provider.js';
import { TransientTickError } from './tick/context.js';

/** Ticks in a row that may end on a passing cause (a database or a store that did not answer) before the document is given up on. */
export const TRANSIENT_TICK_LIMIT = 3;
/** What a client is asked to wait after the first such tick (each one in a row waits three times as long: see TransientTickError). */
const TRANSIENT_RETRY_MS = 3000;

/** True for the error an aborted signal produces (a cancelled job is not a failure). */
export function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

/** Replaces the given directory paths in `message` so that nothing that reaches a client names the server's disk. */
export function scrubPaths(message: string, paths: readonly string[]): string {
  let result = message;
  for (const path of paths) {
    if (path.length > 3) result = result.split(path).join('<dir>');
  }
  // Any other absolute path-looking token.
  return result.replace(/(?:\/[\w.@%+-]+){3,}/g, '<path>');
}

/**
 * Maps whatever a job threw to the error that is stored and shown. AppErrors (the workers' verdicts) pass through;
 * storage and embedding failures get their own codes; anything else is an INTERNAL error whose text is only logged.
 */
export function toAppError(error: unknown, paths: readonly string[]): AppError {
  if (error instanceof AppError) return error;
  if (error instanceof StorageError)
    return new AppError('STORAGE_FAILED', 'The uploaded document could not be read back from storage.');
  if (error instanceof EmbeddingError) {
    // A used-up quota is not a broken document: a tick parks the job for it (RATE_LIMITED is only what is said if it reaches here).
    if (error.dailyQuota) {
      return new AppError(
        'RATE_LIMITED',
        'The daily limit of the embedding service was reached; upload the document again later.',
        DAILY_QUOTA_DETAIL,
      );
    }
    if (error.rateLimited) {
      return new AppError(
        'RATE_LIMITED',
        'The embedding service is busy; upload the document again in a moment.',
        DETAIL_RATE_LIMITED,
      );
    }
    return new AppError(
      'EMBEDDING_FAILED',
      'The words could not be bound to memory (the embedding step failed).',
      scrubPaths(error.message, paths),
    );
  }
  return new AppError('INTERNAL', 'The document could not be processed because of an unexpected error.');
}

/**
 * Whether what a tick threw is a passing cause rather than a verdict on the document: the database dropped the connection or
 * could not be reached, the store did not answer (an IO error, a timeout), the embedding service failed in a way it says may
 * pass. Such a tick is repeated (the client is told to ask again); only {@link TRANSIENT_TICK_LIMIT} of them in a row fail the
 * document, and its file is never deleted for it. Null for anything else.
 */
export function transientOf(error: unknown, paths: readonly string[]): TransientTickError | null {
  if (error instanceof TransientTickError) return error;
  const transient = (kind: string): TransientTickError =>
    new TransientTickError('a passing failure', {
      retryAfterMs: TRANSIENT_RETRY_MS,
      limit: TRANSIENT_TICK_LIMIT,
      failure: toAppError(error, paths),
      kind,
      cause: error,
    });
  if (error instanceof StorageError) return error.kind === 'IO' ? transient('store') : null;
  if (error instanceof EmbeddingError) {
    return error.retryable && !error.rateLimited && !error.dailyQuota && !error.unconfigured
      ? transient('embedding')
      : null;
  }
  if (error instanceof AppError) return null;
  if (error instanceof Error && error.name === 'TimeoutError') return transient('timeout');
  if (isTransientDatabaseError(error)) return transient('database');
  return null;
}
