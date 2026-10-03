import { PerspectiveCamera, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import { applyPose, motionAmplitude } from '../../src/scene/cameraFraming';
import { framingForCached } from '../helpers/cachedFraming';
import { candlePoints, inkwellPoints, propsOffstage } from '../../src/scene/propsStage';
import {
  CandleMotion,
  INKWELL_RADIUS,
  candleBaseFor,
  inkwellBaseFor,
  type Vec3Like,
} from '../../src/scene/candleLayout';
import { CANDLE_HEIGHT, DISH_HEIGHT, FLAME_BASE_Y, WICK_TOP_Y } from '../../src/scene/sceneConstants';
import type { Phase } from '../../src/state/experience';

/*
 * The candle and the inkwell are props at the edge of the picture. They are only ever fully in the frame or fully out
 * of it (never a sliver of a dish at the edge), they never stand in the book, and they get out of the way as the book
 * opens and as the camera goes in to read.
 */

const ALL_PHASES: readonly Phase[] = [
  'discovery',
  'opening',
  'awaiting',
  'uploading',
  'reading',
  'unveiling',
  'manuscript',
  'revealing',
  'memory',
  'closing',
];
const SIZES: readonly (readonly [number, number])[] = [
  [1440, 900],
  [1920, 1080],
  [1280, 720],
  [1100, 700],
  [1024, 768],
  [768, 1024],
  [390, 844],
  [360, 640],
  [3440, 1440],
];

function opennessOf(phase: Phase): number {
  return ['discovery', 'opening', 'awaiting', 'uploading', 'reading'].includes(phase) ? 1 : 0;
}

/** The pixels of the points that make up a prop, seen from the camera of a phase. */
function pixelsOf(
  phase: Phase,
  width: number,
  height: number,
  direction: 'ltr' | 'rtl',
  points: (base: Vec3Like, sign: number) => readonly (readonly [number, number, number])[],
  base: (aspect: number, openness: number, offstage: number) => Vec3Like,
  /** Where the camera is, away from its rest pose (what the pointer and the drift do to it). */
  shift = { x: 0, y: 0 },
): { x: number; y: number }[] {
  const pose = framingForCached({ phase, width, height, direction, leafCount: 21, focusSide: null });
  const camera = new PerspectiveCamera(pose.fov, width / height, 0.05, 60);
  applyPose(camera, pose);
  camera.position.x += shift.x;
  camera.position.y += shift.y;
  camera.lookAt(pose.target.x, pose.target.y, pose.target.z);
  camera.updateMatrixWorld(true);
  const placed = base(width / height, opennessOf(phase), propsOffstage(phase, width, height) ? 1 : 0);
  const sign = direction === 'ltr' ? 1 : -1;
  return points(placed, sign).map(([x, y, z]) => {
    const v = new Vector3(x, y, z).project(camera);
    return { x: ((v.x + 1) / 2) * width, y: ((1 - v.y) / 2) * height };
  });
}

/**
 * The most the camera can be moved from its rest pose in a phase (the pointer's parallax and the idle drift, as the rig
 * adds them): along x the parallax plus the drift, along y half the parallax plus 0.6 of the drift.
 */
function cameraReach(phase: Phase, width: number, height: number, direction: 'ltr' | 'rtl') {
  const pose = framingForCached({ phase, width, height, direction, leafCount: 21, focusSide: null });
  const distance = new Vector3(pose.position.x, pose.position.y, pose.position.z).distanceTo(
    new Vector3(pose.target.x, pose.target.y, pose.target.z),
  );
  const { parallax, drift } = motionAmplitude(phase, false, distance, pose.fov, height);
  return { x: parallax + drift, y: parallax * 0.5 + drift * 0.6 };
}

const CAMERA_CORNERS = [
  [0, 0],
  [1, 1],
  [1, -1],
  [-1, 1],
  [-1, -1],
] as const;

/** The same, for props standing exactly at `placed` (not where the layout would put them). */
function projectAt(
  phase: Phase,
  width: number,
  height: number,
  direction: 'ltr' | 'rtl',
  points: (base: Vec3Like, sign: number) => readonly (readonly [number, number, number])[],
  placed: Vec3Like,
): { x: number; y: number }[] {
  const pose = framingForCached({ phase, width, height, direction, leafCount: 21, focusSide: null });
  const camera = new PerspectiveCamera(pose.fov, width / height, 0.05, 60);
  applyPose(camera, pose);
  const sign = direction === 'ltr' ? 1 : -1;
  return points(placed, sign).map(([x, y, z]) => {
    const v = new Vector3(x, y, z).project(camera);
    return { x: ((v.x + 1) / 2) * width, y: ((1 - v.y) / 2) * height };
  });
}

type Verdict = 'in' | 'out' | 'cut';
function verdict(pixels: { x: number; y: number }[], width: number, height: number, margin: number): Verdict {
  const inside = pixels.map(
    (p) => p.x > margin && p.x < width - margin && p.y > margin && p.y < height - margin,
  );
  const outside = pixels.map((p) => p.x < 0 || p.x > width || p.y < 0 || p.y > height);
  if (inside.every(Boolean)) return 'in';
  if (outside.every(Boolean)) return 'out';
  return 'cut';
}

describe('where the candle stands', () => {
  it('is beside the book, a little behind it, on its left on a wide screen in an LTR layout', () => {
    const base = candleBaseFor(1.6, 'ltr');
    expect(base.x).toBeLessThan(-1);
    expect(base.z).toBeLessThan(0);
    expect(base.y).toBe(0);
  });

  it('mirrors with the layout: an RTL book keeps its writing leaf on the left, so the candle goes right', () => {
    const ltr = candleBaseFor(1.6, 'ltr');
    const rtl = candleBaseFor(1.6, 'rtl');
    expect(rtl.x).toBeCloseTo(-ltr.x, 6);
    expect(rtl.z).toBeCloseTo(ltr.z, 6);
  });

  it('stands closer to the middle (and further back) on a tall phone screen, so it stays in the frame', () => {
    const wide = candleBaseFor(1.6, 'ltr');
    const phone = candleBaseFor(0.46, 'ltr');
    expect(Math.abs(phone.x)).toBeLessThan(Math.abs(wide.x));
    expect(phone.z).toBeLessThanOrEqual(wide.z);
  });

  it('is a continuous function of the aspect ratio (no jump when a window is resized across a breakpoint)', () => {
    for (const openness of [0, 1]) {
      let previous = candleBaseFor(0.4, 'ltr', openness);
      for (let aspect = 0.41; aspect <= 2.6; aspect += 0.01) {
        const next = candleBaseFor(aspect, 'ltr', openness);
        expect(Math.abs(next.x - previous.x)).toBeLessThan(0.12);
        expect(Math.abs(next.z - previous.z)).toBeLessThan(0.12);
        previous = next;
      }
    }
  });

  it('never stands in the book, at any screen shape, closed or open (it goes round the back of the book to get there)', () => {
    // The footprints of the book (half width, half depth, with the boards' overhang) and the dish's radius.
    for (const [openness, halfWidth] of [
      [0, 1.0],
      [1, 1.72],
    ] as const) {
      for (let aspect = 0.4; aspect <= 2.6; aspect += 0.02) {
        const base = candleBaseFor(aspect, 'ltr', openness);
        const insideX = Math.abs(base.x) < halfWidth + 0.34;
        const insideZ = Math.abs(base.z) < 1.2 + 0.34;
        expect(insideX && insideZ, `aspect ${aspect.toFixed(2)} openness ${String(openness)}`).toBe(false);
      }
    }
  });

  it('gives way as the book opens: further from the book, and clear of the open book on a wide screen', () => {
    const closed = candleBaseFor(1.6, 'ltr', 0);
    const open = candleBaseFor(1.6, 'ltr', 1);
    expect(Math.abs(open.x)).toBeGreaterThan(Math.abs(closed.x));
    expect(open.x + 0.34).toBeLessThan(-1.64);
  });

  it('leaves the stage for the reading framings: far enough that not a sliver of it shows on any wide screen', () => {
    const away = candleBaseFor(1.6, 'ltr', 1, 1);
    expect(away.x).toBeLessThan(-4);
    // ...to the other side in an RTL layout, like everything else.
    expect(candleBaseFor(1.6, 'rtl', 1, 1).x).toBeCloseTo(-away.x, 6);
  });
});

describe('where the inkwell stands', () => {
  it('is on the side opposite the candle, in the empty half of the table, and mirrors with the layout', () => {
    const ltr = inkwellBaseFor(1.6, 'ltr', 0, 0);
    const rtl = inkwellBaseFor(1.6, 'rtl', 0, 0);
    expect(ltr.x).toBeGreaterThan(1.5);
    expect(rtl.x).toBeCloseTo(-ltr.x, 6);
    expect(Math.sign(ltr.x)).toBe(-Math.sign(candleBaseFor(1.6, 'ltr').x));
  });

  it('never stands in the book, at any screen shape, closed, open or in between', () => {
    for (const [openness, halfWidth] of [
      [0, 1.0],
      [1, 1.72],
    ] as const) {
      for (let aspect = 0.4; aspect <= 2.6; aspect += 0.02) {
        const base = inkwellBaseFor(aspect, 'ltr', openness, 0);
        const insideX = Math.abs(base.x) < halfWidth + INKWELL_RADIUS;
        const insideZ = Math.abs(base.z) < 1.2 + INKWELL_RADIUS;
        expect(insideX && insideZ, `aspect ${aspect.toFixed(2)} openness ${String(openness)}`).toBe(false);
      }
    }
  });

  it('is continuous in the aspect ratio', () => {
    for (const openness of [0, 1]) {
      let previous = inkwellBaseFor(0.4, 'ltr', openness, 0);
      for (let aspect = 0.41; aspect <= 2.6; aspect += 0.01) {
        const next = inkwellBaseFor(aspect, 'ltr', openness, 0);
        expect(Math.abs(next.x - previous.x)).toBeLessThan(0.12);
        expect(Math.abs(next.z - previous.z)).toBeLessThan(0.12);
        previous = next;
      }
    }
  });
});

describe('props are fully in the frame or fully out of it, in every phase', () => {
  for (const phase of ALL_PHASES) {
    it(`${phase}: the candle and the inkwell are never cut by the edge of the frame (both directions, nine sizes)`, () => {
      for (const [width, height] of SIZES) {
        for (const direction of ['ltr', 'rtl'] as const) {
          const label = `${phase} ${String(width)}x${String(height)} ${direction}`;
          const candle = pixelsOf(
            phase,
            width,
            height,
            direction,
            candlePoints,
            (aspect, openness, offstage) => candleBaseFor(aspect, direction, openness, offstage),
          );
          const ink = pixelsOf(phase, width, height, direction, inkwellPoints, (aspect, openness, offstage) =>
            inkwellBaseFor(aspect, direction, openness, offstage),
          );
          expect(verdict(candle, width, height, 2), `candle ${label}`).not.toBe('cut');
          expect(verdict(ink, width, height, 2), `inkwell ${label}`).not.toBe('cut');
        }
      }
    });
  }

  it('in the closed and open framings on a wide screen both are in the frame, flame tip and quill tip included (and out when the open book leaves them no room)', () => {
    for (const phase of ['discovery', 'opening', 'awaiting', 'uploading', 'reading', 'closing'] as const) {
      for (const [width, height] of SIZES.filter(([w]) => w >= 1024)) {
        // The open diary on a squarish screen has no room for them: they are out (see propsOffstage).
        const expected: Verdict = propsOffstage(phase, width, height) ? 'out' : 'in';
        for (const direction of ['ltr', 'rtl'] as const) {
          const label = `${phase} ${String(width)}x${String(height)} ${direction}`;
          const candle = pixelsOf(phase, width, height, direction, candlePoints, (a, o, s) =>
            candleBaseFor(a, direction, o, s),
          );
          const ink = pixelsOf(phase, width, height, direction, inkwellPoints, (a, o, s) =>
            inkwellBaseFor(a, direction, o, s),
          );
          expect(verdict(candle, width, height, expected === 'in' ? 6 : 0), `candle ${label}`).toBe(expected);
          expect(verdict(ink, width, height, expected === 'in' ? 6 : 0), `inkwell ${label}`).toBe(expected);
        }
      }
    }
  });

  it('in the reading framings (the camera is over the pages) both are out of the picture on wide screens, in both directions', () => {
    for (const phase of ['unveiling', 'manuscript', 'revealing', 'memory'] as const) {
      for (const [width, height] of SIZES.filter(([w]) => w >= 1024)) {
        for (const direction of ['ltr', 'rtl'] as const) {
          const label = `${phase} ${String(width)}x${String(height)} ${direction}`;
          const candle = pixelsOf(phase, width, height, direction, candlePoints, (a, o, s) =>
            candleBaseFor(a, direction, o, s),
          );
          const ink = pixelsOf(phase, width, height, direction, inkwellPoints, (a, o, s) =>
            inkwellBaseFor(a, direction, o, s),
          );
          expect(verdict(candle, width, height, 0), `candle ${label}`).toBe('out');
          expect(verdict(ink, width, height, 0), `inkwell ${label}`).toBe('out');
        }
      }
    }
  });

  it('on a phone the closed diary shows the candle in the top third of the screen', () => {
    const candle = pixelsOf('discovery', 390, 844, 'ltr', candlePoints, (a, o, s) =>
      candleBaseFor(a, 'ltr', o, s),
    );
    const tip = candle[4];
    expect(tip?.y).toBeLessThan(844 / 3);
  });

  it('knows which phases the props leave for: the reading framings, and a phone showing the flyleaf alone', () => {
    for (const phase of ['unveiling', 'manuscript', 'revealing', 'memory'] as const) {
      expect(propsOffstage(phase, 1440, 900), phase).toBe(true);
      expect(propsOffstage(phase, 390, 844), phase).toBe(true);
    }
    for (const phase of ['discovery', 'opening', 'reading', 'closing'] as const) {
      expect(propsOffstage(phase, 1440, 900), phase).toBe(false);
      if (phase === 'discovery' || phase === 'opening') continue; // (the open welcome book has no room on a phone)
      expect(propsOffstage(phase, 390, 844), phase).toBe(false);
    }
    expect(propsOffstage('awaiting', 1440, 900)).toBe(false);
    expect(propsOffstage('awaiting', 390, 844)).toBe(true);
    expect(propsOffstage('uploading', 390, 844)).toBe(true);
    // The open diary on a squarish screen has no room beside it and no headroom behind it.
    expect(propsOffstage('awaiting', 1024, 768)).toBe(true);
    expect(propsOffstage('opening', 1280, 1024)).toBe(false); // (the centred book is smaller: there is room now)
    expect(propsOffstage('awaiting', 768, 1024)).toBe(false);
  });
});

describe('the flame sits on the wick', () => {
  it('starts at the top of the wick, not floating above it', () => {
    expect(FLAME_BASE_Y).toBeLessThanOrEqual(WICK_TOP_Y);
    expect(WICK_TOP_Y - FLAME_BASE_Y).toBeLessThan(0.03);
    expect(WICK_TOP_Y).toBeGreaterThan(DISH_HEIGHT + CANDLE_HEIGHT * 0.9);
  });

  it('is a 10 cm candle (units of 10 cm)', () => {
    expect(CANDLE_HEIGHT).toBeGreaterThanOrEqual(0.9);
    expect(CANDLE_HEIGHT).toBeLessThanOrEqual(1.1);
  });
});

describe('CandleMotion: the props follow the layout smoothly and write into plain numbers', () => {
  it('starts at the target for the aspect and direction it is given', () => {
    const motion = new CandleMotion(1.6, 'ltr');
    expect(motion.base.x).toBeCloseTo(candleBaseFor(1.6, 'ltr').x, 6);
    expect(motion.flame.y).toBeCloseTo(FLAME_BASE_Y + 0.14, 6);
    expect(motion.flame.x).toBe(motion.base.x);
    expect(motion.ink.x).toBeCloseTo(inkwellBaseFor(1.6, 'ltr', 0, 0).x, 6);
  });

  it('does not move at all while nothing changes', () => {
    const motion = new CandleMotion(1.2, 'ltr', 0);
    const x = motion.base.x;
    const ink = motion.ink.x;
    for (let frame = 0; frame < 120; frame += 1) motion.update(1.2, 'ltr', 0, false, 1 / 60);
    expect(motion.base.x).toBe(x);
    expect(motion.ink.x).toBe(ink);
  });

  it('takes the candle and the inkwell off the stage for the reading framings, but the LIGHT stays where it was', () => {
    const motion = new CandleMotion(1.6, 'ltr', 1);
    const lightBefore = { ...motion.flame };
    for (let frame = 0; frame < 600; frame += 1) motion.update(1.6, 'ltr', 1, true, 1 / 60);
    expect(motion.base.x).toBeLessThan(-4);
    expect(motion.reading).toBeCloseTo(1, 3);
    expect(motion.ink.x).toBeGreaterThan(4);
    // The pages keep the candlelight they had; only the candle is out of the picture.
    expect(motion.flame.x).toBeCloseTo(lightBefore.x, 6);
    expect(motion.flame.z).toBeCloseTo(lightBefore.z, 6);
    // And they come back when the camera comes back.
    for (let frame = 0; frame < 600; frame += 1) motion.update(1.6, 'ltr', 1, false, 1 / 60);
    expect(motion.base.x).toBeCloseTo(candleBaseFor(1.6, 'ltr', 1).x, 3);
    expect(motion.reading).toBeCloseTo(0, 3);
  });
});

/** The footprints (half width, half depth) of the closed and the open book, as the layout tests use them. */
const BOOK_FOOTPRINT = { closed: { x: 1.0, z: 1.2 }, open: { x: 1.72, z: 1.2 } } as const;
const DISH = 0.34;

function insideBook(at: Vec3Like, radius: number, openness: number): boolean {
  const half = openness > 0.5 ? BOOK_FOOTPRINT.open : BOOK_FOOTPRINT.closed;
  return Math.abs(at.x) < half.x + radius && Math.abs(at.z) < half.z + radius;
}

interface SwapOptions {
  aspect: number;
  openness: number;
  from: 'ltr' | 'rtl';
  /** The directions asked for, frame by frame after the first (default: the other one, held). */
  then?: readonly ('ltr' | 'rtl')[];
  offstage?: boolean;
  frames?: number;
}

/**
 * Runs the props through a change of layout direction at 60 frames a second and returns every frame: the places of the
 * candle, the inkwell and the light, and how far out of the picture they are.
 */
function runSwap({ aspect, openness, from, then, offstage = false, frames = 420 }: SwapOptions) {
  const motion = new CandleMotion(aspect, from, openness);
  // Settle first (a resting table).
  for (let frame = 0; frame < (offstage ? 600 : 30); frame += 1)
    motion.update(aspect, from, openness, offstage, 1 / 60);
  const other = from === 'ltr' ? 'rtl' : 'ltr';
  const wanted = then ?? [other];
  const trace: { candle: Vec3Like; ink: Vec3Like; light: Vec3Like; reading: number; shown: 'ltr' | 'rtl' }[] =
    [];
  for (let frame = 0; frame < frames; frame += 1) {
    const direction = wanted[Math.min(Math.floor(frame / 8), wanted.length - 1)] ?? other;
    motion.update(aspect, direction, openness, offstage, 1 / 60);
    trace.push({
      candle: { ...motion.base },
      ink: { ...motion.ink },
      light: { ...motion.flame },
      reading: motion.reading,
      shown: motion.shown,
    });
  }
  return { motion, trace, final: wanted[wanted.length - 1] ?? other };
}

describe('a change of layout direction takes the props off the stage and brings them back on the new side', () => {
  const ASPECTS = [0.46, 0.8, 1.0, 1.3, 1.6, 2.4] as const;

  for (const openness of [0, 1]) {
    for (const aspect of ASPECTS) {
      for (const from of ['ltr', 'rtl'] as const) {
        it(`openness ${String(openness)}, aspect ${String(aspect)}, ${from} to the other: neither prop's footprint ever enters the book or the other prop`, () => {
          const { trace } = runSwap({ aspect, openness, from });
          for (const [frame, now] of trace.entries()) {
            const label = `frame ${String(frame)}`;
            expect(insideBook(now.candle, DISH, openness), `candle in the book, ${label}`).toBe(false);
            expect(insideBook(now.ink, INKWELL_RADIUS, openness), `inkwell in the book, ${label}`).toBe(
              false,
            );
            const apart = Math.hypot(now.candle.x - now.ink.x, now.candle.z - now.ink.z);
            expect(apart, `candle and inkwell, ${label}`).toBeGreaterThan(DISH + INKWELL_RADIUS);
          }
        });
      }
    }
  }

  it("they are out of the picture at the moment the table is laid out again, and out of it on the candle's old side", () => {
    for (const [width, height] of [
      [1440, 900],
      [390, 844],
      [3440, 1440],
    ] as const) {
      const aspect = width / height;
      const { trace } = runSwap({ aspect, openness: 0, from: 'ltr' });
      const swapped = trace.findIndex((now) => now.shown === 'rtl');
      expect(swapped, `${String(width)}x${String(height)}`).toBeGreaterThan(0);
      for (const index of [swapped - 1, swapped, swapped + 1]) {
        const now = trace[index];
        const candle = projectAt(
          'discovery',
          width,
          height,
          'ltr',
          candlePoints,
          now?.candle ?? { x: 0, y: 0, z: 0 },
        );
        const ink = projectAt(
          'discovery',
          width,
          height,
          'ltr',
          inkwellPoints,
          now?.ink ?? { x: 0, y: 0, z: 0 },
        );
        expect(
          verdict(candle, width, height, 0),
          `candle ${String(index)} ${String(width)}x${String(height)}`,
        ).toBe('out');
        expect(
          verdict(ink, width, height, 0),
          `inkwell ${String(index)} ${String(width)}x${String(height)}`,
        ).toBe('out');
      }
    }
  });

  it('on their way out each prop moves away from the book on its own side (each one out through the side of the picture)', () => {
    const { trace } = runSwap({ aspect: 1.6, openness: 0, from: 'ltr' });
    const swapped = trace.findIndex((now) => now.shown === 'rtl');
    let previous = trace[0];
    for (const now of trace.slice(1, swapped)) {
      expect(now.candle.x).toBeLessThanOrEqual((previous?.candle.x ?? 0) + 1e-9);
      expect(now.ink.x).toBeGreaterThanOrEqual((previous?.ink.x ?? 0) - 1e-9);
      expect(Math.sign(now.candle.x)).toBe(-1);
      expect(Math.sign(now.ink.x)).toBe(1);
      previous = now;
    }
  });

  it('they end on the new side, at the places the layout gives, and the light has gone there too', () => {
    for (const aspect of ASPECTS) {
      const { motion, final } = runSwap({ aspect, openness: 0, from: 'ltr', frames: 600 });
      const candle = candleBaseFor(aspect, final, 0);
      const ink = inkwellBaseFor(aspect, final, 0, 0);
      expect(motion.base.x, `candle x at ${String(aspect)}`).toBeCloseTo(candle.x, 3);
      expect(motion.base.z).toBeCloseTo(candle.z, 3);
      expect(motion.ink.x, `inkwell x at ${String(aspect)}`).toBeCloseTo(ink.x, 3);
      expect(motion.ink.z).toBeCloseTo(ink.z, 3);
      expect(motion.flame.x).toBeCloseTo(candle.x, 3);
      expect(motion.reading).toBe(0);
      expect(motion.shown).toBe(final);
    }
  });

  it('the light glides across (it never jumps), and the haze that follows the light fades while the candle is away', () => {
    const { trace } = runSwap({ aspect: 1.6, openness: 0, from: 'ltr' });
    for (let frame = 1; frame < trace.length; frame += 1) {
      const step = Math.abs((trace[frame]?.light.x ?? 0) - (trace[frame - 1]?.light.x ?? 0));
      expect(step, `frame ${String(frame)}`).toBeLessThan(0.4); // about 6 cm a frame at most (it crosses in half a second)
    }
    const peak = Math.max(...trace.map((now) => now.reading));
    expect(peak).toBe(1);
    expect(trace[trace.length - 1]?.reading).toBe(0);
  });

  it('a change back before the props have left simply stays: they come back in place without ever crossing', () => {
    const { trace, motion } = runSwap({
      aspect: 1.6,
      openness: 0,
      from: 'ltr',
      then: ['rtl', 'ltr'],
      frames: 500,
    });
    for (const now of trace) {
      expect(insideBook(now.candle, DISH, 0)).toBe(false);
      expect(insideBook(now.ink, INKWELL_RADIUS, 0)).toBe(false);
    }
    expect(motion.shown).toBe('ltr');
    expect(motion.base.x).toBeCloseTo(candleBaseFor(1.6, 'ltr', 0).x, 3);
    expect(motion.reading).toBe(0);
  });

  it('two changes in quick succession (the diary turns over and back) never put a prop in the book either', () => {
    const { trace, motion } = runSwap({
      aspect: 1.6,
      openness: 1,
      from: 'ltr',
      then: [
        'rtl',
        'rtl',
        'rtl',
        'rtl',
        'rtl',
        'rtl',
        'rtl',
        'rtl',
        'rtl',
        'rtl',
        'rtl',
        'rtl',
        'rtl',
        'ltr',
      ],
      frames: 700,
    });
    for (const now of trace) {
      expect(insideBook(now.candle, DISH, 1)).toBe(false);
      expect(insideBook(now.ink, INKWELL_RADIUS, 1)).toBe(false);
      expect(Math.hypot(now.candle.x - now.ink.x, now.candle.z - now.ink.z)).toBeGreaterThan(
        DISH + INKWELL_RADIUS,
      );
    }
    expect(motion.shown).toBe('ltr');
    expect(motion.reading).toBe(0);
  });

  it('where the props are off the stage anyway (the reading framings) the layout just changes under them: nothing to fade, nothing visible', () => {
    const { trace } = runSwap({ aspect: 1.6, openness: 0, from: 'ltr', offstage: true });
    for (const now of trace) {
      expect(now.reading).toBe(1);
      expect(Math.abs(now.candle.x)).toBeGreaterThan(4);
      expect(Math.abs(now.ink.x)).toBeGreaterThan(4);
    }
    // ...and the light still goes to the new side.
    expect(trace[trace.length - 1]?.light.x).toBeCloseTo(candleBaseFor(1.6, 'rtl', 0).x, 3);
  });

  it('the quill follows the layout the props are laid out for (it turns while they are away), not the one asked for', () => {
    const motion = new CandleMotion(1.6, 'ltr', 0);
    motion.update(1.6, 'rtl', 0, false, 1 / 60);
    expect(motion.shown).toBe('ltr');
    for (let frame = 0; frame < 400; frame += 1) motion.update(1.6, 'rtl', 0, false, 1 / 60);
    expect(motion.shown).toBe('rtl');
  });
});

describe('the layout functions allocate nothing when given somewhere to write', () => {
  it('write into `out` and return it, with the same numbers as the allocating form', () => {
    const out = { x: 9, y: 9, z: 9 };
    for (const aspect of [0.46, 1.2, 1.6, 2.4]) {
      for (const direction of ['ltr', 'rtl'] as const) {
        expect(candleBaseFor(aspect, direction, 0.4, 0.2, out)).toBe(out);
        expect(out).toEqual(candleBaseFor(aspect, direction, 0.4, 0.2));
        expect(inkwellBaseFor(aspect, direction, 0.4, 0.2, out)).toBe(out);
        expect(out).toEqual(inkwellBaseFor(aspect, direction, 0.4, 0.2));
      }
    }
  });

  it('do not share their scratch: a call for one prop never changes the answer for the other', () => {
    const candle = { x: 0, y: 0, z: 0 };
    const ink = { x: 0, y: 0, z: 0 };
    candleBaseFor(1.6, 'ltr', 1, 0, candle);
    inkwellBaseFor(0.5, 'rtl', 0, 0, ink);
    const again = candleBaseFor(1.6, 'ltr', 1, 0);
    expect(candle).toEqual(again);
    expect(ink).toEqual(inkwellBaseFor(0.5, 'rtl', 0, 0));
  });

  it('CandleMotion keeps the very same objects for the places, whatever happens to them', () => {
    const motion = new CandleMotion(1.6, 'ltr', 0);
    const { base, flame, ink } = motion;
    for (let frame = 0; frame < 300; frame += 1) {
      motion.update(
        1.3 + frame * 0.001,
        frame < 150 ? 'ltr' : 'rtl',
        frame % 90 < 45 ? 0 : 1,
        frame % 70 < 10,
        1 / 60,
      );
    }
    expect(motion.base).toBe(base);
    expect(motion.flame).toBe(flame);
    expect(motion.ink).toBe(ink);
  });
});

describe('the props are wholly in the picture or wholly out of it at every aspect ratio (0.42 to 2.6, in steps of 0.01)', () => {
  for (const phase of ALL_PHASES) {
    for (const height of [720, 1000]) {
      it(`${phase}, windows ${String(height)} px tall: never cut (rest pose, both directions), and in with the margin whenever they are on the stage`, () => {
        for (let aspect = 0.42; aspect <= 2.6001; aspect += 0.01) {
          const width = Math.round(aspect * height);
          const offstage = propsOffstage(phase, width, height);
          for (const direction of ['ltr', 'rtl'] as const) {
            const label = `${phase} ${String(width)}x${String(height)} ${direction}`;
            const reach = cameraReach(phase, width, height, direction);
            const want: Verdict = offstage ? 'out' : 'in';
            // From the rest pose and from the four corners of everywhere the pointer and the drift can take the camera.
            for (const [cx, cy] of CAMERA_CORNERS) {
              const shift = { x: cx * reach.x, y: cy * reach.y };
              const candle = pixelsOf(
                phase,
                width,
                height,
                direction,
                candlePoints,
                (a, o, s) => candleBaseFor(a, direction, o, s),
                shift,
              );
              const ink = pixelsOf(
                phase,
                width,
                height,
                direction,
                inkwellPoints,
                (a, o, s) => inkwellBaseFor(a, direction, o, s),
                shift,
              );
              const margin = offstage ? 0 : 2;
              const at = `${label} camera ${cx > 0 ? '+' : cx < 0 ? '-' : '0'}${cy > 0 ? '+' : cy < 0 ? '-' : '0'}`;
              expect(verdict(candle, width, height, margin), `candle ${at}`).toBe(want);
              expect(verdict(ink, width, height, margin), `inkwell ${at}`).toBe(want);
            }
          }
        }
      });
    }
  }

  it('the opening phase (the camera holds still for the open book from its start) is not cut at the extremes of the camera either, from phones to ultra-wide', () => {
    for (const [width, height] of [
      [1280, 720],
      [1440, 900],
      [1920, 1080],
      [2560, 1440],
      [3226, 1440],
      [390, 844],
    ] as const) {
      const offstage = propsOffstage('opening', width, height);
      for (const direction of ['ltr', 'rtl'] as const) {
        const reach = cameraReach('opening', width, height, direction);
        for (const [cx, cy] of CAMERA_CORNERS) {
          const shift = { x: cx * reach.x, y: cy * reach.y };
          const candle = pixelsOf(
            'opening',
            width,
            height,
            direction,
            candlePoints,
            (a, o, s) => candleBaseFor(a, direction, o, s),
            shift,
          );
          expect(verdict(candle, width, height, 0), `${String(width)}x${String(height)} ${direction}`).toBe(
            offstage ? 'out' : 'in',
          );
        }
      }
    }
  });

  it('the props are still on the stage on the screens people use: desktop and phone, closed and open', () => {
    for (const [phase, width, height] of [
      ['discovery', 1920, 1080],
      ['discovery', 1440, 900],
      ['opening', 1440, 900],
      ['awaiting', 1440, 900],
      ['awaiting', 1920, 1080],
      ['awaiting', 1280, 720],
      ['awaiting', 3440, 1440],
      ['closing', 1440, 900],
    ] as const) {
      expect(propsOffstage(phase, width, height), `${phase} ${String(width)}x${String(height)}`).toBe(false);
    }
  });

  it('the aspect band in which the flame used to be cut on narrow windows (0.6 to 0.8, under 720 px wide) is covered: the candle is out of it, not cut', () => {
    for (const width of [549, 600, 640, 700, 711]) {
      for (const phase of ['discovery', 'reading', 'closing'] as const) {
        const aspect = width / 900;
        const candle = pixelsOf(phase, width, 900, 'ltr', candlePoints, (a, o, s) =>
          candleBaseFor(a, 'ltr', o, s),
        );
        expect(
          verdict(candle, width, 900, 0),
          `${phase} ${String(width)}x900 (aspect ${aspect.toFixed(2)})`,
        ).not.toBe('cut');
      }
    }
  });
});
