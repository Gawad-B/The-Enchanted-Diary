import { AnswerStreamEventSchema, type AnswerStreamEvent } from '@enchanted/shared';
import { ApiError, fetchApi, isAbortError, readApiError } from './client';
import { createSseParser } from './sse';

/**
 * No byte of the answer stream for this long (heartbeat comments count: the server sends one every five seconds) means the
 * connection is dead, not slow (finding I13): the diary says the connection to the archive was interrupted.
 */
export const ASK_STALL_MS = 20_000;

/** A refused question: the server's code and words, and how long it asks the reader to wait, when it said. */
export class AskError extends ApiError {
  readonly retryAfterSeconds: number | undefined;

  constructor(base: ApiError, retryAfterSeconds: number | undefined) {
    super(base.code, base.message, base.status, base.detail);
    this.name = 'AskError';
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export interface AskStreamOptions {
  documentId: string;
  question: string;
  /** The pages in view, so "this page" can be resolved (at most four). */
  visiblePages: number[];
  /** Every event of the stream, as the shared schema describes it, in order. */
  onEvent: (event: AnswerStreamEvent) => void;
  /** Called for every chunk of bytes that arrives, heartbeats included. */
  onActivity?: () => void;
  signal?: AbortSignal;
  /** The silence that ends the wait (tests shorten it). */
  stallMs?: number;
}

function withdrawn(): DOMException {
  return new DOMException('The question was withdrawn', 'AbortError');
}

/** The server's Retry-After header (seconds), when it sent a sensible one. */
function retryAfterOf(response: Response): number | undefined {
  const value = Number(response.headers.get('retry-after'));
  return Number.isFinite(value) && value > 0 ? Math.ceil(value) : undefined;
}

/**
 * `POST /api/documents/:id/ask`: asks a question and reads the answer as it is written. The body is a Server-Sent-Events
 * stream of `AnswerStreamEvent`s (fetch + ReadableStream + the shared SSE parser; EventSource cannot POST). Each event is
 * validated by the shared schema before the caller sees it; a frame that is not JSON, names an event this client does not
 * know, or has the wrong shape is skipped (the `done` event carries the authoritative text, so a lost token costs nothing).
 *
 * Resolves when the stream has ended after a `done` or `error` event. Rejects with:
 *  - an `AskError` (an ApiError) for a refusal before the stream opened (DIARY_BUSY, RATE_LIMITED, DOCUMENT_NOT_READY, ...);
 *  - `ApiError('NETWORK')` when the connection fails, breaks, ends without a verdict, or is silent for `stallMs`;
 *  - an AbortError when `signal` aborted.
 */
export async function askStream(options: AskStreamOptions): Promise<void> {
  const { documentId, question, visiblePages, onEvent, onActivity, signal, stallMs = ASK_STALL_MS } = options;
  const request = new AbortController();
  let stalled = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const arm = (): void => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      stalled = true;
      request.abort();
    }, stallMs);
  };
  const onCallerAbort = (): void => {
    request.abort();
  };
  if (signal?.aborted) request.abort();
  else signal?.addEventListener('abort', onCallerAbort, { once: true });

  /** What an interruption means: the watchdog (the connection is dead) or the caller (the question was withdrawn). */
  const interruption = (): Promise<never> =>
    new Promise((_resolve, reject) => {
      const reject_ = (): void => {
        reject(
          stalled
            ? new ApiError('NETWORK', `Nothing came from the archive for ${String(stallMs / 1000)} seconds`)
            : withdrawn(),
        );
      };
      if (request.signal.aborted) reject_();
      else request.signal.addEventListener('abort', reject_, { once: true });
    });

  const failure = (error: unknown): unknown => {
    if (stalled) {
      return new ApiError('NETWORK', `Nothing came from the archive for ${String(stallMs / 1000)} seconds`);
    }
    if (signal?.aborted || isAbortError(error)) return withdrawn();
    if (error instanceof ApiError) return error;
    return new ApiError('NETWORK', error instanceof Error ? error.message : 'The connection was interrupted');
  };

  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    arm();
    const response = await Promise.race([
      fetchApi(`/api/documents/${encodeURIComponent(documentId)}/ask`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
        body: JSON.stringify({
          question,
          ...(visiblePages.length > 0 ? { context: { visiblePages } } : {}),
        }),
        signal: request.signal,
      }),
      interruption(),
    ]);
    arm();
    if (!response.ok) throw new AskError(await readApiError(response), retryAfterOf(response));
    if (!response.body) throw new ApiError('INTERNAL', 'The server sent no answer stream', response.status);
    const activeReader = response.body.getReader();
    reader = activeReader;
    const decoder = new TextDecoder();
    const outcome = { ended: false, done: false };
    const parser = createSseParser((frame) => {
      if (frame.event !== 'message') return;
      let payload: unknown;
      try {
        payload = JSON.parse(frame.data);
      } catch {
        return;
      }
      const parsed = AnswerStreamEventSchema.safeParse(payload);
      if (!parsed.success) {
        if (import.meta.env.DEV) console.warn('[ask] skipped an unreadable event', parsed.error.issues[0]);
        return;
      }
      if (parsed.data.type === 'done' || parsed.data.type === 'error') outcome.ended = true;
      if (parsed.data.type === 'done') outcome.done = true;
      onEvent(parsed.data);
    });

    const stop = (): void => {
      activeReader.cancel().catch(() => undefined);
    };
    request.signal.addEventListener('abort', stop, { once: true });
    for (;;) {
      const chunk = await Promise.race([activeReader.read(), interruption()]);
      if (chunk.done) break;
      arm();
      onActivity?.();
      parser.push(decoder.decode(chunk.value, { stream: true }));
      // Nothing follows `done`: the answer is complete, so the request is let go at once instead of waiting for a proxy to close it
      // (an `error` event may still be followed by a `done`, so that one is read on).
      if (outcome.done) break;
    }
    parser.push(decoder.decode());
    parser.end();
    if (!outcome.ended) {
      throw new ApiError('NETWORK', 'The answer stream ended before the diary had finished');
    }
  } catch (error) {
    throw failure(error);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onCallerAbort);
    if (reader) reader.cancel().catch(() => undefined);
  }
}
