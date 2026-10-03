import { act, render } from '@testing-library/react';
import { forwardRef, useEffect, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PostFX } from '../../src/scene/PostFX';

/*
 * The effect composer is rebuilt whenever its set of effects changes. A composer that was edited in place (the
 * depth-of-field effect dropped when the diary leaves its discovery framing) kept a depth buffer its multisampled resolve
 * no longer matched: glBlitFramebuffer failed on every frame, and on a real GPU at the high tier the whole picture froze
 * (the grain moved, nothing else) as soon as the book began to open.
 */

const frames: ((state: unknown, delta: number) => void)[] = [];
const lifecycle = { mounted: 0, unmounted: 0, live: 0 };

vi.mock('@react-three/fiber', () => ({
  useFrame: (callback: (state: unknown, delta: number) => void) => {
    frames.length = 0;
    frames.push(callback);
  },
}));

vi.mock('@react-three/postprocessing', () => {
  const Effect = ({ name }: { name: string }) => <div data-effect={name} />;
  return {
    EffectComposer: ({ children }: { children: ReactNode }) => {
      useEffect(() => {
        lifecycle.mounted += 1;
        lifecycle.live += 1;
        return () => {
          lifecycle.unmounted += 1;
          lifecycle.live -= 1;
        };
      }, []);
      return <div data-testid="composer">{children}</div>;
    },
    Bloom: () => <Effect name="bloom" />,
    ToneMapping: () => <Effect name="tonemap" />,
    Vignette: () => <Effect name="vignette" />,
    Noise: () => <Effect name="noise" />,
    DepthOfField: forwardRef<{ bokehScale: number }, object>(function DepthOfField(_props, ref) {
      useEffect(() => {
        const effect = { bokehScale: 2.4 };
        if (typeof ref === 'function') ref(effect);
        else if (ref) ref.current = effect;
      }, [ref]);
      return <Effect name="dof" />;
    }),
  };
});

beforeEach(() => {
  lifecycle.mounted = 0;
  lifecycle.unmounted = 0;
  lifecycle.live = 0;
});
afterEach(() => {
  frames.length = 0;
});

/** Runs the component's frame callback for a while (the depth of field fades out over about a second). */
function runFrames(seconds: number): void {
  for (let t = 0; t < seconds; t += 1 / 60) {
    act(() => {
      frames[0]?.({}, 1 / 60);
    });
  }
}

describe('PostFX rebuilds its composer when its effects change', () => {
  it('leaving the discovery framing drops the depth of field: a new composer, the old one released, no depth of field in it', () => {
    const { rerender, container } = render(<PostFX level="full" phase="discovery" multisampling={4} />);
    expect(lifecycle.mounted).toBe(1);
    expect(container.querySelector('[data-effect="dof"]')).not.toBeNull();
    rerender(<PostFX level="full" phase="opening" multisampling={4} />);
    runFrames(2);
    expect(container.querySelector('[data-effect="dof"]')).toBeNull();
    expect(lifecycle.mounted).toBe(2);
    expect(lifecycle.unmounted).toBe(1);
    expect(lifecycle.live).toBe(1);
  });

  it('coming back to the discovery framing builds a composer with the depth of field again', () => {
    const { rerender, container } = render(<PostFX level="full" phase="manuscript" multisampling={4} />);
    expect(container.querySelector('[data-effect="dof"]')).toBeNull();
    rerender(<PostFX level="full" phase="discovery" multisampling={4} />);
    runFrames(0.1);
    expect(container.querySelector('[data-effect="dof"]')).not.toBeNull();
    expect(lifecycle.mounted).toBe(2);
    expect(lifecycle.live).toBe(1);
  });

  it('the composer is rebuilt only on a calm frame: the faded depth of field stays (at nothing) while the cover swings, and goes when the scene is calm', () => {
    const calm = { now: false };
    const isCalm = (): boolean => calm.now;
    const { rerender, container } = render(
      <PostFX level="full" phase="discovery" multisampling={4} isCalm={isCalm} />,
    );
    rerender(<PostFX level="full" phase="opening" multisampling={4} isCalm={isCalm} />);
    runFrames(3); // well past the fade: the effect is at nothing, but the scene is busy
    expect(container.querySelector('[data-effect="dof"]')).not.toBeNull();
    expect(lifecycle.mounted).toBe(1);
    expect(lifecycle.unmounted).toBe(0);
    calm.now = true;
    runFrames(0.1);
    expect(container.querySelector('[data-effect="dof"]')).toBeNull();
    expect(lifecycle.mounted).toBe(2);
    expect(lifecycle.unmounted).toBe(1);
  });

  it('coming back to the discovery framing builds the depth-of-field composer at the first calm frame, not at the phase change', () => {
    const calm = { now: false };
    const isCalm = (): boolean => calm.now;
    const { rerender, container } = render(
      <PostFX level="full" phase="closing" multisampling={4} isCalm={isCalm} />,
    );
    rerender(<PostFX level="full" phase="discovery" multisampling={4} isCalm={isCalm} />);
    runFrames(1);
    expect(container.querySelector('[data-effect="dof"]')).toBeNull();
    expect(lifecycle.mounted).toBe(1);
    calm.now = true;
    runFrames(0.1);
    expect(container.querySelector('[data-effect="dof"]')).not.toBeNull();
    expect(lifecycle.mounted).toBe(2);
    expect(lifecycle.live).toBe(1);
  });

  it('marks each composer it builds (User Timing), so a profile can see the rebuild', () => {
    const mark = vi.spyOn(performance, 'mark');
    const { rerender } = render(<PostFX level="full" phase="discovery" multisampling={4} />);
    rerender(<PostFX level="full" phase="opening" multisampling={4} />);
    runFrames(2);
    const names = mark.mock.calls.map((call) => call[0]);
    expect(names).toContain('scene:composer-built:full-dof');
    expect(names).toContain('scene:composer-built:full-plain');
    mark.mockRestore();
  });

  it('a step down from full to bloom (the monitor, on a slow machine) is a new composer too', () => {
    const { rerender, container } = render(<PostFX level="full" phase="manuscript" multisampling={4} />);
    expect(container.querySelector('[data-effect="noise"]')).not.toBeNull();
    rerender(<PostFX level="bloom" phase="manuscript" multisampling={4} />);
    expect(container.querySelector('[data-effect="noise"]')).toBeNull();
    expect(lifecycle.mounted).toBe(2);
    expect(lifecycle.live).toBe(1);
  });

  it('phase changes that leave the effects as they are do not rebuild anything', () => {
    const { rerender } = render(<PostFX level="full" phase="awaiting" multisampling={4} />);
    for (const phase of ['uploading', 'reading', 'manuscript', 'memory'] as const) {
      rerender(<PostFX level="full" phase={phase} multisampling={4} />);
      runFrames(0.5);
    }
    expect(lifecycle.mounted).toBe(1);
    expect(lifecycle.unmounted).toBe(0);
  });
});
