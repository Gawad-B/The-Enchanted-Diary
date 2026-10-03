import { PerspectiveCamera, Vector3 } from 'three';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createBookAssets, type BookAssets } from '../../src/scene/book/bookAssets';
import { BookPresenter } from '../../src/scene/book/bookPresenter';
import { BookRig } from '../../src/scene/book/bookRig';
import { INITIAL_SETTLE_SECONDS } from '../../src/scene/book/phaseRunner';
import { applyPose } from '../../src/scene/cameraFraming';
import { framingForCached } from '../helpers/cachedFraming';
import { CandleMotion, candleBaseFor, inkwellBaseFor, INKWELL_RADIUS } from '../../src/scene/candleLayout';
import { candlePoints, inkwellPoints, mountCandleMotion, propsOffstage } from '../../src/scene/propsStage';
import { anchorStore } from '../../src/state/anchorStore';
import { documentStore } from '../../src/state/documentStore';
import { experienceStore, type Phase } from '../../src/state/experience';
import { pageEffectsStore } from '../../src/state/pageEffectsStore';
import { startReaderSync } from '../../src/state/readerSync';
import { readerStore } from '../../src/state/readerStore';
import { resetStores } from '../components/helpers';

/*
 * The props at the moment the scene mounts, and when the book re-lays itself out at once. A mount is not a change: the
 * props must be at rest on the first frame, with no exit and return played for a layout change that never happened.
 */

const SIZES = [
  [1440, 900],
  [390, 844],
  [1100, 1000],
  [3440, 1440],
] as const;

function canvas(width: number, height: number): HTMLCanvasElement {
  const element = document.createElement('canvas');
  element.width = width;
  element.height = height;
  return element;
}

let assets: BookAssets;
let presenter: BookPresenter | null = null;
let detach: (() => void) | null = null;
let stopSync: () => void;

beforeEach(() => {
  resetStores();
  readerStore.getState().reset();
  readerStore.getState().setNarrow(false);
  pageEffectsStore.getState().clearAll();
  documentStore.getState().reset();
  anchorStore.getState().reset();
  stopSync = startReaderSync();
  assets = createBookAssets('low', canvas, 1);
});

afterEach(() => {
  stopSync();
  detach?.();
  presenter?.dispose();
  presenter = null;
  detach = null;
  assets.dispose();
});

/** What the scene does on mount, in the order it does it: render (presenter built, props seeded), then the effect that attaches. */
function mountScene(phase: Phase, width: number, height: number, reducedMotion = false) {
  experienceStore.setState({ phase, epoch: 1, sessionChecked: true });
  presenter = new BookPresenter({ rig: new BookRig(assets, 2), maxAirborne: 3, reducedMotion });
  const motion = mountCandleMotion(
    phase,
    readerStore.getState().spread,
    width,
    height,
    presenter.layoutDirection,
  );
  detach = presenter.attach();
  return { presenter, motion };
}

/** One frame as `SceneContents` runs it: the props, then the presenter. */
function frame(motion: CandleMotion, p: BookPresenter, width: number, height: number, time: number): void {
  motion.update(
    width / height,
    anchorStore.getState().layoutDirection,
    p.motion.cover.value,
    p.motion.flipping || propsOffstage(experienceStore.getState().phase, width, height),
    1 / 60,
    p.motion.reducedMotion || p.motion.clock < INITIAL_SETTLE_SECONDS,
  );
  p.frame(time, 1 / 60);
}

function snapshot(motion: CandleMotion): string {
  return JSON.stringify([motion.base, motion.ink, motion.flame, motion.reading, motion.shown]);
}

