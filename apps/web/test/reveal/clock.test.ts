import { describe, expect, it, vi } from 'vitest';
import { startRevealClock } from '../../src/reveal/clock';
import { beatDurations, totalMs, type Beat } from '../../src/reveal/timeline';

/** A clock the test steps by hand. */
function harness(options: { reducedMotion?: boolean; from?: Beat } = {}) {
  let time = 1000;
  let pending: (() => void) | null = null;
  const entered: Beat[] = [];
  const frames: { beat: Beat; t: number }[] = [];
  const onDone = vi.fn();
  const clock = startRevealClock({
    reducedMotion: options.reducedMotion ?? false,
    from: options.from,
    onEnter: (beat) => entered.push(beat),
    onFrame: (position) => frames.push({ beat: position.beat, t: position.t }),
    onDone,
    now: () => time,
    requestFrame: (callback) => {
      pending = callback;
      return 1;
    },
    cancelFrame: () => {
      pending = null;
    },
  });
  return {
    clock,
    entered,
    frames,
    onDone,
    advance(ms: number) {
      time += ms;
      const run = pending;
      pending = null;
      run?.();
    },
  };
}

describe('the reveal clock', () => {
  it('enters every beat once, in order, and finishes once at the end', () => {
    const h = harness();
    const d = beatDurations(false);
    h.advance(16);
    expect(h.entered).toEqual(['line']);
    h.advance(d.line);
    expect(h.entered).toEqual(['line', 'riffle']);
    h.advance(d.riffle);
    h.advance(d.zoomIn);
    h.advance(d.zoomOut);
    expect(h.entered).toEqual(['line', 'riffle', 'zoomIn', 'zoomOut', 'page']);
    expect(h.onDone).not.toHaveBeenCalled();
    h.advance(d.page);
    expect(h.onDone).toHaveBeenCalledTimes(1);
    h.advance(1000);
    expect(h.onDone).toHaveBeenCalledTimes(1);
    expect(h.clock.finished).toBe(true);
  });

  it('skip enters the beats it jumps over, shows the page in 200 ms and finishes', () => {
    const h = harness();
    h.advance(100);
    h.clock.skip();
    expect(h.entered).toEqual(['line', 'riffle', 'zoomIn', 'zoomOut', 'page']);
    h.advance(100);
    expect(h.onDone).not.toHaveBeenCalled();
    expect(h.frames.at(-1)?.beat).toBe('page');
    h.advance(100);
    expect(h.onDone).toHaveBeenCalledTimes(1);
  });

  it('reduced motion runs the short variant (line, then the 300 ms crossfade)', () => {
    const h = harness({ reducedMotion: true });
    h.advance(16);
    h.advance(totalMs(true));
    expect(h.entered).toContain('page');
    expect(h.onDone).toHaveBeenCalledTimes(1);
    expect(totalMs(true)).toBeLessThanOrEqual(1000);
  });

  it('starts at a later beat when asked, without entering the earlier ones', () => {
    const h = harness({ from: 'riffle' });
    h.advance(16);
    expect(h.entered).toEqual(['riffle']);
  });

  it('stop ends it without calling onDone', () => {
    const h = harness();
    h.advance(16);
    h.clock.stop();
    h.advance(10000);
    expect(h.onDone).not.toHaveBeenCalled();
  });
});
