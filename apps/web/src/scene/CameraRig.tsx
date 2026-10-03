import { useFrame, useThree } from '@react-three/fiber';
import { useEffect, useRef } from 'react';
import { Vector3, type PerspectiveCamera } from 'three';
import { duration } from '../motion/durations';
import { anchorStore } from '../state/anchorStore';
import { diaryBookStore, sceneBookOf } from '../state/diaryBook';
import { experienceStore } from '../state/experience';
import { readerStore } from '../state/readerStore';
import { viewportInsetStore } from '../state/viewportInset';
import { leafCount as leafCountFor } from '../book/bookLayout';
import { damp } from './easing';
import { revealZoom, zoomedFov } from './revealZoom';
import { pointerState } from './input';
import { devCamera } from './dev/devHooks';
import {
  applyPose,
  blendPose,
  computeAnchors,
  framingChoice,
  framingFor,
  framingKindFor,
  motionAmplitude,
  poseDistance,
  swingWeight,
  writingUp,
  type CameraPose,
  type MotionAmplitude,
} from './cameraFraming';
import type { BookMotion } from './book/bookMotion';
import type { Phase } from '../state/experience';

/*
 * The camera. Each phase has a REST pose (cameraFraming.ts); the camera glides to it with damping, and on top
 * of it comes a subtle idle drift and the pointer's parallax, both capped to 2 px of page motion in the
 * reading phases and removed under reduced motion. The anchors (screen rectangles of the book and its
 * pages) are computed from the rest pose only, so overlays never wobble; `stable` tells them when the
 * camera has arrived.
 *
 * Two things of the book's own motion shape the pose (reviewer R3, closing headroom):
 *  - while the diary closes from a book that is open on turned leaves, the camera keeps the reading framing until the leaves
 *    are down (`framingChoice`), instead of taking the closer, lower closed framing while leaves still riffle over the pages;
 *  - while the front board is in the air the camera takes some of a SWING pose that keeps room for the board standing upright
 *    (`swingWeight`), so the board is never cut off by the top of the screen (it was, on every open and on a reopen).
 */

const SETTLE_EPSILON = 0.006;
/** A rest pose that moved less than this (scene units) is the same pose: the camera is not going anywhere. */
const POSE_EPSILON = 1e-4;

/** The phases whose framing the camera holds while the leaves of a closing book riffle back. */
const READING_PHASES: readonly Phase[] = ['unveiling', 'manuscript', 'revealing', 'memory'];