describe('the presenter says which way it will lay the book out, before it attaches', () => {
  it("an RTL reader direction is the presenter's layout from the start, while the anchor store still says ltr (that is why the props are seeded from the presenter)", () => {
    readerStore.getState().setDirection('rtl');
    experienceStore.setState({ phase: 'discovery', epoch: 1, sessionChecked: true });
    presenter = new BookPresenter({ rig: new BookRig(assets, 2), maxAirborne: 3, reducedMotion: false });
    expect(presenter.layoutDirection).toBe('rtl');
    expect(anchorStore.getState().layoutDirection).toBe('ltr');
    detach = presenter.attach();
    expect(anchorStore.getState().layoutDirection).toBe('rtl');
  });
});

/** Whether every point is out of the picture of the phase's rest camera. */
function outOfPicture(
  phase: Phase,
  width: number,
  height: number,
  points: readonly (readonly [number, number, number])[],
): boolean {
  const pose = framingForCached({ phase, width, height, direction: 'rtl', leafCount: 21, focusSide: null });
  const camera = new PerspectiveCamera(pose.fov, width / height, 0.05, 60);
  applyPose(camera, pose);
  return points.every(([x, y, z]) => {
    const v = new Vector3(x, y, z).project(camera);
    return Math.abs(v.x) > 1 || Math.abs(v.y) > 1;
  });
}

describe('mounting the scene is not a change', () => {
  for (const [width, height] of SIZES) {
    for (const phase of ['discovery', 'awaiting'] as const) {
      it(`an RTL diary mounted in ${phase} at ${String(width)}x${String(height)}: the props are at their RTL places on the first frame, and nothing moves for 6 s`, () => {
        readerStore.getState().setDirection('rtl');
        const { presenter: p, motion } = mountScene(phase, width, height);
        const aspect = width / height;
        const openness = 1; // the welcome book lies open too
        const offstage = propsOffstage(phase, width, height);
        const first = snapshot(motion);
        // RTL places, not the LTR ones the anchor store's default would give (out through the side if the phase has no room).
        expect(motion.shown).toBe('rtl');
        expect(motion.reading).toBe(offstage ? 1 : 0);
        if (!offstage) {
          expect(motion.base.x).toBeCloseTo(candleBaseFor(aspect, 'rtl', openness).x, 6);
          expect(motion.ink.x).toBeCloseTo(inkwellBaseFor(aspect, 'rtl', openness, 0).x, 6);
          expect(motion.base.x).toBeGreaterThan(0);
        }
        for (let n = 0; n < 360; n += 1) {
          frame(motion, p, width, height, n / 60);
          expect(snapshot(motion), `frame ${String(n + 1)}`).toBe(first);
        }
      });
    }

    for (const phase of ['opening', 'closing'] as const) {
      it(`an RTL diary mounted in ${phase} at ${String(width)}x${String(height)}: the props start on their RTL side and stay on it (the cover moves them, nothing else does)`, () => {
        readerStore.getState().setDirection('rtl');
        const { presenter: p, motion } = mountScene(phase, width, height);
        const offstage = propsOffstage(phase, width, height);
        expect(motion.shown).toBe('rtl');
        expect(motion.reading).toBe(offstage ? 1 : 0);
        let rose = 0;
        for (let n = 0; n < 360; n += 1) {
          frame(motion, p, width, height, n / 60);
          expect(motion.shown, `frame ${String(n + 1)}`).toBe('rtl');
          rose = Math.max(rose, motion.reading);
          if (!offstage) {
            expect(motion.base.x, `candle, frame ${String(n + 1)}`).toBeGreaterThan(0);
            expect(motion.ink.x, `inkwell, frame ${String(n + 1)}`).toBeLessThan(0);
          }
        }
        // No exit was played (the phases' own offstage state is the only thing that takes them out).
        expect(rose).toBeLessThanOrEqual(offstage ? 1 : propsOffstage('awaiting', width, height) ? 1 : 0);
        if (!offstage && !propsOffstage('awaiting', width, height)) expect(rose).toBe(0);
      });
    }
  }

  it('the same mount in English (the control) does not move either', () => {
    const { presenter: p, motion } = mountScene('discovery', 1440, 900);
    const first = snapshot(motion);
    for (let n = 0; n < 240; n += 1) {
      frame(motion, p, 1440, 900, n / 60);
      expect(snapshot(motion)).toBe(first);
    }
  });

  it('under reduced motion too, and a restored document that reads from the right does not move the props at mount', () => {
    readerStore.getState().setDirection('rtl');
    const { presenter: p, motion } = mountScene('discovery', 1440, 900, true);
    const first = snapshot(motion);
    for (let n = 0; n < 240; n += 1) {
      frame(motion, p, 1440, 900, n / 60);
      expect(snapshot(motion)).toBe(first);
    }
  });

  for (const [width, height] of SIZES) {
    for (const phase of ['manuscript', 'memory', 'revealing', 'unveiling'] as const) {
      it(`mounting straight into ${phase} at ${String(width)}x${String(height)}: both props are already out of the picture on the first frame, and stay out`, () => {
        readerStore.getState().setDirection('rtl');
        const { presenter: p, motion } = mountScene(phase, width, height);
        expect(motion.reading).toBe(1);
        expect(outOfPicture(phase, width, height, candlePoints(motion.base)), 'candle, first frame').toBe(
          true,
        );
        expect(
          outOfPicture(phase, width, height, inkwellPoints(motion.ink, -1)),
          'inkwell, first frame',
        ).toBe(true);
        for (let n = 0; n < 180; n += 1) {
          frame(motion, p, width, height, n / 60);
          expect(motion.reading, `frame ${String(n + 1)}`).toBe(1);
          expect(
            outOfPicture(phase, width, height, candlePoints(motion.base)),
            `candle, frame ${String(n + 1)}`,
          ).toBe(true);
          expect(
            outOfPicture(phase, width, height, inkwellPoints(motion.ink, -1)),
            `inkwell, frame ${String(n + 1)}`,
          ).toBe(true);
        }
      });
    }
  }
});

