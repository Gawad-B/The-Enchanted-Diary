import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../src/api/client';
import { createDocumentStore } from '../../src/state/documentStore';
import {
  LATE_ANSWER_LIMIT_MS,
  SESSION_CHECK_TIMEOUT_MS,
  startSessionEffect,
  type SessionEffectOptions,
} from '../../src/state/effects/session';
import { createExperienceStore } from '../../src/state/experience';
import { DOCUMENT_ID, makeDocument } from '../fixtures';

function setup(fetchSessionDocument: NonNullable<SessionEffectOptions['fetchSessionDocument']>) {
  const experience = createExperienceStore();
  const documents = createDocumentStore();
  const stop = startSessionEffect({ experience, documents, fetchSessionDocument });
  return { experience, documents, stop };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('session boot check', () => {
  it('waits 2 seconds at most', () => {
    expect(SESSION_CHECK_TIMEOUT_MS).toBe(2000);
  });

  it('restores a ready document and keeps it in the document store', async () => {
    const document = makeDocument();
    const { experience, documents } = setup(() => Promise.resolve({ document }));
    await vi.advanceTimersByTimeAsync(0);
    expect(experience.getState()).toMatchObject({
      sessionChecked: true,
      restored: true,
      documentId: DOCUMENT_ID,
      phase: 'discovery',
    });
    expect(documents.getState().document).toEqual(document);
  });

  it('goes to reading for a document that is still processing', async () => {
    const { experience } = setup(() =>
      Promise.resolve({ document: makeDocument({ status: 'processing', stage: 'ocr' }) }),
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(experience.getState()).toMatchObject({
      phase: 'reading',
      documentId: DOCUMENT_ID,
      sessionChecked: true,
    });
  });

  it('reports no document when the session has none', async () => {
    const { experience, documents } = setup(() => Promise.resolve({ document: null }));
    await vi.advanceTimersByTimeAsync(0);
    expect(experience.getState()).toMatchObject({ sessionChecked: true, restored: false, documentId: null });
    expect(documents.getState().document).toBeNull();
  });

  it('treats a 404 as "no document" without a warning', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { experience } = setup(() =>
      Promise.reject(new ApiError('DOCUMENT_NOT_FOUND', 'nothing here', 404)),
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(experience.getState()).toMatchObject({ sessionChecked: true, restored: false });
    expect(warn).not.toHaveBeenCalled();
  });

  it('a network error does not hold the start button: after 2 s there is "no document", and it keeps asking quietly', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const fetch = vi.fn(() => Promise.reject(new ApiError('NETWORK', 'Failed to fetch')));
    const { experience } = setup(fetch);
    await vi.advanceTimersByTimeAsync(1999);
    expect(experience.getState().sessionChecked).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(experience.getState()).toMatchObject({ sessionChecked: true, restored: false });
    expect(warn).not.toHaveBeenCalled();
    expect(fetch.mock.calls.length).toBeGreaterThan(2);
  });

  it('retries a 502 with a backoff (0.5, 1, 2, 4 s, then every 5 s)', async () => {
    const fetch = vi.fn(() => Promise.reject(new ApiError('INTERNAL', 'HTTP 502', 502)));
    setup(fetch);
    await vi.advanceTimersByTimeAsync(0);
    expect(fetch).toHaveBeenCalledTimes(1);
    for (const [ms, calls] of [
      [500, 2],
      [1000, 3],
      [2000, 4],
      [4000, 5],
      [5000, 6],
      [5000, 7],
    ] as const) {
      await vi.advanceTimersByTimeAsync(ms - 1);
      expect(fetch).toHaveBeenCalledTimes(calls - 1);
      await vi.advanceTimersByTimeAsync(1);
      expect(fetch).toHaveBeenCalledTimes(calls);
    }
  });

  it('a document that turns up on a retry (the API was still starting) restores the closed book', async () => {
    const fetch = vi
      .fn<NonNullable<SessionEffectOptions['fetchSessionDocument']>>()
      .mockRejectedValueOnce(new ApiError('INTERNAL', 'HTTP 502', 502))
      .mockRejectedValueOnce(new ApiError('INTERNAL', 'HTTP 502', 502))
      .mockRejectedValueOnce(new ApiError('INTERNAL', 'HTTP 502', 502))
      .mockResolvedValue({ document: makeDocument() });
    const { experience, documents } = setup(fetch);
    await vi.advanceTimersByTimeAsync(2000); // start is already available: no document assumed
    expect(experience.getState()).toMatchObject({ sessionChecked: true, restored: false });
    await vi.advanceTimersByTimeAsync(1500); // the 4th ask, at 3.5 s
    expect(experience.getState()).toMatchObject({
      phase: 'discovery',
      restored: true,
      documentId: DOCUMENT_ID,
    });
    expect(documents.getState().document).not.toBeNull();
    const calls = fetch.mock.calls.length;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(fetch.mock.calls.length).toBe(calls); // an answer ends the asking
  });

  it('stopping cancels a pending retry', async () => {
    const fetch = vi.fn(() => Promise.reject(new ApiError('NETWORK', 'down')));
    const { stop } = setup(fetch);
    await vi.advanceTimersByTimeAsync(0);
    stop();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('a definite non-transient failure (a 4xx other than 404) is "no document", warned, and not retried', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const fetch = vi.fn(() => Promise.reject(new ApiError('QUESTION_INVALID', 'HTTP 400', 400)));
    const { experience } = setup(fetch);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(experience.getState().sessionChecked).toBe(true);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('gives up after 2 s (the experience never waits on the network) but keeps listening: a late document still resumes or restores', async () => {
    let resolve: (value: { document: ReturnType<typeof makeDocument> | null }) => void = () => undefined;
    let signal: AbortSignal | undefined;
    const { experience, documents } = setup((s) => {
      signal = s;
      return new Promise((r) => {
        resolve = r;
      });
    });
    await vi.advanceTimersByTimeAsync(1999);
    expect(experience.getState().sessionChecked).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(experience.getState()).toMatchObject({ sessionChecked: true, restored: false, documentId: null });
    expect(signal?.aborted).toBe(false); // the request is NOT cancelled by the timeout
    resolve({ document: makeDocument({ status: 'processing', stage: 'ocr' }) });
    await vi.advanceTimersByTimeAsync(0);
    expect(experience.getState()).toMatchObject({ phase: 'reading', documentId: DOCUMENT_ID });
    expect(documents.getState().document).not.toBeNull();
  });

  it('a late ready document restores the closed book that still holds nothing', async () => {
    let resolve: (value: { document: ReturnType<typeof makeDocument> | null }) => void = () => undefined;
    const { experience } = setup(
      () =>
        new Promise((r) => {
          resolve = r;
        }),
    );
    await vi.advanceTimersByTimeAsync(2000);
    resolve({ document: makeDocument() });
    await vi.advanceTimersByTimeAsync(0);
    expect(experience.getState()).toMatchObject({
      phase: 'discovery',
      restored: true,
      documentId: DOCUMENT_ID,
    });
  });

  it('a late answer is ignored once the reader has opened the book (nothing is taken from under their hands)', async () => {
    let resolve: (value: { document: ReturnType<typeof makeDocument> | null }) => void = () => undefined;
    const { experience, documents } = setup(
      () =>
        new Promise((r) => {
          resolve = r;
        }),
    );
    await vi.advanceTimersByTimeAsync(2000);
    experience.getState().dispatch({ type: 'INTERACT' });
    resolve({ document: makeDocument() });
    await vi.advanceTimersByTimeAsync(0);
    expect(experience.getState()).toMatchObject({ phase: 'opening', restored: false, documentId: null });
    expect(documents.getState().document).toBeNull();
  });

  it('stops listening to a request that has gone unanswered for 20 s', async () => {
    let signal: AbortSignal | undefined;
    setup((s) => {
      signal = s;
      return new Promise(() => undefined);
    });
    await vi.advanceTimersByTimeAsync(LATE_ANSWER_LIMIT_MS);
    expect(signal?.aborted).toBe(true);
  });

  it('dispatches exactly once', async () => {
    const { experience } = setup(() => Promise.resolve({ document: null }));
    const listener = vi.fn();
    experience.subscribe(listener);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('can be cancelled without dispatching, a late answer included', async () => {
    let resolve: (value: { document: ReturnType<typeof makeDocument> | null }) => void = () => undefined;
    const { experience, stop } = setup(
      () =>
        new Promise((r) => {
          resolve = r;
        }),
    );
    stop();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(experience.getState().sessionChecked).toBe(false);
    resolve({ document: makeDocument() });
    await vi.advanceTimersByTimeAsync(0);
    expect(experience.getState().sessionChecked).toBe(false);
  });
});
