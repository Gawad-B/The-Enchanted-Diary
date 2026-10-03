import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useReveal } from '../../src/ui/diary/useReveal';

beforeEach(() => {
  vi.useFakeTimers({
    toFake: ['Date', 'requestAnimationFrame', 'cancelAnimationFrame', 'setTimeout', 'clearTimeout'],
  });
  vi.setSystemTime(100_000);
});
afterEach(() => {
  vi.useRealTimers();
});

const advance = (ms: number): void => {
  act(() => {
    vi.advanceTimersByTime(ms);
  });
};

describe('useReveal: the pen', () => {
  it('writes nothing before the reply may start, then catches up with what has arrived', () => {
    const { result } = renderHook(() =>
      useReveal({
        startAt: 100_500,
        available: 60,
        endedAt: null,
        settled: false,
        stepMs: 30,
        enabled: true,
      }),
    );
    advance(400);
    expect(result.current).toBe(0);
    advance(1000);
    expect(result.current).toBeGreaterThan(10);
    expect(result.current).toBeLessThanOrEqual(60);
  });

  it('never writes more than has arrived, and follows the stream as it grows', () => {
    const { result, rerender } = renderHook(
      (props: { available: number }) =>
        useReveal({
          startAt: 100_000,
          available: props.available,
          endedAt: null,
          settled: false,
          stepMs: 30,
          enabled: true,
        }),
      { initialProps: { available: 5 } },
    );
    advance(2000);
    expect(result.current).toBe(5);
    rerender({ available: 40 });
    advance(2000);
    expect(result.current).toBe(40);
  });

  it('is done within 1.2 s of the end of the stream, however much is left', () => {
    const { result } = renderHook(() =>
      useReveal({
        startAt: 100_000,
        available: 900,
        endedAt: 100_300,
        settled: true,
        stepMs: 30,
        enabled: true,
      }),
    );
    advance(300 + 1200 + 50);
    expect(result.current).toBe(900);
  });

  it("a complete text with no stream (a scripted line) is written at the pen's own pace and then stops", () => {
    const { result } = renderHook(() =>
      useReveal({ startAt: 100_000, available: 30, endedAt: null, settled: true, stepMs: 30, enabled: true }),
    );
    advance(3000);
    expect(result.current).toBe(30);
    // and it has stopped asking for frames
    expect(vi.getTimerCount()).toBe(0);
  });

  it('reduced motion shows everything that has arrived at once', () => {
    const { result } = renderHook(() =>
      useReveal({
        startAt: 100_000,
        available: 77,
        endedAt: null,
        settled: false,
        stepMs: 30,
        enabled: false,
      }),
    );
    expect(result.current).toBe(77);
  });

  it('writes nothing while the reply has no start yet (no first token)', () => {
    const { result } = renderHook(() =>
      useReveal({ startAt: null, available: 0, endedAt: null, settled: false, stepMs: 30, enabled: true }),
    );
    advance(1000);
    expect(result.current).toBe(0);
  });
});