describe('the props follow a layout change that happens at once (reduced motion, the scene settling in)', () => {
  const places = (aspect: number, direction: 'ltr' | 'rtl', openness: number) => ({
    candle: candleBaseFor(aspect, direction, openness),
    ink: inkwellBaseFor(aspect, direction, openness, 0),
  });

  it('with `instant` they change sides in that very frame: no exit, no return, no light crossing the cover', () => {
    for (const openness of [0, 1]) {
      const motion = new CandleMotion(1.6, 'ltr', openness);
      for (let n = 0; n < 30; n += 1) motion.update(1.6, 'ltr', openness, false, 1 / 60, true);
      motion.update(1.6, 'rtl', openness, false, 1 / 60, true);
      const expected = places(1.6, 'rtl', openness);
      expect(motion.shown).toBe('rtl');
      expect(motion.reading).toBe(0);
      expect(motion.base.x).toBeCloseTo(expected.candle.x, 6);
      expect(motion.ink.x).toBeCloseTo(expected.ink.x, 6);
      expect(motion.flame.x).toBeCloseTo(expected.candle.x, 6);
    }
  });

  it('and they never stand in the book on the way (there is no way: they are simply on the other side)', () => {
    const motion = new CandleMotion(1.6, 'ltr', 0);
    for (let n = 0; n < 120; n += 1) {
      motion.update(1.6, n < 10 ? 'ltr' : 'rtl', 0, false, 1 / 60, true);
      for (const [point, radius] of [
        [motion.base, 0.34],
        [motion.ink, INKWELL_RADIUS],
      ] as const) {
        expect(
          Math.abs(point.x) < 1.0 + radius && Math.abs(point.z) < 1.2 + radius,
          `frame ${String(n)}`,
        ).toBe(false);
      }
    }
  });

  it("without `instant` (a real turn-over) nothing changes: the props still leave and return (round 3's behaviour)", () => {
    const motion = new CandleMotion(1.6, 'ltr', 0);
    motion.update(1.6, 'rtl', 0, false, 1 / 60, false);
    expect(motion.shown).toBe('ltr');
  });
});
