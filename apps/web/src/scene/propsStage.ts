import { PerspectiveCamera, Vector3 } from 'three';
import type { Direction } from '@enchanted/shared';
import type { Phase } from '../state/experience';
import {
  framingFor,
  framingKindFor,
  motionAmplitude,
  type CameraPose,
  type MotionAmplitude,
} from './cameraFraming';
import { initialPoseFor } from './book/phaseRunner';
import { CandleMotion, INKWELL_RADIUS, candleBaseFor, inkwellBaseFor, type Vec3Like } from './candleLayout';
import {
  CANDLE_HEIGHT,
  DISH_HEIGHT,
  DISH_RADIUS,
  FLAME_BASE_Y,
  FLAME_SIZE,
  INKWELL_HEIGHT,
  QUILL_TIP,
} from './sceneConstants';

/*
 * Whether the props on the table (the candle and the inkwell) are on the stage or off it. A prop at the edge of the
 * picture is wholly in the frame or wholly out of it; a flame tip or a dish cut by the border is worse than no prop.
 * Instead of a rule of thumb about screen shapes, this asks the camera: the props' extreme points (the dish's rim, the
 * top of the wax, the flame's tip, the inkwell's foot and the tip of its quill) are projected through the pose of the
 * phase, and the props are on the stage only if every one of them is inside the picture, with a margin.
 */

/**
 * Pixels the props keep from the edge of the picture, over and above what the camera's own motion can take: the camera
 * drifts and leans with the pointer (`CameraRig`), by as much as `motionAmplitude` says for the phase, so the props are
 * tested from where the camera can be at the extremes of that, not only from where it rests.
 */
export const STAGE_MARGIN_PX = 4;
/** Leaves of a middling book (the framing of an open book hardly depends on it). */
const SAMPLE_LEAF_COUNT = 21;

/** The extreme points of the candle (its foot at `base`). */
export function candlePoints(base: Vec3Like): readonly (readonly [number, number, number])[] {
  return [
    [base.x - DISH_RADIUS, DISH_HEIGHT, base.z],
    [base.x + DISH_RADIUS, DISH_HEIGHT, base.z],
    [base.x, 0, base.z],
    [base.x, DISH_HEIGHT + CANDLE_HEIGHT, base.z],
    [base.x, FLAME_BASE_Y + FLAME_SIZE.height, base.z],
  ];
}

/** The extreme points of the inkwell and the tip of its quill, which leans away from the candle (`sign` is the layout's side). */
export function inkwellPoints(base: Vec3Like, sign: number): readonly (readonly [number, number, number])[] {
  return [
    [base.x - INKWELL_RADIUS, 0, base.z],
    [base.x + INKWELL_RADIUS, 0, base.z],
    [base.x, INKWELL_HEIGHT, base.z],
    [base.x + sign * QUILL_TIP.out, QUILL_TIP.height, base.z],
  ];
}

const projector = new Vector3();
const scratchCamera = new PerspectiveCamera(38, 1, 0.05, 60);
const scratchAmplitude: MotionAmplitude = { parallax: 0, drift: 0 };

/** Whether every point is inside a `width` x `height` picture, `margin` pixels from its edge, as seen by `camera`. */
function allInside(
  camera: PerspectiveCamera,
  points: readonly (readonly [number, number, number])[],
  width: number,
  height: number,
  margin: number,
): boolean {
  return points.every(([x, y, z]) => {
    projector.set(x, y, z).project(camera);
    const px = ((projector.x + 1) / 2) * width;
    const py = ((1 - projector.y) / 2) * height;
    return px > margin && px < width - margin && py > margin && py < height - margin;
  });
}

/** How open the book is in a framing: the openness the props are laid out for (the cover is up, or it is down). */
function opennessOf(phase: Phase): number {
  return framingKindFor(phase) === 'open' ? 1 : 0;
}

/**
 * How far the camera can be from its rest pose in a phase, along the world's x and y: the parallax and the drift added
 * up (`CameraRig` moves it by `pointer.x * parallax + driftX` along x and half of that along y; the pointer is at most 1
 * either way and the drift at most `drift`). The same amplitudes the rig uses, at the same distance and height.
 */
