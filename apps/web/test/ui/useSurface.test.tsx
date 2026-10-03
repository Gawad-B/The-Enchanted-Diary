import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { anchorStore } from '../../src/state/anchorStore';
import { diaryBookStore } from '../../src/state/diaryBook';
import { viewportInsetStore } from '../../src/state/viewportInset';
import { LIVE_AFTER_MS, useKeyboardInset, useLivePage, useSurfaceReady } from '../../src/ui/diary/useSurface';

const QUAD = [
  { x: 0, y: 0 },
  { x: 10, y: 0 },
  { x: 10, y: 10 },
  { x: 0, y: 10 },
] as const;

beforeEach(() => {
  diaryBookStore.getState().reset();
  anchorStore.getState().reset();
  viewportInsetStore.getState().setBottom(0);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('useSurfaceReady', () => {
  it('needs all four: the reader writing, the camera at rest, the book still, and the page placed', () => {
    const { result } = renderHook(() => useSurfaceReady());
    expect(result.current).toBe(false);
    act(() => {
      diaryBookStore.getState().startWriting();
    });
    expect(result.current).toBe(false);
    act(() => {
      anchorStore.getState().setQuads({ rightPage: QUAD, leftPage: QUAD });
    });
    expect(result.current).toBe(false);
    act(() => {
      anchorStore.getState().setStable(true);
    });
    expect(result.current).toBe(true);
    act(() => {
      diaryBookStore.getState().setMoving(true);
    });
    expect(result.current).toBe(false);
  });
});

describe('useLivePage', () => {
  it('hands the page over a moment after the surface is up, and takes it back at once', () => {
    vi.useFakeTimers();
    const { rerender } = renderHook(
      ({ ready }) => {
        useLivePage(ready, 2);
      },
      { initialProps: { ready: true } },
    );
    expect(diaryBookStore.getState().livePage).toBeNull();
    act(() => {
      vi.advanceTimersByTime(LIVE_AFTER_MS + 5);
    });
    expect(diaryBookStore.getState().livePage).toBe(2);
    rerender({ ready: false });
    expect(diaryBookStore.getState().livePage).toBeNull();
  });

  it('never hands over the page when the surface has nothing to bake (the flyleaf)', () => {
    vi.useFakeTimers();
    renderHook(() => {
      useLivePage(true, 0, false);
    });
    act(() => {
      vi.advanceTimersByTime(LIVE_AFTER_MS * 3);
    });
    expect(diaryBookStore.getState().livePage).toBeNull();
  });
});

describe('useKeyboardInset', () => {
  function stubViewport(height: number, offsetTop = 0) {
    const listeners = new Map<string, () => void>();
    const viewport = {
      height,
      offsetTop,
      addEventListener: (type: string, listener: () => void) => listeners.set(type, listener),
      removeEventListener: (type: string) => listeners.delete(type),
    };
    vi.stubGlobal('visualViewport', viewport);
    Object.defineProperty(window, 'visualViewport', { value: viewport, configurable: true });
    return { viewport, fire: () => listeners.get('resize')?.() };
  }

  it('tells the camera how much of the bottom of the screen the keyboard covers, and lifts it when it goes', () => {
    window.innerHeight = 800;
    const { viewport, fire } = stubViewport(800);
    const { unmount } = renderHook(() => {
      useKeyboardInset(true);
    });
    expect(viewportInsetStore.getState().bottomPx).toBe(0);
    viewport.height = 470;
    fire();
    expect(viewportInsetStore.getState().bottomPx).toBe(330);
    unmount();
    expect(viewportInsetStore.getState().bottomPx).toBe(0);
  });

  it('takes a few pixels of the bars of the browser for no keyboard', () => {
    window.innerHeight = 800;
    const { viewport, fire } = stubViewport(800);
    renderHook(() => {
      useKeyboardInset(true);
    });
    viewport.height = 770;
    fire();
    expect(viewportInsetStore.getState().bottomPx).toBe(0);
  });

  it('does nothing when the diary is not being written in', () => {
    window.innerHeight = 800;
    const { viewport, fire } = stubViewport(800);
    renderHook(() => {
      useKeyboardInset(false);
    });
    viewport.height = 400;
    fire();
    expect(viewportInsetStore.getState().bottomPx).toBe(0);
  });
});
