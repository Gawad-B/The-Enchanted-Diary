import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../src/api/client';
import { createConfigStore, freeTierNoticeApplies } from '../../src/state/configStore';
import { startConfigEffect } from '../../src/state/effects/config';

const CONFIG = {
  maxUploadBytes: 1000,
  maxPages: 10,
  acceptedMimeTypes: ['application/pdf'],
  llm: { provider: 'gemini', model: 'm', available: true, profile: 'standard' as const },
  embeddings: { provider: 'gemini', model: 'e' },
  ocr: { provider: 'gemini', available: true },
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('the config effect: it fails SAFE', () => {
  it('a store that has not heard from the server shows the free-tier notice; a server that says "none" does not', () => {
    const store = createConfigStore();
    expect(freeTierNoticeApplies(store.getState())).toBe(true); // loading
    store.getState().setFailed();
    expect(freeTierNoticeApplies(store.getState())).toBe(true); // failed
    store.getState().setConfig(CONFIG);
    expect(freeTierNoticeApplies(store.getState())).toBe(false);
    store.getState().setConfig({ ...CONFIG, llm: { ...CONFIG.llm, freeTierNotice: true } });
    expect(freeTierNoticeApplies(store.getState())).toBe(true);
  });

  it('reads the configuration and marks the store ready', async () => {
    const store = createConfigStore();
    startConfigEffect({ store, fetchConfig: () => Promise.resolve(CONFIG) });
    await vi.advanceTimersByTimeAsync(0);
    expect(store.getState()).toMatchObject({ status: 'ready', config: CONFIG });
  });

  it('asks again with a backoff (0.5, 1, 2, 4 s, then every 5 s), failed meanwhile so the disclosure does not fail open', async () => {
    const store = createConfigStore();
    const fetchConfig = vi.fn(() => Promise.reject(new ApiError('INTERNAL', 'HTTP 502', 502)));
    startConfigEffect({ store, fetchConfig });
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchConfig).toHaveBeenCalledTimes(1);
    expect(store.getState().status).toBe('loading');
    for (const [ms, calls] of [
      [500, 2],
      [1000, 3],
      [2000, 4],
      [4000, 5],
    ] as const) {
      await vi.advanceTimersByTimeAsync(ms);
      expect(fetchConfig).toHaveBeenCalledTimes(calls);
    }
    expect(store.getState()).toMatchObject({ status: 'failed', config: null });
    await vi.advanceTimersByTimeAsync(5000);
    expect(fetchConfig).toHaveBeenCalledTimes(6);
    await vi.advanceTimersByTimeAsync(5000);
    expect(fetchConfig).toHaveBeenCalledTimes(7);
  });

  it('keeps asking after "failed" and becomes ready when the API finally answers', async () => {
    const store = createConfigStore();
    const fetchConfig = vi.fn().mockRejectedValue(new ApiError('NETWORK', 'down'));
    startConfigEffect({ store, fetchConfig });
    await vi.advanceTimersByTimeAsync(7500 + 5000);
    expect(store.getState().status).toBe('failed');
    fetchConfig.mockResolvedValue(CONFIG);
    await vi.advanceTimersByTimeAsync(5000);
    expect(store.getState()).toMatchObject({ status: 'ready', config: CONFIG });
  });

  it('a definite refusal (a 4xx) is not asked again', async () => {
    const store = createConfigStore();
    const fetchConfig = vi.fn(() => Promise.reject(new ApiError('INTERNAL', 'nope', 404)));
    startConfigEffect({ store, fetchConfig });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(fetchConfig).toHaveBeenCalledTimes(1);
    expect(store.getState().status).toBe('failed');
  });

  it('a retry that succeeds is ready; stopping cancels the pending retry', async () => {
    const store = createConfigStore();
    const fetchConfig = vi
      .fn()
      .mockRejectedValueOnce(new ApiError('NETWORK', 'down'))
      .mockResolvedValue(CONFIG);
    const stop = startConfigEffect({ store, fetchConfig });
    await vi.advanceTimersByTimeAsync(500);
    expect(store.getState().status).toBe('ready');

    const other = createConfigStore();
    const again = vi.fn(() => Promise.reject(new ApiError('NETWORK', 'down')));
    const stopOther = startConfigEffect({ store: other, fetchConfig: again });
    await vi.advanceTimersByTimeAsync(0);
    stopOther();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(again).toHaveBeenCalledTimes(1);
    stop();
  });
});
