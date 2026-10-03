import { describe, expect, it } from 'vitest';
import { DURATIONS } from '../../src/motion/durations';
import { BEATS, beatDurations, beatsBetween, locate, totalMs } from '../../src/reveal/timeline';

describe('the truth timeline', () => {
  it('runs the beats in order: line, riffle, zoom in, zoom out, page', () => {
    expect(BEATS).toEqual(['line', 'riffle', 'zoomIn', 'zoomOut', 'page']);
  });

  it('takes its durations from the duration tokens (full motion)', () => {
    expect(beatDurations(false)).toEqual({
      line: DURATIONS.truthLine.normal,
      riffle: DURATIONS.truthRiffle.normal,
      zoomIn: DURATIONS.truthZoomIn.normal,
      zoomOut: DURATIONS.truthZoomOut.normal,
      page: DURATIONS.truthPage.normal,
    });
    expect(totalMs(false)).toBeLessThan(7000); // the revealing watchdog is 7 s
  });

  it('locates a moment in its beat, with progress', () => {
    const d = beatDurations(false);
    expect(locate(0, false)).toEqual({ beat: 'line', t: 0, done: false });
    expect(locate(d.line / 2, false).beat).toBe('line');
    expect(locate(d.line / 2, false).t).toBeCloseTo(0.5);
    expect(locate(d.line, false).beat).toBe('riffle');
    expect(locate(d.line + d.riffle + d.zoomIn, false).beat).toBe('zoomOut');
    expect(locate(totalMs(false) - 1, false).beat).toBe('page');
    expect(locate(totalMs(false), false)).toEqual({ beat: 'page', t: 1, done: true });
  });

  it('reduced motion is one short line and one 250 ms crossfade: no riffle, no zoom', () => {
    const d = beatDurations(true);
    expect(d.riffle).toBe(0);
    expect(d.zoomIn).toBe(0);
    expect(d.zoomOut).toBe(0);
    expect(d.page).toBe(250);
    expect(totalMs(true)).toBeLessThan(1000);
    expect(locate(d.line, true).beat).toBe('page');
  });

  it('lists the beats passed between two beats (zero-length ones included)', () => {
    expect(beatsBetween(null, 'zoomIn')).toEqual(['line', 'riffle', 'zoomIn']);
    expect(beatsBetween('line', 'page')).toEqual(['riffle', 'zoomIn', 'zoomOut', 'page']);
    expect(beatsBetween('page', 'page')).toEqual([]);
  });
});
