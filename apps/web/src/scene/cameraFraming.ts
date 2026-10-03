import { PerspectiveCamera, Vector3 } from 'three';
import type { Direction } from '@enchanted/shared';
import type { Phase } from '../state/experience';
import { NARROW_BREAKPOINT_PX } from '../state/narrowSync';
import type { ScreenQuad, ScreenRect } from '../state/anchorStore';
import {
  BASE_Y,
  BOARD_OVERHANG,
  PAGE_H,
  PAGE_W,
  LEAF_T,
  closedCenterX,
  closedFootprint,
  openFootprint,
  virtualLeafTotal,
} from './book/dimensions';
import { turnedSide, unturnedSide, type Side } from '../book/bookLayout';
import { leafReachOutline } from './book/leafReach';

/*
 * Camera framing. All of it is pure maths on a real THREE.PerspectiveCamera, so the rules (the whole book is
 * visible at any aspect ratio from 0.45 to 2.4, the reserved regions stay clear) are tested without WebGL.
 *
 * The camera looks at a point on the table from the +z side, elevated by `elevationDeg`. The book is centred
 * on the origin: a closed book is centred through the root offset of the book, an open one on the gutter.
 */

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

/** Fractions of the viewport (0..1) the book must keep clear, for overlays that live there. */
export interface Reserved {
  left: number;
  right: number;
  bottom: number;
}

export const NO_RESERVATION: Reserved = { left: 0, right: 0, bottom: 0 };

export interface Footprint {
  width: number;
  depth: number;
  height: number;
  /**
   * Something that stands up from the table apart from the box: everything a turning leaf sweeps through, as an
   * outline seen end-on (x across the book, y above the table; see leafReach.ts), as deep as the box. The picture
   * keeps room for it without framing a full-width box that high (the corners of which the leaf never reaches).
   */
  standing?: readonly { x: number; y: number }[];
}

export interface FitOptions {
  fovDeg: number;
  elevationDeg: number;
  footprint: Footprint;
  /** The part of the free region the book may fill (0..1). */
  fill: number;
  /** Where the middle of the footprint is, on the table (x, z). */
  center?: { x: number; z: number };
  /**
   * Moves the book up (+) or down (-) in the frame, in normalised device units (2 = the whole height). The closed
   * and open framings lower the book a little on a wide screen to leave headroom for the candle and the room.
   */
  shiftY?: number;
}

export const DEFAULT_FIT: FitOptions = {
  fovDeg: 38,
  elevationDeg: 38,
  footprint: { width: 1.7, depth: 2.25, height: 0.5 },
  fill: 0.6,
};

export interface FitResult {
  /** Distance from the look-at point to the camera. */
  distance: number;
  /** Where to look, on the table (the footprint centre moved so the book sits in the free region). */
  target: Vec3;
}

const scratchCamera = new PerspectiveCamera(38, 1, 0.05, 60);
const scratchCorner = new Vector3();

function cameraPosition(target: Vec3, distance: number, elevationDeg: number, out: Vec3): Vec3 {
  const elevation = (elevationDeg * Math.PI) / 180;
  out.x = target.x;
  out.y = target.y + distance * Math.sin(elevation);
  out.z = target.z + distance * Math.cos(elevation);
  return out;
}

function pointCamera(camera: PerspectiveCamera, target: Vec3, distance: number, options: FitOptions): void {
  const position = cameraPosition(target, distance, options.elevationDeg, { x: 0, y: 0, z: 0 });
  camera.fov = options.fovDeg;
  camera.position.set(position.x, position.y, position.z);
  camera.up.set(0, 1, 0);
  camera.lookAt(target.x, target.y, target.z);
  camera.updateProjectionMatrix();
  camera.updateMatrixWorld(true);
}

