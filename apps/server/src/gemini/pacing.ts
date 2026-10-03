/*
 * Request pacing: a sliding window of at most `maxPerMinute` requests in any 60 seconds, shared by every Gemini call of
 * the PROCESS, so that free-tier requests-per-minute limits are met before the service has to refuse. It is a guard, not
 * the only defence: a 429 that gets through is retried with the delay the service asks for (retry.ts).
 *
 * The window lives in a SharedArrayBuffer, so that the main thread and every ingestion worker thread draw on one budget
 * (a worker thread has its own module state, which is why a plain array would give each thread a window of its own and
 * let the process send several times the limit). The main thread creates the buffer (`geminiPacerBuffer`), hands it to the
 * threads it starts, and a thread attaches to it before its first call (`useGeminiPacerBuffer`). The state is a count and
 * the send times of the requests of the last minute, guarded by a lock word that is held for a few microseconds, that nobody
 * waits on (a busy lock is a 1 ms wait for the async caller), and that a thread terminated inside it cannot hold for good.
 *
 * One window per quota BUCKET. Gemini's limits are per model (and the embedding and OCR quotas are their own), so the answer
 * model, the auxiliary model, the embeddings and OCR each draw on a window of their own (`getGeminiPacer(config, bucket)`):
 * a burst of answers must not use up the slots of the grounding checks (the small model has its own quota), and the other
 * way round. The bucket is usually the model id.
 *
 * The queue of callers waiting for a slot is a FIFO in which every waiter can be cancelled on its own: an aborted waiter leaves
 * at once (it takes no slot, and it does not wait for the waiters in front of it to be served).
 *
 * One process only: several instances of the server (serverless functions) each have their own budget.
 */

const WINDOW_MS = 60_000;
/** The most send times kept: a limit above this is clamped to it (a billed key is allowed more than a free one, not millions). */
const CAPACITY = 4096;
const HEADER_INTS = 4;
const HEADER_BYTES = HEADER_INTS * 4;
/** The lock word: 0 when free, else the token of the thread that holds it (see {@link GeminiPacer.lock}). */
const LOCK = 0;
const MAX_PER_MINUTE = 1;
const COUNT = 2;
/** Counts the locks taken, to give each a token no other lock has had. */
const EPOCH = 3;
const BUFFER_BYTES = HEADER_BYTES + CAPACITY * 8;
/** A lock that has been seen held by the same holder for this long belongs to a thread that is gone (it is held for microseconds). */
const DEFAULT_STALE_LOCK_MS = 1000;
/**
 * Tries made to take the lock before reporting it busy. The holder needs a microsecond, so a few thousand tries (tens of
 * microseconds in all) ride out a holder that is busy, and the bound means a lock that is not released never costs more.
 */
const LOCK_TRIES = 2000;

/**
 * A clock that only goes forward and that every thread of the process reads the same way (`process.hrtime` is one monotonic
 * clock for the whole process): the window stamps live in a buffer the threads share, so a clock that can be set (`Date.now`
 * after an NTP step or a resume) would make a backward step stall every Gemini call for as long as the step is long, and a
 * forward step let a whole burst through. Milliseconds, fractions kept.
 */
export const monotonicMs = (): number => Number(process.hrtime.bigint()) / 1e6;

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

/** A fresh, empty window to share between threads. */
export function createPacerBuffer(): SharedArrayBuffer {
  return new SharedArrayBuffer(BUFFER_BYTES);
}

export interface PacerOptions {
  /** Requests allowed in any 60 seconds; 0 (or less) switches pacing off. */
  maxPerMinute: number;
  /** The window to draw on, to share it with other threads (see {@link createPacerBuffer}). Default: a window of its own. */
  shared?: SharedArrayBuffer;
  /** The clock, in milliseconds (default: the monotonic one above; tests inject a simulated one). */
  now?: () => number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** A lock seen held by the same thread for this long is taken over (tests make it short). Default one second. */
  staleLockMs?: number;
}

interface Waiter {
  resolve: () => void;
  reject: (error: unknown) => void;
  signal: AbortSignal | undefined;
  detach: () => void;
}

export class GeminiPacer {
  private readonly state: Int32Array;
  private readonly stamps: Float64Array;
  /** The callers waiting for a slot, in the order they asked. */
  private readonly queue: Waiter[] = [];
  private draining = false;
  private readonly now: () => number;
  private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  private readonly staleLockMs: number;
  /** The holder this pacer last saw on the lock, and when (on this thread's own monotonic clock) it first saw it. */
  private seenHolder = 0;
  private seenSince = 0;

  constructor(options: PacerOptions) {
    const buffer = options.shared ?? createPacerBuffer();
    if (buffer.byteLength !== BUFFER_BYTES) throw new Error('not a pacer buffer');
    this.state = new Int32Array(buffer, 0, HEADER_INTS);
    this.stamps = new Float64Array(buffer, HEADER_BYTES, CAPACITY);
    this.now = options.now ?? monotonicMs;
    this.sleep = options.sleep ?? sleepFor;
    this.staleLockMs = options.staleLockMs ?? DEFAULT_STALE_LOCK_MS;
    this.setMaxPerMinute(options.maxPerMinute);
  }

  setMaxPerMinute(maxPerMinute: number): void {
    Atomics.store(this.state, MAX_PER_MINUTE, Math.max(0, Math.min(Math.trunc(maxPerMinute), 2 ** 31 - 1)));
  }

