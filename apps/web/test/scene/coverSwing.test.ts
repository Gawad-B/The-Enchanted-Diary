import { PerspectiveCamera, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import { BookMotion } from '../../src/scene/book/bookMotion';
import {
  BOARD_OVERHANG,
  PAGE_H,
  PAGE_W,
  closedCenterX,
  turnedLeafY,
  unturnedLeafY,
  virtualLeafTotal,
} from '../../src/scene/book/dimensions';
import { hingeOffset, leafPoint } from '../../src/scene/book/leafReach';
import { PhaseRunner, type PresenterEnv } from '../../src/scene/book/phaseRunner';
import {
  COVER_REACH,
  applyPose,
  blendPose,
  coverSwingOutline,
  framingChoice,
  framingFor,
  swingWeight,
  type CameraPose,
  type FramingContext,
} from '../../src/scene/cameraFraming';
import { damp } from '../../src/scene/easing';
import type { Phase } from '../../src/state/experience';

/*
 * Reviewer R3 (closing headroom) and shot 61 (the cover clipped on a reopen): the camera keeps the reading framing while the
 * leaves of a closing book riffle back, waits for them to be down, and takes room for the front board standing upright
 * while the cover is in the air. The simulations below run the REAL book motion and phase script against the camera's
 * own rules (the same damping as CameraRig) and project what is actually in the air, frame by frame.
 */

const DT = 1 / 60;
const SETTLE_LAMBDA = 4.6 / 1.1; // CameraRig: 4.6 / (cameraSettle seconds)

function poseOf(context: FramingContext): CameraPose {
  return framingFor(context);
}

/** Projects world points with a camera at `position` looking at `target`. */
function projector(width: number, height: number, position: Vector3, target: Vector3) {
  const camera = new PerspectiveCamera(38, width / height, 0.05, 60);
  applyPose(camera, {
    fov: 38,
    position: { x: position.x, y: position.y, z: position.z },
    target: { x: target.x, y: target.y, z: target.z },
  });
  const v = new Vector3();
  return (point: Vector3): { x: number; y: number } => {
    v.copy(point).project(camera);
    return { x: v.x, y: v.y };
  };
}

describe('the swing pose', () => {
  const context = (
    phase: Phase,
    width: number,
    height: number,
    direction: 'ltr' | 'rtl' = 'ltr',
  ): FramingContext => ({
    phase,
    width,
    height,
    direction,
    leafCount: 20,
    focusSide: null,
  });

  it('keeps the whole arc of the front board in the picture, wide screens, both directions, open and closed framings', () => {
    for (const [width, height] of [
      [1440, 900],
      [1920, 1080],
      [1024, 768],
      [1280, 720],
      [768, 1024],
    ] as const) {
      for (const direction of ['ltr', 'rtl'] as const) {
        for (const phase of [
          'discovery',
          'opening',
          'awaiting',
          'uploading',
          'reading',
          'closing',
        ] as const) {
          const kind =
            phase === 'discovery' || phase === 'reading' || phase === 'closing' ? 'closed' : 'open';
          const spineX =
            kind === 'closed' ? (direction === 'ltr' ? -1 : 1) * closedCenterX(virtualLeafTotal(20)) : 0;
          const swing = poseOf({ ...context(phase, width, height, direction), coverStanding: true });
          const project = projector(
            width,
            height,
            new Vector3(swing.position.x, swing.position.y, swing.position.z),
            new Vector3(swing.target.x, swing.target.y, swing.target.z),
          );
          for (const point of coverSwingOutline(spineX)) {
            for (const z of [-PAGE_H / 2 - BOARD_OVERHANG, PAGE_H / 2 + BOARD_OVERHANG]) {
              const at = project(new Vector3(point.x, point.y, z));
              const label = `${String(width)}x${String(height)} ${direction} ${phase} (${point.x.toFixed(2)}, ${point.y.toFixed(2)})`;
              expect(at.y, label).toBeLessThanOrEqual(1);
              expect(at.y, label).toBeGreaterThanOrEqual(-1);
              expect(at.x, label).toBeLessThanOrEqual(1);
              expect(at.x, label).toBeGreaterThanOrEqual(-1);
            }
          }
        }
      }
    }
  });

  it('is what the plain pose lacks: at 1440 x 900 the board standing upright over an open book goes past the top of the screen (shot 61)', () => {
    const plain = poseOf(context('awaiting', 1440, 900));
    const project = projector(
      1440,
      900,
      new Vector3(plain.position.x, plain.position.y, plain.position.z),
      new Vector3(plain.target.x, plain.target.y, plain.target.z),
    );
    const top = project(new Vector3(0, COVER_REACH, -PAGE_H / 2)); // the far head of the board: the highest on screen
    const swung = poseOf({ ...context('awaiting', 1440, 900), coverStanding: true });
    const projectSwung = projector(
      1440,
      900,
      new Vector3(swung.position.x, swung.position.y, swung.position.z),
      new Vector3(swung.target.x, swung.target.y, swung.target.z),
    );
    // (the book is centred with room on both sides now, so the plain pose is smaller than it was: the board comes close to the
    // top, or past it; the swing pose is what keeps it clear)
    expect(top.y).toBeGreaterThan(projectSwung(new Vector3(0, COVER_REACH, -PAGE_H / 2)).y);
  });

  it("a phone keeps only the board's height over the one page it shows (the spine is the edge of the picture)", () => {
    const swing = poseOf({ ...context('awaiting', 390, 844), coverStanding: true });
    const plain = poseOf(context('awaiting', 390, 844));
    // further back than the plain pose (the board is taller than the page), but not by the width of a whole book
    const dPlain = Math.hypot(
      plain.position.x - plain.target.x,
      plain.position.y - plain.target.y,
      plain.position.z - plain.target.z,
    );
    const dSwing = Math.hypot(
      swing.position.x - swing.target.x,
      swing.position.y - swing.target.y,
      swing.position.z - swing.target.z,
    );
    expect(dSwing).toBeGreaterThan(dPlain);
    expect(dSwing / dPlain).toBeLessThan(2);
  });

  it('the plain pose is untouched by the option being absent (the rest of the framing rules keep their numbers)', () => {
    const a = poseOf(context('manuscript', 1440, 900));
    const b = poseOf({ ...context('manuscript', 1440, 900), coverStanding: false });
    expect(b).toEqual(a);
  });
});

describe('swingWeight and blendPose', () => {
  it('is nothing with the cover shut or open, everything with the board upright, and symmetric', () => {
    expect(swingWeight(0)).toBe(0);
    expect(swingWeight(1)).toBeCloseTo(0, 12);
    expect(swingWeight(0.5)).toBe(1);
    expect(swingWeight(0.25)).toBeCloseTo(swingWeight(0.75), 12);
    expect(swingWeight(-3)).toBe(0);
    expect(swingWeight(7)).toBeCloseTo(0, 12);
    let last = 0;
    for (let c = 0; c <= 0.5; c += 0.05) {
      expect(swingWeight(c)).toBeGreaterThanOrEqual(last);
      last = swingWeight(c);
    }
  });

  it('blends two poses', () => {
    const a: CameraPose = { position: { x: 0, y: 0, z: 0 }, target: { x: 0, y: 0, z: 0 }, fov: 30 };
    const b: CameraPose = { position: { x: 10, y: 20, z: 30 }, target: { x: 2, y: 4, z: 6 }, fov: 50 };
    const out: CameraPose = { position: { x: 0, y: 0, z: 0 }, target: { x: 0, y: 0, z: 0 }, fov: 0 };
    expect(blendPose(a, b, 0, out)).toEqual(a);
    expect(blendPose(a, b, 1, out)).toEqual(b);
    expect(blendPose(a, b, 0.5, out)).toEqual({
      position: { x: 5, y: 10, z: 15 },
      target: { x: 1, y: 2, z: 3 },
      fov: 40,
    });
  });
});

describe('framingChoice: what the camera frames while the book closes', () => {
  it('holds the reading framing (without "Read closely") until the leaves are down, then takes the closed one', () => {
    expect(
      framingChoice({ phase: 'closing', heldPhase: 'manuscript', leavesDown: false, closely: true }),
    ).toEqual({
      phase: 'manuscript',
      closely: false,
      held: true,
    });
    expect(
      framingChoice({ phase: 'closing', heldPhase: 'manuscript', leavesDown: true, closely: true }),
    ).toEqual({
      phase: 'closing',
      closely: true,
      held: false,
    });
  });

  it('holds nothing when there was no reading framing to hold (a book closed from the flyleaf), and no other phase is changed', () => {
    expect(framingChoice({ phase: 'closing', heldPhase: null, leavesDown: false, closely: false }).held).toBe(
      false,
    );
    for (const phase of [
      'discovery',
      'opening',
      'awaiting',
      'uploading',
      'reading',
      'unveiling',
      'manuscript',
      'revealing',
      'memory',
    ] as const) {
      expect(
        framingChoice({ phase, heldPhase: 'manuscript', leavesDown: false, closely: false }),
      ).toMatchObject({
        phase,
        held: false,
      });
    }
  });
});

describe('closing: the leaves that riffle back stay in the picture (back-riffle under the camera glide)', () => {
  /** Edge points of the leaves that are in the air right now. */
  function airborneEdge(motion: BookMotion, leafCount: number): Vector3[] {
    const total = virtualLeafTotal(leafCount);
    const points: Vector3[] = [];
    const hinge = { x: 0, y: 0 };
    const tip = { x: 0, y: 0 };
    for (let leaf = 0; leaf < leafCount; leaf += 1) {
      const theta = motion.thetas[leaf] ?? 0;
      const sign = motion.turnSigns[leaf] ?? 0;
      if (sign === 0 || theta <= 0.001 || theta >= 0.999) continue;
      hingeOffset(unturnedLeafY(leaf, total), turnedLeafY(leaf), theta, 1, hinge);
      for (const z of [-PAGE_H / 2, 0, PAGE_H / 2]) {
        leafPoint(PAGE_W, z, theta, sign, tip);
        points.push(new Vector3(hinge.x + tip.x, hinge.y + tip.y, z));
        points.push(new Vector3(-(hinge.x + tip.x), hinge.y + tip.y, z));
      }
    }
    return points;
  }

  /**
   * Closes a 40-page book that was being read closely at spread 10, frame by frame: the camera damps towards what
   * `framingChoice` says (or, with `held` false, towards the closed framing at once, the way it used to), the phase script
   * runs against the real BookMotion, and the highest point of any leaf in the air is projected every frame.
   */
  function closeFromClosely(held: boolean): { highest: number; frames: number } {
    const width = 1440;
    const height = 900;
    const leafCount = 20;
    const motion = new BookMotion({ leafCount, reducedMotion: false, maxAirborne: 4 });
    motion.snap({ open: true, spread: 10 });
    const base = { width, height, direction: 'ltr' as const, leafCount, focusSide: 'left' as const };
    const start = poseOf({ ...base, phase: 'manuscript', closely: true });
    const position = new Vector3(start.position.x, start.position.y, start.position.z);
    const target = new Vector3(start.target.x, start.target.y, start.target.z);
    const wanted = (): CameraPose => {
      const choice = held
        ? framingChoice({
            phase: 'closing',
            heldPhase: 'manuscript',
            leavesDown: !motion.turning && motion.spreadTarget === 0,
            closely: true,
          })
        : { phase: 'closing' as Phase, closely: true };
      return poseOf({ ...base, phase: choice.phase, closely: choice.closely });
    };
    const settled = (): boolean => {
      const rest = wanted();
      return (
        position.distanceTo(new Vector3(rest.position.x, rest.position.y, rest.position.z)) < 0.006 &&
        target.distanceTo(new Vector3(rest.target.x, rest.target.y, rest.target.z)) < 0.006
      );
    };
    const env: PresenterEnv = {
      motion,
      layoutDirection: () => 'ltr',
      setLayoutDirection: () => undefined,
      desiredDirection: () => 'ltr',
      readerSpread: () => 10,
      pageTexturesReady: () => true,
      ...(held ? { cameraSettled: settled } : {}),
      emit: () => undefined,
    };
    const runner = new PhaseRunner('closing', 1, env);
    let highest = -Infinity;
    let frames = 0;
    for (let i = 0; i < 60 * 8 && !runner.finished; i += 1) {
      const rest = wanted();
      position.set(
        damp(position.x, rest.position.x, SETTLE_LAMBDA, DT),
        damp(position.y, rest.position.y, SETTLE_LAMBDA, DT),
        damp(position.z, rest.position.z, SETTLE_LAMBDA, DT),
      );
      target.set(
        damp(target.x, rest.target.x, SETTLE_LAMBDA, DT),
        damp(target.y, rest.target.y, SETTLE_LAMBDA, DT),
        damp(target.z, rest.target.z, SETTLE_LAMBDA, DT),
      );
      runner.tick();
      motion.update(DT);
      const project = projector(width, height, position, target);
      for (const point of airborneEdge(motion, leafCount)) highest = Math.max(highest, project(point).y);
      frames += 1;
    }
    expect(runner.finished).toBe(true);
    return { highest, frames };
  }

  it('with the camera holding the reading framing, no leaf goes past the top of the picture', () => {
    const { highest } = closeFromClosely(true);
    expect(highest).toBeLessThan(1);
    expect(highest).toBeGreaterThan(-Infinity); // leaves WERE in the air: the test looked at something
  });

  it('and the old behaviour (the closed framing at once, no waiting) put them out of it: the test sees the defect it is for', () => {
    const { highest } = closeFromClosely(false);
    expect(highest).toBeGreaterThan(1);
  });
});

describe('opening: the cover never leaves the picture, from a closed book and from a reopen', () => {
  function openFrom(kind: 'discovery' | 'reading', swing: boolean): { highest: number; frames: number } {
    const width = 1440;
    const height = 900;
    const leafCount = 20;
    const motion = new BookMotion({ leafCount, reducedMotion: false, maxAirborne: 4 });
    const base = { width, height, direction: 'ltr' as const, leafCount, focusSide: null };
    const start = poseOf({ ...base, phase: kind });
    const position = new Vector3(start.position.x, start.position.y, start.position.z);
    const target = new Vector3(start.target.x, start.target.y, start.target.z);
    const rest = poseOf({ ...base, phase: 'awaiting' });
    const swung = poseOf({ ...base, phase: 'awaiting', coverStanding: true });
    const blended: CameraPose = { position: { x: 0, y: 0, z: 0 }, target: { x: 0, y: 0, z: 0 }, fov: 38 };
    motion.setCoverOpen(true);
    let highest = -Infinity;
    let frames = 0;
    const arcZ = [-PAGE_H / 2 - BOARD_OVERHANG, PAGE_H / 2 + BOARD_OVERHANG];
    for (let i = 0; i < 60 * 3; i += 1) {
      motion.update(DT);
      const wanted = swing ? blendPose(rest, swung, swingWeight(motion.cover.value), blended) : rest;
      position.set(
        damp(position.x, wanted.position.x, SETTLE_LAMBDA, DT),
        damp(position.y, wanted.position.y, SETTLE_LAMBDA, DT),
        damp(position.z, wanted.position.z, SETTLE_LAMBDA, DT),
      );
      target.set(
        damp(target.x, wanted.target.x, SETTLE_LAMBDA, DT),
        damp(target.y, wanted.target.y, SETTLE_LAMBDA, DT),
        damp(target.z, wanted.target.z, SETTLE_LAMBDA, DT),
      );
      // the free edge of the board: it starts shut on the right (angle 0) and ends flat on the left (angle pi)
      const angle = Math.PI * motion.cover.value;
      const project = projector(width, height, position, target);
      for (const z of arcZ) {
        const at = project(
          new Vector3(Math.cos(angle) * COVER_REACH, 0.04 + Math.sin(angle) * COVER_REACH, z),
        );
        highest = Math.max(highest, at.y);
      }
      frames += 1;
    }
    return { highest, frames };
  }

  it.each(['discovery', 'reading'] as const)(
    'from the %s framing (the first opening, and the reopen after a failed reading)',
    (kind) => {
      expect(openFrom(kind, true).highest).toBeLessThan(1);
    },
  );

  it('without the swing pose the board is cut off by the top of the screen (shot 61)', () => {
    expect(openFrom('reading', false).highest).toBeGreaterThan(openFrom('reading', true).highest);
  });
});