interface NdcBox {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

function projectBox(
  camera: PerspectiveCamera,
  centre: { x: number; z: number },
  box: Footprint,
  out: NdcBox,
): NdcBox {
  out.minX = out.minY = Infinity;
  out.maxX = out.maxY = -Infinity;
  for (let i = 0; i < 8; i += 1) {
    scratchCorner.set(
      centre.x + ((i & 1) === 0 ? -1 : 1) * (box.width / 2),
      (i & 2) === 0 ? 0 : box.height,
      centre.z + ((i & 4) === 0 ? -1 : 1) * (box.depth / 2),
    );
    scratchCorner.project(camera);
    out.minX = Math.min(out.minX, scratchCorner.x);
    out.maxX = Math.max(out.maxX, scratchCorner.x);
    out.minY = Math.min(out.minY, scratchCorner.y);
    out.maxY = Math.max(out.maxY, scratchCorner.y);
  }
  if (box.standing) {
    for (const point of box.standing) {
      for (let side = 0; side < 2; side += 1) {
        scratchCorner.set(point.x, point.y, centre.z + (side === 0 ? -1 : 1) * (box.depth / 2));
        scratchCorner.project(camera);
        out.minX = Math.min(out.minX, scratchCorner.x);
        out.maxX = Math.max(out.maxX, scratchCorner.x);
        out.minY = Math.min(out.minY, scratchCorner.y);
        out.maxY = Math.max(out.maxY, scratchCorner.y);
      }
    }
  }
  return out;
}

/** The free region of the viewport in normalised device coordinates, shrunk by `fill` about its middle. */
function freeRegion(
  reserved: Reserved,
  fill: number,
  shiftY = 0,
): { cx: number; cy: number; hw: number; hh: number } {
  const hw = Math.max(0.05, 1 - reserved.left - reserved.right);
  const hh = Math.max(0.05, 1 - reserved.bottom);
  return { cx: reserved.left - reserved.right, cy: reserved.bottom + shiftY, hw: hw * fill, hh: hh * fill };
}

/**
 * Finds the nearest camera distance at which the whole footprint fits the free region of the viewport, and
 * the look-at point that centres it there. `reserved` keeps room for overlays on the sides or at the bottom:
 * with `{ right: 0.32 }` the book sits in the left 68% of the screen.
 */
export function fitBookToViewport(
  aspect: number,
  reserved: Reserved = NO_RESERVATION,
  options: Partial<FitOptions> = {},
): FitResult {
  const fit: FitOptions = { ...DEFAULT_FIT, ...options };
  const centre = fit.center ?? { x: 0, z: 0 };
  const region = freeRegion(reserved, fit.fill, fit.shiftY);
  const camera = scratchCamera;
  camera.aspect = Math.max(aspect, 0.05);
  const box: NdcBox = { minX: 0, maxX: 0, minY: 0, maxY: 0 };
  const tanHalf = Math.tan((fit.fovDeg * Math.PI) / 360);
  const elevation = (fit.elevationDeg * Math.PI) / 180;

  /** Evaluates one distance: centres the book in the region, returns the overshoot (> 1 means too big). */
  const evaluate = (distance: number, target: Vec3): number => {
    for (let pass = 0; pass < 6; pass += 1) {
      pointCamera(camera, target, distance, fit);
      projectBox(camera, centre, fit.footprint, box);
      // Shift the look-at point (along the camera's right and up axes) to move the box to the region centre.
      const shiftX = region.cx - (box.minX + box.maxX) / 2;
      const shiftY = region.cy - (box.minY + box.maxY) / 2;
      const halfWidthAtTarget = distance * tanHalf * camera.aspect;
      const halfHeightAtTarget = distance * tanHalf;
      // Moving the target by +s along the camera right moves the book by -s in the image.
      target.x -= shiftX * halfWidthAtTarget;
      // Camera up has components (0, cos e, -sin e); on the table plane that is a move along -z.
      const upShift = -shiftY * halfHeightAtTarget;
      target.z += -upShift / Math.max(Math.sin(elevation), 0.2);
    }
    pointCamera(camera, target, distance, fit);
    projectBox(camera, centre, fit.footprint, box);
    return Math.max((box.maxX - box.minX) / (2 * region.hw), (box.maxY - box.minY) / (2 * region.hh));
  };

  let low = 0.4;
  let high = 80;
  let best: FitResult = { distance: high, target: { x: centre.x, y: 0, z: centre.z } };
  for (let i = 0; i < 34; i += 1) {
    const mid = (low + high) / 2;
    const target: Vec3 = { x: centre.x, y: 0, z: centre.z };
    if (evaluate(mid, target) <= 1) {
      high = mid;
      best = { distance: mid, target };
    } else {
      low = mid;
    }
  }
  return best;
}

/** Which framing a phase uses, and how the book is posed in it. */
export type FramingKind = 'closed' | 'open' | 'reading';

/**
 * `writing` (global section T) is the dive onto a diary page: in the awaiting phase (the flyleaf is the writing page) and the
 * manuscript phase the framing is a reading one, whatever the phase's own kind is; in any other phase it changes nothing.
 */
export function framingKindFor(phase: Phase, writing = false): FramingKind {
  if (writing && (phase === 'awaiting' || phase === 'manuscript')) return 'reading';
  switch (phase) {
    case 'closing':
      return 'closed';
    // The book stays OPEN while the diary reads the manuscript (owner direction: no close after the upload).
    case 'reading':
    case 'discovery':
    case 'opening':
    case 'awaiting':
    case 'uploading':
      return 'open';
    case 'unveiling':
    case 'manuscript':
    case 'revealing':
    case 'memory':
      return 'reading';
  }
}

const FOV_DEG = 38;
/** How far the book is lowered in the frame on a wide screen (the candle and the room get the headroom). */
const CLOSED_SHIFT_Y = -0.2;
const NARROW_CLOSED_SHIFT_Y = -0.2;
const OPEN_SHIFT_Y = -0.1;
const ELEVATION: Record<FramingKind, number> = { closed: 38, open: 55, reading: 67 };
const NARROW_ELEVATION: Record<FramingKind, number> = { closed: 48, open: 62, reading: 72 };

export interface FramingContext {
  phase: Phase;
  width: number;
  height: number;
  direction: Direction;
  /** Leaves in the book, for the thickness of a closed block. */
  leafCount: number;
  /** The side in view on a narrow screen, or while reading closely. */
  focusSide: Side | null;
  /** "Read closely": one page fills the picture (the manuscript phase only), whatever the screen. */
  closely?: boolean;
  /**
   * The dive (global section T): the book is turned to a diary page (in the awaiting phase, the flyleaf) and the page, on the
   * unturned side, faces the viewer and fills most of the picture. A reading framing, steeper and a little less full than
   * "Read closely".
   */
  writing?: boolean;
  /** Pixels at the bottom of the screen that something else covers (the on-screen keyboard of a phone) while writing. */
  bottomInsetPx?: number;
  /**
   * The SWING pose: the picture also keeps room for the front board standing upright over the spine (the arc its free edge
   * sweeps as the cover opens or shuts). The camera blends towards it while the cover is in the air (see swingWeight), so
   * the board is never cut off by the top of the screen; at rest the pose is the plain one.
   */
  coverStanding?: boolean;
}

export interface CameraPose {
  position: Vec3;
  target: Vec3;
  fov: number;
}

export function isNarrow(width: number): boolean {
  return width < NARROW_BREAKPOINT_PX;
}

/** "Read closely" lets the page fill the whole free region (the page is the footprint: nothing else needs room). */
export const CLOSELY_FILL = 1;
/** And a steeper look down (the page is less foreshortened, so more of the free height is page). */
export const CLOSELY_ELEVATION_DEG = 76;
/** The camera's up-vector: the page's top-to-bottom axis (toward the far edge, -z) while writing, else the world's up. */
export function writingUp(writing: boolean): [number, number, number] {
  return writing ? [0, 0, -1] : [0, 1, 0];
}

/** Writing: the page fills this part of the free region (the writing surface needs air around it), and the camera looks almost straight down. */
export const WRITING_FILL = 0.9;
export const WRITING_ELEVATION_DEG = 80;

/**
 * How much of the bottom of the picture the stage's footer takes, on a wide screen and on a narrow one (where it stacks).
 * The footer is one row on a wide screen: the reader's bar (the page indicator, "Go to page", "Read closely", the menu) and
 * the fan-inspired disclaimer side by side, which is at most three short lines of the disclaimer at 720 px and one at 1440
 * (about 63 px at the tightest); on a narrow screen the bar stacks over the disclaimer's two lines. The reading framings keep
 * the book clear of it. A "Read closely" page keeps clear of it as well.
 */
export const STAGE_FOOTER_PX = 64;
export const STAGE_FOOTER_PX_NARROW = 84;

/**
 * The overlay regions to keep clear in a phase (global section G): the footer band under every reading framing. The diary no
 * longer has a panel beside the book (global section T: it is written on the book's own pages), so nothing else is reserved,
 * except, while writing on a phone, whatever covers the bottom of the screen (the keyboard).
 */
export function reservationFor(
  phase: Phase,
  width: number,
  height: number,
  _direction: Direction,
  extra: { writing?: boolean; bottomPx?: number } = {},
): Reserved {
  // The reading framings fill the picture with the book, which would otherwise print over the footer.
  if (framingKindFor(phase, extra.writing === true) !== 'reading') return NO_RESERVATION;
  const footer = Math.min(
    (isNarrow(width) ? STAGE_FOOTER_PX_NARROW : STAGE_FOOTER_PX) / Math.max(height, 1),
    0.4,
  );
  const covered = Math.min((extra.bottomPx ?? 0) / Math.max(height, 1), 0.7);
  return { left: 0, right: 0, bottom: Math.max(footer, covered) };
}

/** Fraction of the width kept free beside the open book, on the candle's side, so the candle stands clear of it. */
export const CANDLE_ROOM = 0.14;

/**
 * The open book is twice as wide as the closed one, and the candle stands beside it: on a wide screen the open
 * framing keeps a strip free on each side, for the candle and the inkwell, so the book is centred.
 */
function withCandleRoom(reserved: Reserved, kind: FramingKind, narrow: boolean): Reserved {
  if (kind !== 'open' || narrow) return reserved;
  // On BOTH sides (the candle on one, the inkwell on the other): the book stays horizontally centred (owner direction T.4.8).
  return { ...reserved, left: reserved.left + CANDLE_ROOM, right: reserved.right + CANDLE_ROOM };
}

/**
 * The footprint and its centre for a framing; on a narrow screen in a reading framing it is one page. In a reading
 * framing leaves turn, so the footprint also holds what a turning leaf sweeps through (the picture keeps room for it):
 * the real reach of the leaves of THIS book, from the hinge's path and the leaf's bend (leafReach.ts), which rises
 * with the thickness of the block and is carried past the vertical by a leaf that turns back.
 */
export function framingFootprint(
  kind: FramingKind,
  context: Pick<FramingContext, 'width' | 'direction' | 'leafCount' | 'focusSide' | 'closely' | 'writing'> & {
    phase?: Phase;
  },
): { footprint: Footprint; center: { x: number; z: number } } {
  const total = virtualLeafTotal(context.leafCount);
  if (kind === 'closed') return { footprint: closedFootprint(total), center: { x: 0, z: 0 } };
  const side = onePageSide(kind, context);
  if (side && readsClosely(context)) {
    // One page, and nothing else: the page itself fills the free region. A leaf that turns LEAVES the picture and comes back:
    // keeping room for it would make the page a fifth smaller, which is what reading closely is meant to avoid. This is
    // decided (ruling R5, Task 6 fix round 1: accepted, and documented in the report); it is only for "Read closely", which
    // frames the page the reader asked to see, and closing from it holds the spread framing first (see `framingChoice`).
    return {
      footprint: { width: PAGE_W + 0.01, depth: PAGE_H + 0.015, height: 0.06 },
      center: { x: ((side === 'left' ? -1 : 1) * PAGE_W) / 2, z: 0 },
    };
  }
  const outline = kind === 'reading' ? leafReachOutline(context.leafCount, total) : null;
  if (side) {
    const sign = side === 'left' ? -1 : 1;
    const middle = (sign * PAGE_W) / 2;
    return {
      footprint: {
        width: PAGE_W + 0.1,
        depth: PAGE_H + 0.16,
        height: 0.3,
        // On a phone the gutter is the edge of the page that fills the width, and the leaf's curl leans out of the picture
        // there: only its height is kept (a slab over the middle of the page, as high as the leaf reaches).
        ...(outline
          ? {
              standing: [
                { x: middle - 0.1, y: Math.max(...outline.map((point) => point.y)) },
                { x: middle + 0.1, y: Math.max(...outline.map((point) => point.y)) },
              ],
            }
          : {}),
      },
      center: { x: middle, z: 0 },
    };
  }
  const open = openFootprint();
  return { footprint: outline ? { ...open, standing: outline } : open, center: { x: 0, z: 0 } };
}

/**
 * The side of the spread shown alone on a narrow screen, or null when the whole spread is framed. Reading shows
 * the focused page; awaiting and uploading show the flyleaf (the unturned side of spread 0), because the
 * invitation on it has to be readable, whatever side an earlier reading left focused.
 */
function onePageSide(
  kind: FramingKind,
  context: Pick<FramingContext, 'width' | 'direction' | 'focusSide' | 'closely' | 'writing'> & {
    phase?: Phase;
  },
): Side | null {
  // The diary page is the unturned side of its spread (the front of its leaf).
  if (writes(context) && kind === 'reading') return unturnedSide(context.direction);
  if (readsClosely(context) && kind === 'reading') return context.focusSide ?? turnedSide(context.direction);
  if (!isNarrow(context.width)) return null;
  if (context.phase === 'awaiting' || context.phase === 'uploading') return unturnedSide(context.direction);
  if (kind === 'reading') return context.focusSide ?? turnedSide(context.direction);
  return null;
}

/** Whether the framing is the dive onto a diary page (the awaiting and manuscript phases have one to write on). */
function writes(context: { writing?: boolean; phase?: Phase }): boolean {
  return context.writing === true && (context.phase === 'awaiting' || context.phase === 'manuscript');
}

/** Whether the framing frames one page alone and close: "Read closely" (the manuscript phase only) or the writing dive. */
function readsClosely(context: { closely?: boolean; writing?: boolean; phase?: Phase }): boolean {
  return writes(context) || (context.closely === true && context.phase === 'manuscript');
}

/** How far the free edge of the front board is from the hinge: the board's width and what it stands proud of the leaves. */
export const COVER_REACH = PAGE_W + BOARD_OVERHANG;
/** Room kept beyond the arc (scene units): the board is thick, its corners lean, and the head of the picture needs air. */
const COVER_ARC_MARGIN = 0.06;

/**
 * The outline the free edge of the front board sweeps as the cover swings over the spine, end-on (x across the book, y above
 * the table): the half circle above the hinge. `spineX` is where the hinge is (a closed book's spine is off its middle).
 */
export function coverSwingOutline(spineX: number): readonly { x: number; y: number }[] {
  const points: { x: number; y: number }[] = [];
  for (let degrees = 0; degrees <= 180; degrees += 15) {
    const angle = (degrees * Math.PI) / 180;
    points.push({
      x: spineX + Math.cos(angle) * (COVER_REACH + COVER_ARC_MARGIN),
      y: BASE_Y + Math.sin(angle) * (COVER_REACH + COVER_ARC_MARGIN),
    });
  }
  return points;
}

/**
 * How much of the swing pose the camera takes while the cover is at `cover` (0 shut .. 1 open): nothing at either end, all of
 * it when the board stands upright (the middle of the swing), eased so the camera leaves and returns smoothly.
 */
export function swingWeight(cover: number): number {
  const c = Math.min(Math.max(cover, 0), 1);
  const bump = Math.sin(Math.PI * c);
  return bump * bump;
}

/** Between two poses: `weight` 0 is `from`, 1 is `to`. Writes into `out`. */
export function blendPose(from: CameraPose, to: CameraPose, weight: number, out: CameraPose): CameraPose {
  const mix = (a: number, b: number): number => a + (b - a) * weight;
  out.position.x = mix(from.position.x, to.position.x);
  out.position.y = mix(from.position.y, to.position.y);
  out.position.z = mix(from.position.z, to.position.z);
  out.target.x = mix(from.target.x, to.target.x);
  out.target.y = mix(from.target.y, to.target.y);
  out.target.z = mix(from.target.z, to.target.z);
  out.fov = mix(from.fov, to.fov);
  return out;
}

/**
 * Which phase the camera frames. While the diary CLOSES from a book that is open on turned leaves, the leaves riffle back
 * over the open pages (the closing's first step) and the cover shuts after: the camera keeps the reading framing it had
 * until the leaves are down, and only then takes the closed one. (It used to take the closed framing at once, which is a
 * closer, lower picture of a book that is still standing open: the leaf heads went 61 to 125 px past the top of the screen.)
 * "Read closely" is let go for the hold: it is the framing the leaves would leave the picture in.
 */
export function framingChoice(input: {
  phase: Phase;
  /** The reading phase (manuscript, memory...) the book was in before it began to close; null when there was none. */
  heldPhase: Phase | null;
  /** True when no leaf is turned or turning (the book is at spread 0 and still). */
  leavesDown: boolean;
  closely: boolean;
}): { phase: Phase; closely: boolean; held: boolean } {
  if (input.phase === 'closing' && input.heldPhase !== null && !input.leavesDown) {
    return { phase: input.heldPhase, closely: false, held: true };
  }
  return { phase: input.phase, closely: input.closely, held: false };
}

/** The REST camera pose of a phase: no idle drift, no pointer parallax. */
export function framingFor(context: FramingContext): CameraPose {
  const kind = framingKindFor(context.phase, context.writing === true);
  const narrow = isNarrow(context.width);
  const framedFootprint = framingFootprint(kind, context);
  const { center } = framedFootprint;
  let { footprint } = framedFootprint;
  if (context.coverStanding === true) {
    const total = virtualLeafTotal(context.leafCount);
    const spineX = kind === 'closed' ? (context.direction === 'ltr' ? -1 : 1) * closedCenterX(total) : 0;
    const arc = coverSwingOutline(spineX);
    const side = onePageSide(kind, context);
    footprint = {
      ...footprint,
      // One page on a phone: the spine is the edge of the picture, so only the height of the board is kept (a slab over the page).
      standing: [
        ...(footprint.standing ?? []),
        ...(side
          ? (() => {
              const top = Math.max(...arc.map((point) => point.y));
              return [
                { x: center.x - 0.1, y: top },
                { x: center.x + 0.1, y: top },
              ];
            })()
          : arc),
      ],
    };
  }
  // A single page on a phone is framed like a reading page: steep and full.
  const framed: FramingKind = onePageSide(kind, context) ? 'reading' : kind;
  const reserved = withCandleRoom(
    reservationFor(context.phase, context.width, context.height, context.direction, {
      writing: writes(context),
      ...(context.bottomInsetPx === undefined ? {} : { bottomPx: context.bottomInsetPx }),
    }),
    framed,
    narrow,
  );
  const closely = readsClosely(context) && framed === 'reading';
  const fill = closely
    ? writes(context)
      ? WRITING_FILL
      : CLOSELY_FILL
    : framed === 'closed'
      ? narrow
        ? 0.9
        : 0.6
      : framed === 'open'
        ? narrow
          ? 0.94
          : 0.8
        : narrow
          ? 0.96
          : 0.94;
  const elevationDeg = closely
    ? writes(context)
      ? WRITING_ELEVATION_DEG
      : CLOSELY_ELEVATION_DEG
    : (narrow ? NARROW_ELEVATION : ELEVATION)[framed];
  const aspect = context.width / Math.max(context.height, 1);
  const shiftY =
    framed === 'closed'
      ? narrow
        ? NARROW_CLOSED_SHIFT_Y
        : CLOSED_SHIFT_Y
      : framed === 'open' && !narrow
        ? OPEN_SHIFT_Y
        : 0;
  const fit = fitBookToViewport(aspect, reserved, {
    fovDeg: FOV_DEG,
    elevationDeg,
    footprint,
    fill,
    center,
    shiftY,
  });
  return {
    position: cameraPosition(fit.target, fit.distance, elevationDeg, { x: 0, y: 0, z: 0 }),
    target: fit.target,
    fov: FOV_DEG,
  };
}

/** Applies a pose to a camera (the camera's aspect is the caller's business). */
export function applyPose(camera: PerspectiveCamera, pose: CameraPose): void {
  camera.fov = pose.fov;
  camera.position.set(pose.position.x, pose.position.y, pose.position.z);
  camera.up.set(0, 1, 0);
  camera.lookAt(pose.target.x, pose.target.y, pose.target.z);
  camera.updateProjectionMatrix();
  camera.updateMatrixWorld(true);
}

/**
 * Largest camera offset (scene units) that moves the book by at most `maxPixels` on screen at
 * `distance`: pixels per unit at the target is `height / (2 d tan(fov / 2))`.
 */
export function maxMotionForPixels(
  maxPixels: number,
  distance: number,
  fovDeg: number,
  viewportHeight: number,
): number {
  const pixelsPerUnit = viewportHeight / (2 * distance * Math.tan((fovDeg * Math.PI) / 360));
  return maxPixels / Math.max(pixelsPerUnit, 1e-6);
}

/**
 * Phases in which the camera holds still for the pages: idle drift and parallax are capped to 2 px there (or off). The
 * pages are being read, or are about to be: the cover opens onto the open framing, so it is held from the start of the
 * opening (a camera that leans with the pointer there would jump when the phase changes to awaiting).
 */
export function isReadingPhase(phase: Phase): boolean {
  return (
    // the welcome book lies open and leafs behind the title: the camera holds still for it too
    phase === 'discovery' ||
    phase === 'opening' ||
    phase === 'awaiting' ||
    phase === 'uploading' ||
    phase === 'manuscript' ||
    phase === 'revealing' ||
    phase === 'memory'
  );
}

export const READING_MOTION_CAP_PX = 2;

/** Parallax and drift amplitude (scene units) for a phase; zero under reduced motion. */
export interface MotionAmplitude {
  parallax: number;
  drift: number;
}

const WANTED_PARALLAX = 0.12;
const WANTED_DRIFT = 0.035;

/** Writes into `out` when given (the camera does it every frame), so the frame loop allocates nothing. */
export function motionAmplitude(
  phase: Phase,
  reducedMotion: boolean,
  distance: number,
  fovDeg: number,
  viewportHeight: number,
  out: MotionAmplitude = { parallax: 0, drift: 0 },
): MotionAmplitude {
  if (reducedMotion) {
    out.parallax = 0;
    out.drift = 0;
  } else if (!isReadingPhase(phase)) {
    out.parallax = WANTED_PARALLAX;
    out.drift = WANTED_DRIFT;
  } else {
    const cap = maxMotionForPixels(READING_MOTION_CAP_PX, distance, fovDeg, viewportHeight);
    // Parallax and drift can add up, so each may use half of the cap.
    out.parallax = Math.min(WANTED_PARALLAX, cap / 2);
    out.drift = Math.min(WANTED_DRIFT, cap / 2);
  }
  return out;
}

/** The larger of how far the camera and how far the target differ between two poses (scene units). */
export function poseDistance(a: CameraPose, b: CameraPose): number {
  return Math.max(
    Math.hypot(a.position.x - b.position.x, a.position.y - b.position.y, a.position.z - b.position.z),
    Math.hypot(a.target.x - b.target.x, a.target.y - b.target.y, a.target.z - b.target.z),
  );
}

const anchorCamera = new PerspectiveCamera(38, 1, 0.05, 60);
const anchorCorner = new Vector3();

function projectRect(
  camera: PerspectiveCamera,
  corners: readonly (readonly [number, number, number])[],
  width: number,
  height: number,
): ScreenRect {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [x, y, z] of corners) {
    anchorCorner.set(x, y, z).project(camera);
    const sx = ((anchorCorner.x + 1) / 2) * width;
    const sy = ((1 - anchorCorner.y) / 2) * height;
    minX = Math.min(minX, sx);
    maxX = Math.max(maxX, sx);
    minY = Math.min(minY, sy);
    maxY = Math.max(maxY, sy);
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

function projectQuad(
  camera: PerspectiveCamera,
  xFrom: number,
  xTo: number,
  y: number,
  halfDepth: number,
  width: number,
  height: number,
): ScreenQuad {
  const at = (x: number, z: number): { x: number; y: number } => {
    anchorCorner.set(x, y, z).project(camera);
    return { x: ((anchorCorner.x + 1) / 2) * width, y: ((1 - anchorCorner.y) / 2) * height };
  };
  // Seen from the front of the table: the far edge of the page is its top.
  return [at(xFrom, -halfDepth), at(xTo, -halfDepth), at(xTo, halfDepth), at(xFrom, halfDepth)];
}

export interface RestPose {
  open: boolean;
  spread: number;
  direction: Direction;
  leafCount: number;
}

/**
 * Screen rectangles (CSS px) of the book, the flyleaf and the two visible pages, seen from the REST camera
 * pose, with the book at rest in `pose`. They never include drift or parallax. `quads` are the same two pages as four corners
 * (top left, top right, bottom right, bottom left, as seen on the screen): what the writing surface is mapped onto.
 */
export function computeAnchors(
  camera: CameraPose,
  viewport: { width: number; height: number },
  pose: RestPose,
): {
  book: ScreenRect;
  flyleaf: ScreenRect | null;
  leftPage: ScreenRect | null;
  rightPage: ScreenRect | null;
  quads: { leftPage: ScreenQuad | null; rightPage: ScreenQuad | null };
} {
  anchorCamera.aspect = viewport.width / Math.max(viewport.height, 1);
  applyPose(anchorCamera, camera);
  const total = virtualLeafTotal(pose.leafCount);
  const halfH = PAGE_H / 2;
  const footprint = pose.open ? openFootprint() : closedFootprint(total);
  const top = pose.open ? 0.3 : footprint.height;
  const book = projectRect(
    anchorCamera,
    [-1, 1].flatMap((sx) =>
      [-1, 1].flatMap((sz) =>
        [0, top].map((y) => [sx * (footprint.width / 2), y, sz * (footprint.depth / 2)] as const),
      ),
    ),
    viewport.width,
    viewport.height,
  );
  if (!pose.open) {
    return {
      book,
      flyleaf: null,
      leftPage: null,
      rightPage: null,
      quads: { leftPage: null, rightPage: null },
    };
  }

  const page = (xFrom: number, xTo: number, y: number): ScreenRect =>
    projectRect(
      anchorCamera,
      [
        [xFrom, y, -halfH],
        [xTo, y, -halfH],
        [xFrom, y, halfH],
        [xTo, y, halfH],
      ],
      viewport.width,
      viewport.height,
    );
  const turnedY = BASE_Y + pose.spread * LEAF_T;
  const unturnedY = BASE_Y + (total - pose.spread) * LEAF_T;
  const ltr = pose.direction === 'ltr';
  const left = page(-PAGE_W, 0, ltr ? turnedY : unturnedY);
  const right = page(0, PAGE_W, ltr ? unturnedY : turnedY);
  const unturnedRect = ltr ? right : left;
  const quads = {
    leftPage: projectQuad(
      anchorCamera,
      -PAGE_W,
      0,
      ltr ? turnedY : unturnedY,
      halfH,
      viewport.width,
      viewport.height,
    ),
    rightPage: projectQuad(
      anchorCamera,
      0,
      PAGE_W,
      ltr ? unturnedY : turnedY,
      halfH,
      viewport.width,
      viewport.height,
    ),
  };
  return {
    book,
    flyleaf: pose.spread === 0 ? unturnedRect : null,
    leftPage: left,
    rightPage: right,
    quads,
  };
}