  /**
   * Resolves when a request may be sent (callers of this pacer are served in order); rejects with an AbortError as soon as
   * `signal` aborts, whatever place in the queue the caller has: it never takes a slot then.
   */
  acquire(signal?: AbortSignal): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      if (signal?.aborted === true) {
        reject(abortError());
        return;
      }
      const waiter: Waiter = {
        resolve,
        reject,
        signal,
        detach: () => signal?.removeEventListener('abort', onAbort),
      };
      const onAbort = (): void => {
        const index = this.queue.indexOf(waiter);
        if (index !== -1) this.queue.splice(index, 1);
        reject(abortError());
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      this.queue.push(waiter);
      void this.drain();
    });
  }

  /** Callers waiting for a slot right now (diagnostics and tests). */
  get waiting(): number {
    return this.queue.length;
  }

  /**
   * Takes a slot if there is one and answers 0; otherwise answers how many milliseconds until one is free (at least 1),
   * taking nothing. The window is the process's, whichever thread asks. It never waits for another thread: when the lock
   * is busy it answers 1, and the caller comes back after that millisecond.
   */
  tryAcquire(): number {
    const token = this.lock();
    if (token === 0) return 1;
    try {
      const max = Atomics.load(this.state, MAX_PER_MINUTE);
      if (max <= 0) return 0;
      const limit = Math.min(max, CAPACITY);
      const now = this.now();
      let count = this.state[COUNT] ?? 0;
      let expired = 0;
      while (expired < count && (this.stamps[expired] ?? 0) <= now - WINDOW_MS) expired += 1;
      if (expired > 0) {
        this.stamps.copyWithin(0, expired, count);
        count -= expired;
      }
      if (count < limit) {
        this.stamps[count] = now;
        this.state[COUNT] = count + 1;
        return 0;
      }
      this.state[COUNT] = count;
      // A slot is free once the requests beyond the limit, and the one at it, are a minute old.
      return Math.max(1, (this.stamps[count - limit] ?? now) + WINDOW_MS - now);
    } finally {
      this.unlock(token);
    }
  }

  /** Serves the queue from its head: a slot for the first waiter, else a sleep that ends early when that waiter leaves. */
  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      for (;;) {
        const head = this.queue[0];
        if (head === undefined) return;
        const wait = this.tryAcquire();
        if (wait === 0) {
          this.queue.shift();
          head.detach();
          head.resolve();
          continue;
        }
        try {
          await this.sleep(wait, head.signal);
        } catch {
          // the head was cancelled while it slept: its own listener has removed and rejected it; serve the next one
        }
      }
    } finally {
      this.draining = false;
      if (this.queue.length > 0) void this.drain();
    }
  }

  /**
   * Takes the lock and answers the token that proves it, or 0 when it is busy. Never spins for long (the main thread must
   * not freeze) and never takes a lock from a thread that may still be using it: a lock is taken over only after this
   * pacer has seen the same holder on it for `staleLockMs` (a thread that was terminated inside the critical section, which
   * never runs its `finally`), and then by a compare-and-swap from exactly the token that was seen, so that of several
   * waiters only one succeeds, and none can release a lock somebody else has taken since.
   */
  private lock(): number {
    for (let tries = 0; tries < LOCK_TRIES; tries += 1) {
      const token = (Atomics.add(this.state, EPOCH, 1) & 0x7fffffff) | 1;
      if (Atomics.compareExchange(this.state, LOCK, 0, token) === 0) {
        this.seenHolder = 0;
        return token;
      }
    }
    const holder = Atomics.load(this.state, LOCK);
    const at = performance.now(); // monotonic: a step of the wall clock cannot make a lock look young forever
    if (holder === 0) return 0;
    if (holder !== this.seenHolder) {
      this.seenHolder = holder;
      this.seenSince = at;
    } else if (at - this.seenSince >= this.staleLockMs) {
      Atomics.compareExchange(this.state, LOCK, holder, 0); // only the waiter that still sees this holder succeeds
      this.seenHolder = 0;
    }
    return 0;
  }

  private unlock(token: number): void {
    // Release only our own lock: if it was taken over while we were paused, the new holder's lock stays.
    Atomics.compareExchange(this.state, LOCK, token, 0);
  }
}

/** The bucket of callers that name none (the OCR threads: their quota is their own). */
const DEFAULT_BUCKET = 'default';
const buffers = new Map<string, SharedArrayBuffer>();
const pacers = new Map<string, GeminiPacer>();

/**
 * The window of one bucket of this process, created on first use. The main thread passes it to the worker threads that call
 * Gemini.
 */
export function geminiPacerBuffer(bucket: string = DEFAULT_BUCKET): SharedArrayBuffer {
  let buffer = buffers.get(bucket);
  if (buffer === undefined) {
    buffer = createPacerBuffer();
    buffers.set(bucket, buffer);
  }
  return buffer;
}

/** In a worker thread: draw on the window the main thread made (before the first call to {@link getGeminiPacer}). */
export function useGeminiPacerBuffer(buffer: SharedArrayBuffer, bucket: string = DEFAULT_BUCKET): void {
  buffers.set(bucket, buffer);
  pacers.delete(bucket);
}

/**
 * The pacer every Gemini call of one quota bucket goes through, whichever thread makes it (`bucket`: the model id for the
 * answer and auxiliary models, a name of its own for embeddings). The limit is the latest caller's.
 */
export function getGeminiPacer(
  config: { geminiMaxRpm: number },
  bucket: string = DEFAULT_BUCKET,
): GeminiPacer {
  const known = pacers.get(bucket);
  if (known !== undefined) {
    known.setMaxPerMinute(config.geminiMaxRpm);
    return known;
  }
  const created = new GeminiPacer({ maxPerMinute: config.geminiMaxRpm, shared: geminiPacerBuffer(bucket) });
  pacers.set(bucket, created);
  return created;
}
