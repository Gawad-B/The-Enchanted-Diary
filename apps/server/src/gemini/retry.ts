import { AppError } from '../http/errors.js';
import { isAbortError, isRetryableGeminiError, mapGeminiError, parseGeminiError } from './errors.js';
import type { GeminiPacer } from './pacing.js';

export interface RetryOptions {
  /** Attempts in all, the first included. Default 4. */
  maxAttempts?: number;
  /** The wait before the second attempt when the service names none; it doubles after that. Default 1 s. */
  baseDelayMs?: number;
  /** A wait longer than this is not waited for (a daily quota that says "retry in 11 hours"). Default 30 s. */
  maxDelayMs?: number;
  /** The most that may be spent waiting between attempts, in all. Default 90 s. */
  maxTotalWaitMs?: number;
  signal?: AbortSignal;
  /** Every attempt waits for a slot first (the wait is cancelled by `signal` alone: it never counts against a timeout). */
  pacer?: GeminiPacer;
  /**
   * How long one attempt may take, counted from the moment its slot is granted (never including the wait for the slot).
   * The `AbortSignal` the call receives aborts then, and the attempt fails with LLM_UNAVAILABLE and the detail `timeout`
   * (a timeout is not retried).
   */
  attemptTimeoutMs?: number;
  /** Called before each wait (logging). */
  onRetry?: (info: { attempt: number; delayMs: number; status: number | null }) => void;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** 0..1, for the jitter (tests). */
  random?: () => number;
}

/** The `detail` of the AppError for an attempt that ran out of time. */
export const TIMEOUT_DETAIL = 'timeout';

const abortError = (): Error => new DOMException('The request was cancelled', 'AbortError');

function sleepFor(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(abortError());
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(abortError());
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Runs `call` (one request to Gemini) and retries it when it fails with a 429, a 5xx or no answer at all: after the delay
 * the service asks for (`RetryInfo`), else with exponential backoff and jitter, never past the attempt, delay and total
 * wait limits. Each attempt goes through the pacer first. A failure that is not worth retrying, or the last one, comes out
 * as the AppError of {@link mapGeminiError} (a cancellation comes out as it went in).
 */
export async function withGeminiRetry<T>(
  call: (attemptSignal: AbortSignal | undefined) => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const maxAttempts = options.maxAttempts ?? 4;
  const baseDelayMs = options.baseDelayMs ?? 1000;
  const maxDelayMs = options.maxDelayMs ?? 30_000;
  const maxTotalWaitMs = options.maxTotalWaitMs ?? 90_000;
  const sleep = options.sleep ?? sleepFor;
  const random = options.random ?? Math.random;
  let waited = 0;

  for (let attempt = 1; ; attempt += 1) {
    await options.pacer?.acquire(options.signal);
    // The clock starts here, with the slot in hand: waiting in the queue is not the service being slow.
    const timeout =
      options.attemptTimeoutMs === undefined ? undefined : AbortSignal.timeout(options.attemptTimeoutMs);
    const attemptSignal =
      timeout === undefined
        ? options.signal
        : options.signal === undefined
          ? timeout
          : AbortSignal.any([options.signal, timeout]);
    try {
      return await call(attemptSignal);
    } catch (error) {
      if (timeout?.aborted === true && options.signal?.aborted !== true) {
        throw new AppError('LLM_UNAVAILABLE', 'The model service did not answer in time.', TIMEOUT_DETAIL);
      }
      if (isAbortError(error) || options.signal?.aborted === true) throw error;
      if (error instanceof AppError) throw error;
      if (attempt >= maxAttempts || !isRetryableGeminiError(error)) throw mapGeminiError(error);
      const parsed = parseGeminiError(error);
      // The service's own delay if it gave one, plus a little jitter so that retries do not arrive together.
      const delay =
        parsed.retryDelayMs === null
          ? baseDelayMs * 2 ** (attempt - 1) * (0.75 + 0.5 * random())
          : parsed.retryDelayMs + 250 * random();
      if (delay > maxDelayMs || waited + delay > maxTotalWaitMs) throw mapGeminiError(error);
      options.onRetry?.({ attempt, delayMs: Math.round(delay), status: parsed.status });
      waited += delay;
      await sleep(delay, options.signal);
    }
  }
}

/** The same type under its long name. */
export type GeminiRetryOptions = RetryOptions;