export function cameraReach(
  phase: Phase,
  pose: CameraPose,
  height: number,
  out: { x: number; y: number } = { x: 0, y: 0 },
): { x: number; y: number } {
  const distance = Math.hypot(
    pose.position.x - pose.target.x,
    pose.position.y - pose.target.y,
    pose.position.z - pose.target.z,
  );
  const { parallax, drift } = motionAmplitude(phase, false, distance, pose.fov, height, scratchAmplitude);
  out.x = parallax + drift;
  out.y = parallax * 0.5 + drift * 0.6;
  return out;
}

/** The camera as the rig would place it, `dx` and `dy` away from its rest pose, looking at the same point. */
function cameraAt(pose: CameraPose, aspect: number, dx: number, dy: number): PerspectiveCamera {
  const camera = scratchCamera;
  camera.fov = pose.fov;
  camera.aspect = aspect;
  camera.position.set(pose.position.x + dx, pose.position.y + dy, pose.position.z);
  camera.up.set(0, 1, 0);
  camera.lookAt(pose.target.x, pose.target.y, pose.target.z);
  camera.updateProjectionMatrix();
  camera.updateMatrixWorld(true);
  return camera;
}

const CORNERS = [
  [0, 0],
  [1, 1],
  [1, -1],
  [-1, 1],
  [-1, -1],
] as const;
const reach = { x: 0, y: 0 };

/**
 * Whether both props, standing where the layout puts them for the phase, are wholly inside the picture of a `width` x
 * `height` screen, from the camera's rest pose and from the four corners of everywhere the camera can be (its parallax
 * and drift). Both directions are asked (the framing keeps room on the candle's side), so the answer does not change
 * when the layout turns over.
 */
export function propsFit(phase: Phase, width: number, height: number): boolean {
  const openness = opennessOf(phase);
  const aspect = width / Math.max(height, 1);
  for (const direction of ['ltr', 'rtl'] as const satisfies readonly Direction[]) {
    const pose = framingFor({
      phase,
      width,
      height,
      direction,
      leafCount: SAMPLE_LEAF_COUNT,
      focusSide: null,
    });
    const sign = direction === 'ltr' ? 1 : -1;
    const candle = candlePoints(candleBaseFor(aspect, direction, openness, 0));
    const ink = inkwellPoints(inkwellBaseFor(aspect, direction, openness, 0), sign);
    cameraReach(phase, pose, height, reach);
    for (const [cx, cy] of CORNERS) {
      const camera = cameraAt(pose, aspect, cx * reach.x, cy * reach.y);
      if (!allInside(camera, candle, width, height, STAGE_MARGIN_PX)) return false;
      if (!allInside(camera, ink, width, height, STAGE_MARGIN_PX)) return false;
    }
  }
  return true;
}

let lastPhase: Phase | null = null;
let lastWidth = 0;
let lastHeight = 0;
let lastAnswer = false;

/**
 * Whether the props are off the stage in a phase on a screen: in the reading framings (the camera is over the pages),
 * and wherever the framing leaves them no room (the open book on a squarish or a phone screen, a narrow window that
 * crops the flame). Asked every frame, answered from a one-entry memo: the projection runs only when the phase or the
 * screen changes.
 */
export function propsOffstage(phase: Phase, width: number, height: number): boolean {
  if (phase === lastPhase && width === lastWidth && height === lastHeight) return lastAnswer;
  const answer = framingKindFor(phase) === 'reading' || !propsFit(phase, width, height);
  lastPhase = phase;
  lastWidth = width;
  lastHeight = height;
  lastAnswer = answer;
  return answer;
}

/**
 * The props for a scene that mounts in `phase`: standing where `direction` (the layout the presenter will lay the book
 * out in) puts them for the phase's pose of the cover, and already off the stage where the phase has no room for
 * them. A mount is not a change, so nothing animates on the first frames: an RTL diary, a remount of the scene (a new
 * quality tier, "try the immersive view again") and a mount straight into the reading framing all start at rest.
 */
export function mountCandleMotion(
  phase: Phase,
  spread: number,
  width: number,
  height: number,
  direction: Direction,
): CandleMotion {
  return new CandleMotion(
    width / Math.max(height, 1),
    direction,
    initialPoseFor(phase, spread).open ? 1 : 0,
    propsOffstage(phase, width, height),
  );
}
