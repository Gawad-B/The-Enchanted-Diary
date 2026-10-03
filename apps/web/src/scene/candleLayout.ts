import type { Direction } from '@enchanted/shared';
import { damp } from './easing';
import { FLAME_BASE_Y, FLAME_CENTER_Y } from './sceneConstants';

/*
 * Where the props stand: the candle and, on the other side of the book, the inkwell with its quill. They are at the
 * edge of the picture, and a prop at the edge is either wholly in the frame or wholly out of it (a sliver of a dish at
 * the border is worse than nothing):
 *  - the candle stands beside the closed book, so its light rakes across the cover and throws the book's shadow toward
 *    the viewer; it gives way as the book opens (the open diary is twice as wide); it mirrors with the layout (an RTL
 *    book keeps its writing leaf on the left, so the candle goes right);
 *  - on a tall phone screen both stand BEHIND the book, near the middle, where the frame has room above it;
 *  - when the camera goes in over the pages they leave the stage (the framing has no room for them); the candle's LIGHT
 *    stays where it was, so the pages keep their candlelight.
 * Moving between the phone place and the wide place goes round the back of the book (first sideways, then forward), so
 * a prop never crosses the book on the way.
 * When the layout flips (the book turns itself over, the language changes) the two props would have to cross the table
 * to their mirrored places, through the book and through each other: they leave the stage instead, the table is laid
 * out again for the new direction while they are out of the picture, and they come back on the new side.
 */

export interface Vec3Like {
  x: number;
  y: number;
  z: number;
}

interface Place {
  x: number;
  z: number;
}

/** The radius of the inkwell (scene units, 10 cm each). */
export const INKWELL_RADIUS = 0.19;

const CANDLE_CLOSED_WIDE: Place = { x: -1.6, z: -0.45 };
const CANDLE_CLOSED_PHONE: Place = { x: -0.6, z: -1.8 };
const CANDLE_OPEN_WIDE: Place = { x: -2.2, z: -0.3 };
const CANDLE_OPEN_PHONE: Place = { x: -0.75, z: -2.05 };
const CANDLE_CLOSED = { wide: CANDLE_CLOSED_WIDE, phone: CANDLE_CLOSED_PHONE };
const CANDLE_OPEN = { wide: CANDLE_OPEN_WIDE, phone: CANDLE_OPEN_PHONE };

const INK_CLOSED_WIDE: Place = { x: 1.75, z: -0.3 };
const INK_CLOSED_PHONE: Place = { x: 0.55, z: -1.8 };
const INK_OPEN_WIDE: Place = { x: 1.95, z: -0.3 };
const INK_OPEN_PHONE: Place = { x: 0.7, z: -2.0 };
const INK_CLOSED = { wide: INK_CLOSED_WIDE, phone: INK_CLOSED_PHONE };
const INK_OPEN = { wide: INK_OPEN_WIDE, phone: INK_OPEN_PHONE };

/**
 * Aspect ratios over which a prop moves from its phone place to its wide place: sideways first, then forward, so that it
 * goes round the back of the book. The open book is wide, so it needs a wider screen before there is room beside it.
 */
const CANDLE_STAGES = {
  sideways: { closed: [0.62, 0.95], open: [1.0, 1.35] },
  forward: { closed: [0.95, 1.2], open: [1.35, 1.6] },
} as const;
/** The inkwell has to be further out before it comes forward (it is the one that would stand in the book). */
const INK_STAGES = {
  sideways: { closed: [0.62, 1.0], open: [1.0, 1.35] },
  forward: { closed: [1.15, 1.45], open: [1.35, 1.6] },
} as const;
type Stages = typeof CANDLE_STAGES | typeof INK_STAGES;

/**
 * How far from the middle of the table (scene units) a prop is when it is off the stage: out through the side of the
 * picture on its own side, far enough that nothing of it shows on any screen shape (a wide screen shows more of the table).
 */
export function awayDistance(aspect: number): number {
  return Math.max(4.4, 2.6 * aspect);
}

function smooth(t: number): number {
  const x = Math.min(Math.max(t, 0), 1);
  return x * x * (3 - 2 * x);
}

const mix = (a: number, b: number, t: number): number => a + (b - a) * t;

/** How far along a range of aspect ratios an aspect is, eased (0 before it, 1 after it). */
function along(aspect: number, range: readonly [number, number]): number {
  return smooth((aspect - range[0]) / (range[1] - range[0]));
}

/** Scratch for the place of a prop: `placeFor` is called every frame and writes here instead of making an object. */
const PLACE: Place = { x: 0, z: 0 };

/**
 * The place of a prop for a screen shape and how open the book is, before mirroring: `closed` and `open` are pairs of
 * places. Written into the module's scratch place, which is only good until the next call.
 */
