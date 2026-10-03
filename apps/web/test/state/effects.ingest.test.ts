import type { DocumentDetail, IngestTickResponse, ProgressEvent } from '@enchanted/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../src/api/client';
import { createDocumentStore } from '../../src/state/documentStore';
import {
  BACKOFF_CAP_MS,
  FOLLOW_POLL_MS,
  MAX_CONSECUTIVE_FAILURES,
  RATE_LIMIT_WAIT_MS,
  startIngestEffect,
  waitForOnline,
  waitWithWake,
  type LockApi,
} from '../../src/state/effects/ingest';
import { createExperienceStore, initialExperienceState } from '../../src/state/experience';
import { DOCUMENT_ID, makeDocument } from '../fixtures';

const progress = (partial: Partial<ProgressEvent> = {}): ProgressEvent => ({
  stage: 'parsing',
  completed: 1,
  total: 40,
  unit: 'pages',
  ...partial,
});
const running = (
  p: Partial<ProgressEvent> = {},
  extra: Partial<IngestTickResponse> = {},
): IngestTickResponse => ({
  status: 'running',
  progress: progress(p),
  ...extra,
});

/** A script of tick answers (a value, or an error to throw) and a recorder of the pauses the effect asked for. */
function setup(script: (IngestTickResponse | Error)[], phase: 'reading' | 'awaiting' = 'awaiting') {
  const experience = createExperienceStore({ ...initialExperienceState, phase, sessionChecked: true });
  const documents = createDocumentStore();
  const ticks: string[] = [];
  const signals: AbortSignal[] = [];
  const waits: { ms: number; wakeEarly: boolean }[] = [];
  const remove = vi.fn(() => Promise.resolve());
  const queue = [...script];
  const tick = vi.fn((id: string, signal: AbortSignal) => {
    ticks.push(id);
    signals.push(signal);
    const next = queue.shift();
    if (next === undefined) return new Promise<IngestTickResponse>(() => undefined); // nothing more: the loop hangs, like an open request
    return next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
  });
  let clock = 1_000_000;
  const stop = startIngestEffect({
    experience,
    documents,
    tick,
    remove,
    now: () => clock,
    wait: (ms, _signal, wakeEarly) => {
      waits.push({ ms, wakeEarly });
      clock += ms;
      return Promise.resolve();
    },
  });
  const start = (): void => {
    experience.setState({
      phase: 'reading',
      epoch: experience.getState().epoch + 1,
      documentId: DOCUMENT_ID,
    });
  };
  return { experience, documents, tick, ticks, signals, waits, remove, stop, start, queue };
}