export function CameraRig({
  reducedMotion,
  motion,
}: {
  reducedMotion: boolean;
  /** The book's motion: where its cover is, and whether leaves are still turned or turning. */
  motion: Pick<BookMotion, 'cover' | 'turning' | 'spreadTarget'>;
}) {
  const camera = useThree((state) => state.camera) as PerspectiveCamera;
  const width = useThree((state) => state.size.width);
  const height = useThree((state) => state.size.height);
  const rest = useRef<CameraPose | null>(null);
  const swing = useRef<CameraPose | null>(null);
  const blended = useRef<CameraPose>({
    position: { x: 0, y: 0, z: 0 },
    target: { x: 0, y: 0, z: 0 },
    fov: 38,
  });
  const heldPhase = useRef<Phase | null>(null);
  const holding = useRef(false);
  const recomputeRef = useRef<(() => void) | null>(null);
  const position = useRef(new Vector3());
  const target = useRef(new Vector3());
  const restPosition = useRef(new Vector3());
  const restTarget = useRef(new Vector3());
  const swingPosition = useRef(new Vector3());
  const swingTarget = useRef(new Vector3());
  const initialised = useRef(false);
  const smoothPointer = useRef({ x: 0, y: 0 });
  const stableRef = useRef(false);
  const amplitude = useRef<MotionAmplitude>({ parallax: 0, drift: 0 });

  // The rest pose (and the anchors) are recomputed when what they depend on changes, never per frame.
  useEffect(() => {
    const recompute = (): void => {
      const experience = experienceStore.getState();
      const reader = readerStore.getState();
      const diary = diaryBookStore.getState();
      // The diary's own pages are bound before the flyleaf; while the reader writes, the book is turned to one of them.
      const book = sceneBookOf(diary, reader.spread);
      if (READING_PHASES.includes(experience.phase)) heldPhase.current = experience.phase;
      else if (experience.phase !== 'closing') heldPhase.current = null;
      // The leaves are down when none is turned or turning; a closing book that still has some keeps its reading framing.
      const choice = framingChoice({
        phase: experience.phase,
        heldPhase: heldPhase.current,
        leavesDown: !motion.turning && motion.spreadTarget === 0,
        closely: reader.closely,
      });
      holding.current = choice.held;
      // Stepping back from the page after the upload shows the whole book (the open framing), never the PDF's pages.
      const framePhase =
        choice.phase === 'manuscript' && !diary.writing && !diary.pdfVisible ? 'awaiting' : choice.phase;
      const kind = framingKindFor(framePhase);
      const leaves = leafCountFor(reader.pageCount, diary.leaves);
      const layoutDirection = anchorStore.getState().layoutDirection;
      const context = {
        phase: framePhase,
        width,
        height,
        direction: layoutDirection,
        leafCount: leaves,
        focusSide: reader.focusSide,
        closely: choice.closely,
        writing: diary.writing,
        bottomInsetPx: viewportInsetStore.getState().bottomPx,
      };
      const pose = framingFor(context);
      swing.current = framingFor({ ...context, coverStanding: true });
      const previous = rest.current;
      rest.current = pose;
      restPosition.current.set(pose.position.x, pose.position.y, pose.position.z);
      restTarget.current.set(pose.target.x, pose.target.y, pose.target.z);
      if (!initialised.current) {
        position.current.copy(restPosition.current);
        target.current.copy(restTarget.current);
        initialised.current = true;
      }
      const anchors = computeAnchors(
        pose,
        { width, height },
        {
          open: kind !== 'closed',
          spread: kind === 'reading' ? (diary.writing || diary.leaves > 0 ? book.spread : reader.spread) : 0,
          direction: layoutDirection,
          leafCount: leaves,
        },
      );
      const { quads, ...rects } = anchors;
      anchorStore.getState().setRects(rects);
      anchorStore.getState().setQuads(quads);
      // The overlays fade only when the camera is really going somewhere: a turn of the page moves the anchors a
      // little but not the camera, and must not make them blink.
      if (previous === null || poseDistance(previous, pose) > POSE_EPSILON) {
        stableRef.current = false;
        anchorStore.getState().setStable(false);
      }
    };

    recomputeRef.current = recompute;
    recompute();
    const stopExperience = experienceStore.subscribe((state, previous) => {
      if (state.phase !== previous.phase) recompute();
    });
    const stopReader = readerStore.subscribe((state, previous) => {
      if (
        state.focusSide !== previous.focusSide ||
        state.closely !== previous.closely ||
        state.spread !== previous.spread ||
        state.direction !== previous.direction ||
        state.pageCount !== previous.pageCount
      ) {
        recompute();
      }
    });
    const stopLayout = anchorStore.subscribe((state, previous) => {
      if (state.layoutDirection !== previous.layoutDirection) recompute();
    });
    const stopDiary = diaryBookStore.subscribe((state, previous) => {
      if (
        state.writing !== previous.writing ||
        state.pdfVisible !== previous.pdfVisible ||
        state.page !== previous.page ||
        state.leaves !== previous.leaves
      ) {
        recompute();
      }
    });
    const stopInset = viewportInsetStore.subscribe((state, previous) => {
      if (state.bottomPx !== previous.bottomPx && diaryBookStore.getState().writing) recompute();
    });
    return () => {
      recomputeRef.current = null;
      stopExperience();
      stopReader();
      stopLayout();
      stopDiary();
      stopInset();
    };
  }, [width, height, motion]);

  useEffect(
    () => () => {
      anchorStore.getState().reset();
    },
    [],
  );

  useFrame((state, delta) => {
    const pose = rest.current;
    if (!pose) return;
    const camera = state.camera as PerspectiveCamera;
    if (import.meta.env.DEV && devCamera.enabled) {
      camera.position.set(...devCamera.position);
      camera.lookAt(...devCamera.target);
      camera.updateProjectionMatrix();
      anchorStore.getState().setStable(true);
      return;
    }
    // The leaves of a closing book are down: the camera takes the closed framing now (it was holding the reading one).
    if (holding.current && !motion.turning && motion.spreadTarget === 0) recomputeRef.current?.();
    // While the front board is in the air the camera takes some of the swing pose (none under reduced motion: no extra move).
    const weight = reducedMotion ? 0 : swingWeight(motion.cover.value);
    let wantedPosition = restPosition.current;
    let wantedTarget = restTarget.current;
    if (weight > 1e-3 && swing.current) {
      blendPose(pose, swing.current, weight, blended.current);
      wantedPosition = swingPosition.current.set(
        blended.current.position.x,
        blended.current.position.y,
        blended.current.position.z,
      );
      wantedTarget = swingTarget.current.set(
        blended.current.target.x,
        blended.current.target.y,
        blended.current.target.z,
      );
    }
    const lambda = 4.6 / (duration('cameraSettle', reducedMotion) / 1000);
    position.current.x = damp(position.current.x, wantedPosition.x, lambda, delta);
    position.current.y = damp(position.current.y, wantedPosition.y, lambda, delta);
    position.current.z = damp(position.current.z, wantedPosition.z, lambda, delta);
    target.current.x = damp(target.current.x, wantedTarget.x, lambda, delta);
    target.current.y = damp(target.current.y, wantedTarget.y, lambda, delta);
    target.current.z = damp(target.current.z, wantedTarget.z, lambda, delta);

    // Pointer: normalised position and a smoothed velocity (the candle's flame leans away from it).
    const pointer = state.pointer;
    const safeDelta = Math.max(delta, 1e-3);
    pointerState.vx = damp(pointerState.vx, (pointer.x - pointerState.x) / safeDelta, 8, delta);
    pointerState.vy = damp(pointerState.vy, (pointer.y - pointerState.y) / safeDelta, 8, delta);
    pointerState.x = pointer.x;
    pointerState.y = pointer.y;
    smoothPointer.current.x = damp(smoothPointer.current.x, pointer.x, 3, delta);
    smoothPointer.current.y = damp(smoothPointer.current.y, pointer.y, 3, delta);

    const phase = experienceStore.getState().phase;
    const distance = position.current.distanceTo(target.current);
    const writing = diaryBookStore.getState().writing;
    const amount = motionAmplitude(
      phase,
      reducedMotion || writing,
      distance,
      pose.fov,
      height,
      amplitude.current,
    );
    const t = state.clock.elapsedTime;
    const driftX = Math.sin(t * 0.21) * amount.drift;
    const driftY = Math.sin(t * 0.17 + 1.3) * amount.drift * 0.6;
    camera.position.set(
      position.current.x + smoothPointer.current.x * amount.parallax + driftX,
      position.current.y + smoothPointer.current.y * amount.parallax * 0.5 + driftY,
      position.current.z,
    );
    camera.fov = zoomedFov(pose.fov, revealZoom.value);
    // Writing: the camera looks down the page's normal with its up along the page's top-to-bottom axis, and does not drift or lean
    // (a lean over a near-vertical view rolls the picture: the page's top edge and the ruled lines slope across the screen).
    camera.up.set(...writingUp(writing));
    camera.lookAt(target.current);
    camera.updateProjectionMatrix();

    const arrived =
      position.current.distanceTo(restPosition.current) < SETTLE_EPSILON &&
      target.current.distanceTo(restTarget.current) < SETTLE_EPSILON;
    if (arrived !== stableRef.current) {
      stableRef.current = arrived;
      anchorStore.getState().setStable(arrived);
    }
  });

  // Keep applyPose referenced for the first frame so the camera is never at the library default.
  useEffect(() => {
    if (rest.current) applyPose(camera, rest.current);
  }, [camera]);

  return null;
}
