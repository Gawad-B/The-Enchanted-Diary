import { act, renderHook } from '@testing-library/react';
import { Component, type ReactNode } from 'react';
import type { WebGLRenderer } from 'three';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { QualityTier } from '../../src/scene/quality';
import type { SceneAssets } from '../../src/scene/sceneAssets';
import { useSceneAssets } from '../../src/scene/useSceneAssets';

/*
 * The scene's assets are built after mount, a step at a time, and released with it. A quality change remounts
 * the whole scene, so the old tier's assets must be disposed and the new ones built; React's development double
 * mount must not leak the set it discards.
 */

interface Built {
  tier: QualityTier;
  dispose: ReturnType<typeof vi.fn>;
}

const built: Built[] = [];
const environments: { dispose: ReturnType<typeof vi.fn> }[] = [];
/** When set, the build throws in the middle (a canvas that cannot be drawn on, a context that was lost). */
let failBuild: Error | null = null;

vi.mock('../../src/scene/sceneAssets', () => ({
  domCanvas: () => document.createElement('canvas'),
  buildSceneAssets: function* (tier: QualityTier) {
    yield;
    if (failBuild) throw failBuild;
    yield;
    const assets: Built = { tier, dispose: vi.fn() };
    built.push(assets);
    return assets as unknown as SceneAssets;
  },
}));

vi.mock('../../src/scene/studioEnvironment', () => ({
  createStudioEnvironment: () => {
    const environment = { texture: {}, dispose: vi.fn() };
    environments.push(environment);
    return environment;
  },
}));

const gl = { capabilities: { getMaxAnisotropy: () => 16 } } as unknown as WebGLRenderer;

beforeEach(() => {
  failBuild = null;
  built.length = 0;
  environments.length = 0;
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

/** Lets the build run: one step per timer turn. */
function finishBuild(): void {
  act(() => {
    vi.advanceTimersByTime(50);
  });
}

describe('useSceneAssets', () => {
  it('is null at first, builds a step at a time after mount, then hands the assets over', () => {
    const { result } = renderHook(() => useSceneAssets('medium', gl));
    expect(result.current).toBeNull();
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(result.current).toBeNull(); // still building: the page was free in between
    finishBuild();
    expect(result.current).toBe(built[0]);
    expect(built).toHaveLength(1);
  });

  it('disposes the assets and the reflection environment when the scene goes away', () => {
    const { unmount } = renderHook(() => useSceneAssets('medium', gl));
    finishBuild();
    unmount();
    expect(built[0]?.dispose).toHaveBeenCalledTimes(1);
  });

  it("a new tier disposes the old tier's assets and builds the new ones (nothing stale survives)", () => {
    const { result, rerender } = renderHook(({ tier }) => useSceneAssets(tier, gl), {
      initialProps: { tier: 'high' as QualityTier },
    });
    finishBuild();
    const first = built[0];
    expect(first?.tier).toBe('high');
    rerender({ tier: 'low' });
    expect(first?.dispose).toHaveBeenCalledTimes(1);
    finishBuild();
    expect(built).toHaveLength(2);
    expect(built[1]?.tier).toBe('low');
    expect(result.current).toBe(built[1]);
    expect(built[1]?.dispose).not.toHaveBeenCalled();
  });

  it('leaving before the build finished cancels it: nothing is built, and the environment it made is released', () => {
    const { unmount } = renderHook(() => useSceneAssets('medium', gl));
    act(() => {
      vi.advanceTimersByTime(1);
    });
    unmount();
    finishBuild();
    expect(built).toHaveLength(0);
    expect(environments).toHaveLength(1);
    expect(environments[0]?.dispose).toHaveBeenCalledTimes(1);
  });

  it("React's development double mount builds twice but leaves exactly one live set and no leaked environment", () => {
    const { result, unmount } = renderHook(() => useSceneAssets('medium', gl), { reactStrictMode: true });
    finishBuild();
    // The first mount was cancelled before it finished; only the second produced assets.
    expect(built).toHaveLength(1);
    expect(result.current).toBe(built[0]);
    expect(environments.length).toBeGreaterThanOrEqual(2);
    const released = environments.filter((environment) => environment.dispose.mock.calls.length > 0);
    expect(released).toHaveLength(environments.length - 1); // all but the live one
    unmount();
    expect(built[0]?.dispose).toHaveBeenCalledTimes(1);
  });

  it('a build that throws is rethrown in render, where the scene boundary catches it: no blank stage for good, and the environment is released', () => {
    failBuild = new Error('the canvas is gone');
    const caught: unknown[] = [];
    class Boundary extends Component<{ children: ReactNode }, { failed: boolean }> {
      override state = { failed: false };
      static getDerivedStateFromError(): { failed: boolean } {
        return { failed: true };
      }
      override componentDidCatch(error: unknown): void {
        caught.push(error);
      }
      override render(): ReactNode {
        return this.state.failed ? null : this.props.children;
      }
    }
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { unmount } = renderHook(() => useSceneAssets('medium', gl), {
      wrapper: ({ children }) => <Boundary>{children}</Boundary>,
    });
    finishBuild();
    expect(caught).toHaveLength(1);
    expect((caught[0] as Error).message).toBe('the canvas is gone');
    expect(built).toHaveLength(0);
    unmount();
    expect(environments[0]?.dispose).toHaveBeenCalledTimes(1);
    quiet.mockRestore();
  });

  it('a build cancelled before it failed reports nothing', () => {
    failBuild = new Error('late');
    const { unmount } = renderHook(() => useSceneAssets('medium', gl));
    act(() => {
      vi.advanceTimersToNextTimer(); // the first step only: the one that would throw is still to come
    });
    unmount();
    expect(() => {
      finishBuild();
    }).not.toThrow();
  });
});