const stops: (() => void)[] = [];
afterEach(() => {
  for (const stop of stops.splice(0)) stop();
  vi.restoreAllMocks();
});
const flush = async (turns = 12) => {
  for (let i = 0; i < turns; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
};

describe('the ingest effect: a client-driven tick loop', () => {
  it('ticks the document until it is ready, storing every real progress event; the ready document is in the store BEFORE INGEST_READY', async () => {
    const ready: DocumentDetail = makeDocument({ pageCount: 40 });
    const harness = setup([
      running({ stage: 'parsing', completed: 12, total: 40 }),
      running({ stage: 'embedding', completed: 96, total: 312, unit: 'chunks' }),
      { status: 'ready', progress: progress({ stage: 'ready', completed: 40, total: 40 }), document: ready },
    ]);
    stops.push(harness.stop);
    const seen: unknown[] = [];
    harness.documents.subscribe((state) => seen.push(state.ingestProgress));
    let documentWhenReady: unknown = 'not yet';
    harness.experience.subscribe((state, previous) => {
      if (previous.phase === 'reading' && state.phase === 'unveiling')
        documentWhenReady = harness.documents.getState().document;
    });
    harness.start();
    await flush();
    expect(harness.ticks).toEqual([DOCUMENT_ID, DOCUMENT_ID, DOCUMENT_ID]);
    expect(seen).toContainEqual(progress({ stage: 'parsing', completed: 12, total: 40 }));
    expect(seen).toContainEqual(progress({ stage: 'embedding', completed: 96, total: 312, unit: 'chunks' }));
    expect(documentWhenReady).toEqual(ready); // the book is built from it
    expect(harness.experience.getState().phase).toBe('unveiling');
    expect(harness.documents.getState().ingestProgress).toBeNull();
  });

  it('keeps the direction the analysis reported (Arabic) for the early re-layout', async () => {
    const harness = setup([
      running({ stage: 'analyzing', direction: 'rtl' }),
      running({ stage: 'embedding', completed: 1, total: 9, unit: 'chunks' }),
    ]);
    stops.push(harness.stop);
    harness.start();
    await flush();
    expect(harness.documents.getState().reportedDirection).toBe('rtl');
  });

  it("a failed document is INGEST_FAILED with the server's code and words", async () => {
    const harness = setup([
      {
        status: 'failed',
        progress: progress({ stage: 'failed' }),
        error: { code: 'PDF_UNREADABLE', message: 'no text, no pages' },
      },
    ]);
    stops.push(harness.stop);
    harness.start();
    await flush();
    expect(harness.experience.getState()).toMatchObject({
      phase: 'awaiting',
      error: { code: 'PDF_UNREADABLE', message: 'no text, no pages' },
    });
  });

  it('honours retryAfterMs (the line is full, a lease is held) and then ticks again', async () => {
    const harness = setup([
      running(
        { stage: 'queued', unit: 'queue', completed: 0, total: 0, queuePosition: 2 },
        { retryAfterMs: 2000 },
      ),
      running({}, { retryAfterMs: 1000 }),
      { status: 'ready', progress: progress({ stage: 'ready' }), document: makeDocument() },
    ]);
    stops.push(harness.stop);
    harness.start();
    await flush();
    expect(harness.waits).toEqual([
      { ms: 2000, wakeEarly: false },
      { ms: 1000, wakeEarly: false },
    ]);
    expect(harness.experience.getState().phase).toBe('unveiling');
    expect(harness.documents.getState().ingestPause).toBeNull();
  });

  it('shows the pause of a waiting tick while it waits', async () => {
    const harness = setup([running({}, { retryAfterMs: 2000 })]);
    stops.push(harness.stop);
    harness.start();
    await flush();
    expect(harness.documents.getState().ingestPause).toMatchObject({ kind: 'waiting' });
  });

  it('a parked document (the daily quota): shows the pause with the detail, waits for the reset, wakes when the reader comes back, and goes on', async () => {
    const harness = setup([
      {
        status: 'parked',
        progress: progress({
          stage: 'embedding',
          completed: 10,
          total: 100,
          unit: 'chunks',
          detail: 'daily quota reached',
        }),
        retryAfterMs: 6 * 3600_000,
      },
      { status: 'ready', progress: progress({ stage: 'ready' }), document: makeDocument() },
    ]);
    stops.push(harness.stop);
    harness.start();
    await flush(2);
    // paused: the wait is the long one, and it may end early (the reader returns to the tab, the network is back)
    expect(harness.waits[0]).toEqual({ ms: 6 * 3600_000, wakeEarly: true });
    await flush();
    expect(harness.experience.getState().phase).toBe('unveiling');
  });

  it('exposes a parked pause with its end and the technical detail', async () => {
    const harness = setup([
      {
        status: 'parked',
        progress: progress({ stage: 'ocr', completed: 1, total: 3, detail: 'daily quota reached' }),
        retryAfterMs: 3600_000,
      },
    ]);
    stops.push(harness.stop);
    harness.start();
    await flush(2);
    expect(harness.documents.getState().ingestPause).toEqual({
      kind: 'parked',
      retryAt: 1_000_000 + 3600_000,
      detail: 'daily quota reached',
    });
  });

  it('a dropped connection or a 504 is "tick again", with a growing pause (1 s, 2 s, ...), and the loop recovers', async () => {
    const harness = setup([
      new ApiError('NETWORK', 'offline'),
      new ApiError('INTERNAL', 'HTTP 504 Gateway Timeout', 504),
      new ApiError('NETWORK', 'offline'),
      { status: 'ready', progress: progress({ stage: 'ready' }), document: makeDocument() },
    ]);
    stops.push(harness.stop);
    harness.start();
    await flush();
    expect(harness.waits.map((wait) => wait.ms)).toEqual([1000, 2000, 4000]);
    expect(harness.experience.getState().phase).toBe('unveiling');
  });

  it('the pause grows to a cap and a run of failures ends the reading with the last error', async () => {
    const failures = Array.from(
      { length: MAX_CONSECUTIVE_FAILURES },
      () => new ApiError('NETWORK', 'offline'),
    );
    const harness = setup(failures);
    stops.push(harness.stop);
    harness.start();
    await flush(20);
    expect(Math.max(...harness.waits.map((wait) => wait.ms))).toBeLessThanOrEqual(BACKOFF_CAP_MS);
    expect(harness.waits).toHaveLength(MAX_CONSECUTIVE_FAILURES - 1);
    expect(harness.experience.getState()).toMatchObject({ phase: 'awaiting', error: { code: 'NETWORK' } });
  });

  it('a success resets the count of failures', async () => {
    const script: (IngestTickResponse | Error)[] = [];
    for (let round = 0; round < 3; round += 1) {
      for (let i = 0; i < MAX_CONSECUTIVE_FAILURES - 2; i += 1)
        script.push(new ApiError('NETWORK', 'offline'));
      script.push(running());
    }
    script.push({ status: 'ready', progress: progress({ stage: 'ready' }), document: makeDocument() });
    const harness = setup(script);
    stops.push(harness.stop);
    harness.start();
    await flush(60);
    expect(harness.experience.getState().phase).toBe('unveiling');
  });

  it('a 429 (the tick rate limit) waits it out, long, and tries again', async () => {
    const harness = setup([
      new ApiError('RATE_LIMITED', 'slow down', 429),
      { status: 'ready', progress: progress({ stage: 'ready' }), document: makeDocument() },
    ]);
    stops.push(harness.stop);
    harness.start();
    await flush();
    expect(harness.waits[0]).toEqual({ ms: RATE_LIMIT_WAIT_MS, wakeEarly: true });
    expect(harness.experience.getState().phase).toBe('unveiling');
  });

  it('a 404 (deleted, replaced or expired) stops the loop: the reading ends with DOCUMENT_NOT_FOUND', async () => {
    const harness = setup([new ApiError('DOCUMENT_NOT_FOUND', 'gone', 404)]);
    stops.push(harness.stop);
    harness.start();
    await flush();
    expect(harness.ticks).toHaveLength(1);
    expect(harness.experience.getState()).toMatchObject({
      phase: 'awaiting',
      error: { code: 'DOCUMENT_NOT_FOUND' },
    });
  });

  it("another client error (400 range) is the server's verdict: no endless retries", async () => {
    const harness = setup([new ApiError('DOCUMENT_NOT_READY', 'no', 409)]);
    stops.push(harness.stop);
    harness.start();
    await flush();
    expect(harness.ticks).toHaveLength(1);
    expect(harness.experience.getState().phase).toBe('awaiting');
  });

  it('withdrawing (CANCEL) stops the loop (the request in flight is aborted) and DELETEs the document', async () => {
    const harness = setup([running()]);
    stops.push(harness.stop);
    harness.start();
    await flush(3);
    expect(harness.ticks.length).toBeGreaterThanOrEqual(1);
    harness.experience.getState().dispatch({ type: 'CANCEL' });
    expect(harness.signals.at(-1)?.aborted).toBe(true);
    expect(harness.remove).toHaveBeenCalledWith(DOCUMENT_ID);
    const count = harness.ticks.length;
    await flush(5);
    expect(harness.ticks).toHaveLength(count);
  });

  it('a failure that ended the reading by itself deletes nothing (the server owns what it refused)', async () => {
    const harness = setup([new ApiError('DOCUMENT_NOT_FOUND', 'gone', 404)]);
    stops.push(harness.stop);
    harness.start();
    await flush();
    expect(harness.remove).not.toHaveBeenCalled();
  });

  it('runs one loop per document: entering reading twice does not make two loops', async () => {
    const harness = setup([running(), running(), running()]);
    stops.push(harness.stop);
    harness.start();
    await flush(2);
    const first = harness.signals[0];
    harness.start(); // a second entry (the epoch changes): the first loop is aborted
    await flush(2);
    expect(first?.aborted).toBe(true);
  });
});

describe('the ingest effect: Retry-After, the network, two tabs, stopping', () => {
  function build(
    options: Partial<Parameters<typeof startIngestEffect>[0]> & {
      script?: (IngestTickResponse | Error)[];
    } = {},
  ) {
    const { script = [], ...rest } = options;
    const experience = createExperienceStore({
      ...initialExperienceState,
      phase: 'awaiting',
      sessionChecked: true,
    });
    const documents = createDocumentStore();
    const waits: number[] = [];
    const signals: AbortSignal[] = [];
    const queue = [...script];
    const tick = vi.fn((_id: string, signal: AbortSignal) => {
      signals.push(signal);
      const next = queue.shift();
      if (next === undefined) {
        // an open request, which a real fetch ends with an AbortError when its signal aborts
        return new Promise<IngestTickResponse>((_resolve, reject) => {
          signal.addEventListener('abort', () => {
            reject(new DOMException('aborted', 'AbortError'));
          });
        });
      }
      return next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
    });
    let clock = 1_000_000;
    const stop = startIngestEffect({
      experience,
      documents,
      tick,
      remove: () => Promise.resolve(),
      locks: null,
      now: () => clock,
      wait: (ms) => {
        waits.push(ms);
        clock += ms;
        return Promise.resolve();
      },
      ...rest,
    });
    stops.push(stop);
    const start = (): void => {
      experience.setState({
        phase: 'reading',
        epoch: experience.getState().epoch + 1,
        documentId: DOCUMENT_ID,
      });
    };
    return { experience, documents, tick, waits, signals, stop, start };
  }

  it("m-6: a 429 waits as long as the server's Retry-After said (and at least a second)", async () => {
    const harness = build({
      script: [
        new ApiError('RATE_LIMITED', 'slow down', 429, undefined, 42_000),
        new ApiError('RATE_LIMITED', 'slow down', 429, undefined, 0),
        { status: 'ready', progress: progress({ stage: 'ready' }), document: makeDocument() },
      ],
    });
    harness.start();
    await flush();
    expect(harness.waits).toEqual([42_000, 1000]);
    expect(harness.experience.getState().phase).toBe('unveiling');
  });

  it('m-7: while the browser is offline the loop waits for the network and counts nothing: a long spell does not end the reading', async () => {
    let online = false;
    const resumes: (() => void)[] = [];
    const harness = build({
      script: [
        ...Array.from({ length: MAX_CONSECUTIVE_FAILURES + 3 }, () => new ApiError('NETWORK', 'offline')),
        { status: 'ready', progress: progress({ stage: 'ready' }), document: makeDocument() },
      ],
      online: () => online,
      whenOnline: () =>
        new Promise<void>((resolve) => {
          resumes.push(resolve);
        }),
    });
    harness.start();
    for (let i = 0; i < MAX_CONSECUTIVE_FAILURES + 3; i += 1) {
      await flush(2);
      expect(harness.experience.getState().phase).toBe('reading'); // still waiting, never failed
      resumes.shift()?.();
    }
    online = true;
    await flush(4);
    expect(harness.experience.getState().phase).toBe('unveiling');
    expect(harness.waits).toEqual([]); // no backoff was taken: the waits were for the network
  });

  it('a failure with the network up still counts and backs off (offline is the only exemption)', async () => {
    const harness = build({
      script: [
        new ApiError('NETWORK', 'refused'),
        { status: 'ready', progress: progress({ stage: 'ready' }), document: makeDocument() },
      ],
      online: () => true,
    });
    harness.start();
    await flush();
    expect(harness.waits).toEqual([1000]);
  });

  it('m-4: stopping the effect aborts the tick in flight (the loop does not outlive it)', async () => {
    const harness = build({ script: [] });
    harness.start();
    await flush(3);
    expect(harness.signals[0]?.aborted).toBe(false);
    harness.stop();
    expect(harness.signals[0]?.aborted).toBe(true);
  });

  describe('m-5: one tab drives a document, another follows', () => {
    /** A follower's poll pause as the browser has it: a timer, so the rest of the page runs between two looks. */
    const poll = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

    /** A Web Locks stand-in shared by two "tabs": a lock is held while its callback runs. */
    function makeLocks() {
      const held = new Set<string>();
      const api: LockApi = {
        async request(name, _options, callback) {
          if (held.has(name)) return callback(null);
          held.add(name);
          try {
            return await callback({});
          } finally {
            held.delete(name);
          }
        },
      };
      return { api, held };
    }

    it('the tab that holds the lock ticks; the second tab only reads /progress, and never ticks', async () => {
      const { api } = makeLocks();
      const leader = build({ script: [running()], locks: api });
      const follower = build({
        locks: api,
        wait: poll,
        follow: vi.fn(() =>
          Promise.resolve(running({ stage: 'embedding', completed: 5, total: 9, unit: 'chunks' })),
        ),
      });
      leader.start();
      await flush(3); // the leader has the lock and its tick is hanging (an open request)
      follower.start();
      await flush(4);
      expect(leader.tick).toHaveBeenCalled();
      expect(follower.tick).not.toHaveBeenCalled();
      expect(follower.documents.getState().ingestProgress).toMatchObject({
        stage: 'embedding',
        completed: 5,
      });
    });

    it('the follower finishes when the document is ready, with the ready document (it never needed the lock)', async () => {
      const { api } = makeLocks();
      const leader = build({ script: [], locks: api });
      const ready = makeDocument({ pageCount: 3 });
      const follower = build({
        locks: api,
        follow: () =>
          Promise.resolve({ status: 'ready', progress: progress({ stage: 'ready' }), document: ready }),
      });
      leader.start();
      await flush(3);
      follower.start();
      await flush(4);
      expect(follower.experience.getState().phase).toBe('unveiling');
      expect(follower.documents.getState().document).toEqual(ready);
      expect(follower.tick).not.toHaveBeenCalled();
    });

    it('a follower that sees the document is gone (404) ends the reading, without deleting anything', async () => {
      const { api } = makeLocks();
      const leader = build({ script: [], locks: api });
      const follower = build({
        locks: api,
        follow: () => Promise.reject(new ApiError('DOCUMENT_NOT_FOUND', 'gone', 404)),
      });
      leader.start();
      await flush(3);
      follower.start();
      await flush(4);
      expect(follower.experience.getState()).toMatchObject({
        phase: 'awaiting',
        error: { code: 'DOCUMENT_NOT_FOUND' },
      });
    });

    it('when the leader goes away the follower takes the lock over and drives', async () => {
      const { api } = makeLocks();
      const leader = build({ script: [], locks: api });
      const follower = build({
        locks: api,
        script: [{ status: 'ready', progress: progress({ stage: 'ready' }), document: makeDocument() }],
        wait: poll,
        follow: () => Promise.resolve(running()),
      });
      leader.start();
      await flush(3);
      follower.start();
      await flush(4);
      expect(follower.tick).not.toHaveBeenCalled();
      leader.stop(); // the leading tab is closed: its loop ends, the lock is released
      await flush(6);
      expect(follower.tick).toHaveBeenCalled();
      expect(follower.experience.getState().phase).toBe('unveiling');
    });

    it("the poll between looks is the follower's own pause (and wakes early when the tab is shown)", async () => {
      const { api } = makeLocks();
      const leader = build({ script: [], locks: api });
      const waitsSeen: { ms: number; wake: boolean }[] = [];
      const follower = build({
        locks: api,
        follow: () => Promise.resolve(running()),
        wait: (ms, _signal, wake) => {
          waitsSeen.push({ ms, wake });
          return new Promise<void>(() => undefined);
        },
      });
      leader.start();
      await flush(3);
      follower.start();
      await flush(4);
      expect(waitsSeen[0]).toEqual({ ms: FOLLOW_POLL_MS, wake: true });
    });
  });
});

describe('waitWithWake and waitForOnline (m-12: they had no test)', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('waits the time given', async () => {
    vi.useFakeTimers();
    const done = vi.fn();
    void waitWithWake(5000, new AbortController().signal, false).then(done);
    await vi.advanceTimersByTimeAsync(4999);
    expect(done).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(done).toHaveBeenCalled();
  });

  it('ends at once on abort', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const done = vi.fn();
    void waitWithWake(60_000, controller.signal, true).then(done);
    controller.abort();
    await vi.advanceTimersByTimeAsync(0);
    expect(done).toHaveBeenCalled();
  });

  it('a long wait ends when the tab is shown again, or when the network comes back; a short one does not listen', async () => {
    vi.useFakeTimers();
    const shown = vi.fn();
    void waitWithWake(60_000, new AbortController().signal, true).then(shown);
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
    await vi.advanceTimersByTimeAsync(0);
    expect(shown).not.toHaveBeenCalled(); // hidden is not a reason to wake
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
    await vi.advanceTimersByTimeAsync(0);
    expect(shown).toHaveBeenCalled();

    const back = vi.fn();
    void waitWithWake(60_000, new AbortController().signal, true).then(back);
    window.dispatchEvent(new Event('online'));
    await vi.advanceTimersByTimeAsync(0);
    expect(back).toHaveBeenCalled();

    const short = vi.fn();
    void waitWithWake(60_000, new AbortController().signal, false).then(short);
    window.dispatchEvent(new Event('online'));
    await vi.advanceTimersByTimeAsync(0);
    expect(short).not.toHaveBeenCalled();
  });

  it('leaves no listener behind once it has ended', async () => {
    vi.useFakeTimers();
    const add = vi.spyOn(window, 'addEventListener');
    const remove = vi.spyOn(window, 'removeEventListener');
    void waitWithWake(10, new AbortController().signal, true);
    await vi.advanceTimersByTimeAsync(20);
    const added = add.mock.calls.filter(([type]) => type === 'online').length;
    const removed = remove.mock.calls.filter(([type]) => type === 'online').length;
    expect(removed).toBe(added);
  });

  it('waitForOnline resolves when the network is back, or on abort, and cleans up', async () => {
    const done = vi.fn();
    void waitForOnline(new AbortController().signal).then(done);
    await Promise.resolve();
    expect(done).not.toHaveBeenCalled();
    window.dispatchEvent(new Event('online'));
    await Promise.resolve();
    expect(done).toHaveBeenCalled();
    const controller = new AbortController();
    const aborted = vi.fn();
    void waitForOnline(controller.signal).then(aborted);
    controller.abort();
    await Promise.resolve();
    expect(aborted).toHaveBeenCalled();
  });
});
