import { describe, expect, it } from 'vitest';
import {
  STAGE_FOOTER_PX,
  computeAnchors,
  framingFor,
  type FramingContext,
} from '../../src/scene/cameraFraming';
import { createReaderStore } from '../../src/state/readerStore';

/*
 * "Read closely" (global section G): one page frames to at least 90% of the viewport's height, whatever the screen,
 * and paging walks one page at a time. The page keeps clear of the footer band the reader's controls live in.
 */

const SIZES = [
  [1024, 768],
  [1280, 720],
  [1366, 768],
  [1440, 900],
  [1920, 1080],
  [2560, 1440],
] as const;

function closelyContext(width: number, height: number, direction: 'ltr' | 'rtl'): FramingContext {
  return {
    phase: 'manuscript',
    width,
    height,
    direction,
    leafCount: 20,
    focusSide: direction === 'ltr' ? 'left' : 'right',
    closely: true,
  };
}

describe('the "Read closely" framing', () => {
  it.each(SIZES)(
    'frames one page to at least 90 percent of the viewport height at %i x %i, in both directions',
    (w, h) => {
      for (const direction of ['ltr', 'rtl'] as const) {
        const context = closelyContext(w, h, direction);
        const pose = framingFor(context);
        const anchors = computeAnchors(
          pose,
          { width: w, height: h },
          {
            open: true,
            spread: 1,
            direction,
            leafCount: 20,
          },
        );
        const page = direction === 'ltr' ? anchors.leftPage : anchors.rightPage;
        expect(page).not.toBeNull();
        if (!page) continue;
        expect(page.height / h, `${direction} ${String(w)}x${String(h)}`).toBeGreaterThanOrEqual(0.9);
        // inside the picture, above the footer band
        expect(page.y).toBeGreaterThanOrEqual(0);
        expect(page.y + page.height).toBeLessThanOrEqual(h - STAGE_FOOTER_PX + 2);
        expect(page.x).toBeGreaterThanOrEqual(0);
        expect(page.x + page.width).toBeLessThanOrEqual(w);
      }
    },
  );

  it('is the focused side that is framed: the left page for LTR page 1, the right for RTL', () => {
    const ltr = framingFor(closelyContext(1440, 900, 'ltr'));
    const rtl = framingFor(closelyContext(1440, 900, 'rtl'));
    expect(ltr.target.x).toBeLessThan(0);
    expect(rtl.target.x).toBeGreaterThan(0);
    expect(ltr.target.x).toBeCloseTo(-rtl.target.x, 6);
  });

  it('comes closer than the ordinary reading framing (which frames the whole spread)', () => {
    const base = { ...closelyContext(1440, 900, 'ltr'), closely: false, focusSide: null };
    const close = framingFor(closelyContext(1440, 900, 'ltr'));
    const spread = framingFor(base);
    const distance = (pose: typeof close): number =>
      Math.hypot(
        pose.position.x - pose.target.x,
        pose.position.y - pose.target.y,
        pose.position.z - pose.target.z,
      );
    expect(distance(close)).toBeLessThan(distance(spread));
  });

  it('exists only in the manuscript phase: elsewhere the flag changes nothing', () => {
    for (const phase of ['awaiting', 'unveiling', 'revealing', 'memory', 'discovery'] as const) {
      const base = { ...closelyContext(1440, 900, 'ltr'), phase, focusSide: null };
      expect(framingFor({ ...base, closely: true }), phase).toEqual(framingFor({ ...base, closely: false }));
    }
  });
});

describe('reading closely, in the reader store', () => {
  function wideReader() {
    const store = createReaderStore();
    store.getState().setDocument(12, 'ltr');
    store.getState().goToSpread(1);
    return store;
  }

  it('walks one page at a time on a wide screen, like a phone: page 1, then 2, then 3 on the next spread', () => {
    const store = wideReader();
    expect(store.getState().focusSide).toBeNull();
    store.getState().setClosely(true);
    expect(store.getState().focusSide).toBe('left'); // page 1 (LTR)
    store.getState().next();
    expect([store.getState().spread, store.getState().focusSide]).toEqual([1, 'right']); // page 2
    store.getState().next();
    expect([store.getState().spread, store.getState().focusSide]).toEqual([2, 'left']); // page 3
    store.getState().prev();
    expect([store.getState().spread, store.getState().focusSide]).toEqual([1, 'right']);
  });

  it('goes back to whole spreads when it is switched off', () => {
    const store = wideReader();
    store.getState().setClosely(true);
    store.getState().next();
    store.getState().setClosely(false);
    expect(store.getState().focusSide).toBeNull();
    store.getState().next();
    expect(store.getState().spread).toBe(2);
  });

  it('keeps the focused side when a phone-width screen is also reading closely', () => {
    const store = wideReader();
    store.getState().setNarrow(true);
    store.getState().setClosely(true);
    store.getState().setClosely(false);
    expect(store.getState().focusSide).not.toBeNull(); // still narrow
  });

  it('closing the diary ends it', () => {
    const store = wideReader();
    store.getState().setClosely(true);
    store.getState().clearDocument();
    expect(store.getState().closely).toBe(false);
  });

  it('"last" goes to the last real page when reading closely', () => {
    const store = wideReader();
    store.getState().setClosely(true);
    store.getState().navigate('last');
    expect(store.getState().spread).toBe(6);
    expect(store.getState().focusSide).toBe('right'); // page 12 is even: the unturned side
  });
});