function placeFor(
  aspect: number,
  openness: number,
  closed: { wide: Place; phone: Place },
  open: { wide: Place; phone: Place },
  stages: Stages,
): Place {
  const o = smooth(openness);
  const sideClosed = along(aspect, stages.sideways.closed);
  const sideOpen = along(aspect, stages.sideways.open);
  const forwardClosed = along(aspect, stages.forward.closed);
  const forwardOpen = along(aspect, stages.forward.open);
  PLACE.x = mix(mix(closed.phone.x, closed.wide.x, sideClosed), mix(open.phone.x, open.wide.x, sideOpen), o);
  PLACE.z = mix(
    mix(closed.phone.z, closed.wide.z, forwardClosed),
    mix(open.phone.z, open.wide.z, forwardOpen),
    o,
  );
  return PLACE;
}

/**
 * The foot of the candle for a screen shape, a layout direction, how open the book is (0 closed .. 1 open) and how far
 * the props have left the stage (0 .. 1): a pure, continuous function.
 */
export function candleBaseFor(
  aspect: number,
  direction: Direction,
  openness = 0,
  offstage = 0,
  out: Vec3Like = { x: 0, y: 0, z: 0 },
): Vec3Like {
  const sign = direction === 'ltr' ? 1 : -1;
  const place = placeFor(aspect, openness, CANDLE_CLOSED, CANDLE_OPEN, CANDLE_STAGES);
  // An ultra-wide screen is short for its width: the open book fills its height, and a 10 cm candle beside it would
  // lose its flame over the top edge. It stands further forward there.
  const ultra = smooth((aspect - 1.9) / 0.4) * smooth(openness);
  out.x = -sign * mix(-place.x, awayDistance(aspect), smooth(offstage));
  out.y = 0;
  out.z = place.z + ultra * 0.55;
  return out;
}

/** The foot of the inkwell: on the side of the book opposite the candle. Written into `out` when one is given. */
export function inkwellBaseFor(
  aspect: number,
  direction: Direction,
  openness: number,
  offstage: number,
  out: Vec3Like = { x: 0, y: 0, z: 0 },
): Vec3Like {
  const sign = direction === 'ltr' ? 1 : -1;
  const place = placeFor(aspect, openness, INK_CLOSED, INK_OPEN, INK_STAGES);
  // A squarer screen shows less of the table to the side of the book: keep the inkwell inside what it shows.
  const reach = openness < 0.5 ? aspect * 1.1 - 0.1 : Infinity;
  out.x =
    sign *
    mix(Math.min(place.x, Math.max(reach, INK_CLOSED_PHONE.x)), awayDistance(aspect), smooth(offstage));
  out.y = 0;
  out.z = place.z;
  return out;
}

/** How far out of the picture (0 .. 1) the props must be before the table is laid out again for a new direction. */
const OUT_OF_SIGHT = 0.995;
/** How near the candle's light must be to its new place before the candle and the inkwell come back. */
const LIGHT_HOME = 0.05;
/** How quickly the props leave for a change of layout (they are in the way of a book that is turning over). */
const LEAVE_RATE = 6.5;
/** How quickly they leave for, and return from, a framing that has no room for them (the camera goes in over the pages). */
const OFFSTAGE_RATE = 3.2;
const GLIDE_RATE = 4.2;
/** The light crosses the table at this rate while the props are away (nobody watches the candle then, only the light). */
const LIGHT_CROSSING_RATE = 7;

/** The props' places, smoothed over time. Plain numbers, written in place, so reading and updating them costs nothing. */
export class CandleMotion {
  /** The foot of the candle in the world (it leaves the stage in the reading framings and for a layout change). */
  readonly base: Vec3Like;
  /** The middle of the flame in the world: where the lights and the dust's light source sit (they do not leave). */
  readonly flame: Vec3Like = { x: 0, y: 0, z: 0 };
  /** The foot of the inkwell in the world. */
  readonly ink: Vec3Like;
  /** 0 on the stage .. 1 off it (the reading framings, and while the table is laid out again for a new direction). */
  reading = 0;
  /** The direction the table is laid out for now: it follows the layout only once the props are out of the picture. */
  shown: Direction;
  /** The candle's light has been sent to the new side and the props wait for it there (they are still out). */
  private settling = false;
  private readonly light: { x: number; z: number };
  /** Where the inkwell stands on the stage (it glides there; leaving the stage is mixed in on top). */
  private readonly inkStage: { x: number; z: number };
  private readonly stand: Vec3Like = { x: 0, y: 0, z: 0 };
  private readonly inkStand: Vec3Like = { x: 0, y: 0, z: 0 };

  /**
   * The props as they stand when the scene mounts: where the layout `direction` puts them for a book `openness` open, and
   * already off the stage when the phase has no room for them (`offstage`). A mount is not a change: nothing is
   * animated, so the first frame is already the resting state (the layout the presenter will lay out must be the
   * one given here, or the first `update` will see a layout change and play it).
   */
  constructor(aspect: number, direction: Direction, openness = 0, offstage = false) {
    this.shown = direction;
    this.reading = offstage ? 1 : 0;
    const stand = candleBaseFor(aspect, direction, openness, 0);
    this.light = { x: stand.x, z: stand.z };
    this.base = { ...stand };
    this.ink = inkwellBaseFor(aspect, direction, openness, 0);
    this.inkStage = { x: this.ink.x, z: this.ink.z };
    this.layOut(aspect);
  }

  /** Puts the candle and the inkwell where their light and their places on the stage say, less how far out they are. */
  private layOut(aspect: number): void {
    const out = smooth(this.reading);
    const sign = this.shown === 'ltr' ? 1 : -1;
    // The candle model is where its light is, until it leaves the stage.
    this.base.x = mix(this.light.x, -sign * awayDistance(aspect), out);
    this.base.z = this.light.z;
    this.syncFlame();
    // The inkwell leaves the stage through the side the same way the candle does.
    this.ink.x = mix(this.inkStage.x, sign * awayDistance(aspect), out);
    this.ink.z = this.inkStage.z;
  }

  private syncFlame(): void {
    this.flame.x = this.light.x;
    this.flame.y = this.base.y + FLAME_CENTER_Y;
    this.flame.z = this.light.z;
  }

  /** Where the top of the wick is, in the world. */
  wickTopY(): number {
    return this.base.y + FLAME_BASE_Y;
  }

  /**
   * Glides toward the places for the current screen shape, layout and openness of the book (about 1 s to settle), and
   * off the stage and back when the framing has no room for the props (`offstage`). `instant` says the layout changes at
   * once (reduced motion, the scene settling in): then the props change sides at once too.
   *
   * A change of layout direction takes the props off the stage first (they slide out on their own side, away from the
   * book), lays the table out again for the new direction while they are out of sight (the candle's light glides to
   * the new side; the inkwell is simply put there), and brings them back on the new side. Mirrored places are on the
   * far side of the book, so gliding there would take both through the book and through each other.
   */
  update(
    aspect: number,
    direction: Direction,
    openness: number,
    offstage: boolean,
    dt: number,
    instant = false,
  ): void {
    if (instant && direction !== this.shown) {
      // The book re-lays itself out at once (reduced motion, or the scene is still settling in), so nothing is turning
      // over for the props to leave for: they are simply on the other side. The light goes with them.
      this.shown = direction;
      this.settling = false;
      const stand = candleBaseFor(aspect, direction, openness, 0, this.stand);
      this.light.x = stand.x;
      this.light.z = stand.z;
      inkwellBaseFor(aspect, direction, openness, 0, this.inkStand);
      this.inkStage.x = this.inkStand.x;
      this.inkStage.z = this.inkStand.z;
    }
    const turning = direction !== this.shown;
    if (turning && this.reading >= OUT_OF_SIGHT) {
      this.reading = 1;
      this.shown = direction;
      this.settling = true;
      // Out of sight: the inkwell is put at its new place at once, never carried across the table.
      inkwellBaseFor(aspect, direction, openness, 0, this.inkStand);
      this.inkStage.x = this.inkStand.x;
      this.inkStage.z = this.inkStand.z;
    }
    const away = offstage || this.shown !== direction || this.settling;
    const rate = turning || this.settling ? LEAVE_RATE : OFFSTAGE_RATE;
    this.reading = damp(this.reading, away ? 1 : 0, rate, dt);
    if (Math.abs(this.reading - (away ? 1 : 0)) < 1e-4) this.reading = away ? 1 : 0;

    const stand = candleBaseFor(aspect, this.shown, openness, 0, this.stand);
    if (stand.x !== this.light.x || stand.z !== this.light.z) {
      const lightRate = this.settling ? LIGHT_CROSSING_RATE : GLIDE_RATE;
      this.light.x = damp(this.light.x, stand.x, lightRate, dt);
      this.light.z = damp(this.light.z, stand.z, lightRate, dt);
      if (Math.abs(this.light.x - stand.x) < 1e-5) this.light.x = stand.x;
      if (Math.abs(this.light.z - stand.z) < 1e-5) this.light.z = stand.z;
    }
    if (
      this.settling &&
      Math.abs(this.light.x - stand.x) < LIGHT_HOME &&
      Math.abs(this.light.z - stand.z) < LIGHT_HOME
    ) {
      this.settling = false;
    }

    // The inkwell glides to its place on the stage.
    const ink = inkwellBaseFor(aspect, this.shown, openness, 0, this.inkStand);
    if (ink.x !== this.inkStage.x || ink.z !== this.inkStage.z) {
      this.inkStage.x = damp(this.inkStage.x, ink.x, GLIDE_RATE, dt);
      this.inkStage.z = damp(this.inkStage.z, ink.z, GLIDE_RATE, dt);
      if (Math.abs(this.inkStage.x - ink.x) < 1e-5) this.inkStage.x = ink.x;
      if (Math.abs(this.inkStage.z - ink.z) < 1e-5) this.inkStage.z = ink.z;
    }
    this.layOut(aspect);
  }
}
