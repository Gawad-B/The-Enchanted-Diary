import type { WebGLRenderer } from 'three';
import { anchorStore } from '../../state/anchorStore';
import { diaryBookStore } from '../../state/diaryBook';
import { viewportInsetStore } from '../../state/viewportInset';
import { experienceStore } from '../../state/experience';
import { readerStore } from '../../state/readerStore';
import type { BookPresenter } from '../book/useBookPresenter';
import type { SceneAssets } from '../sceneAssets';
import { pageEffectsStore } from '../../state/pageEffectsStore';
import { pointerState } from '../input';
import { perfState, snapshotPerf } from '../perf';

/**
 * Development-only handles on the running scene, for the visual QA scripts: `window.__diary.state()` says
 * whether anything is still moving, so a screenshot is taken once the book and the camera have settled.
 * In production builds this function does nothing and is removed with the harness.
 */
export interface DevHookInput {
  presenter: BookPresenter;
  assets: SceneAssets;
  gl: WebGLRenderer;
}

export interface DiaryDevHandle {
  /** The rig, for poking at in the browser console (development only). */
  rig: BookPresenter['rig'];
  state(): {
    phase: string;
    epoch: number;
    spread: number;
    moving: boolean;
    turning: boolean;
    cover: number;
    stableCamera: boolean;
    direction: string;
    leafCount: number;
    spreadTarget: number;
    /** The pointer as the scene sees it (normalised, -1..1) and the hover glow it has produced. */
    pointer: { x: number; y: number };
    hoverGlow: number;
    /** The screen rectangles the overlays sit on (see anchorStore). */
    anchors: ReturnType<typeof anchorStore.getState>['rects'];
  };
  /** The diary's own pages in the book and the dive onto one of them (global section T). */
  diary(): ReturnType<typeof diaryBookStore.getState>;
  /** Pretends an on-screen keyboard covers this many px at the bottom of the screen (0 lifts it). */
  inset(px: number): void;
  perf: typeof snapshotPerf;
  info(): { calls: number; triangles: number; geometries: number; textures: number };
  /** Jumps the book to a pose without animation. */
  snap(open: boolean, spread: number): void;
  /** Forgets the frame times measured so far. */
  resetMeter(): void;
  /** Angle (0 unturned .. 1 turned) of a leaf. */
  theta(index: number): number;
  /** Freezes or resumes every tween. */
  freeze(frozen: boolean): void;
  /** Advances a frozen motion by this many seconds (for deterministic mid-turn screenshots). */
  step(seconds: number): void;
  /** Sets the layout direction at once. */
  layout(direction: 'ltr' | 'rtl'): void;
  /** Pins the camera (null releases it). */
  camera(pose: { position: [number, number, number]; target: [number, number, number] } | null): void;
}

/** A fixed camera for close-up inspection in development (`?cam=px,py,pz,tx,ty,tz`); ignored in production. */
export const devCamera = {
  enabled: false,
  position: [0, 0, 0] as [number, number, number],
  target: [0, 0, 0] as [number, number, number],
};

declare global {
  interface Window {
    __diary?: DiaryDevHandle;
  }
}

export function registerDevHooks({ presenter, gl }: DevHookInput): () => void {
  if (!import.meta.env.DEV) return () => undefined;
  const handle: DiaryDevHandle = {
    rig: presenter.rig,
    state: () => ({
      phase: experienceStore.getState().phase,
      epoch: experienceStore.getState().epoch,
      spread: readerStore.getState().spread,
      moving: presenter.motion.moving,
      turning: presenter.motion.turning,
      cover: presenter.motion.cover.value,
      stableCamera: anchorStore.getState().stable,
      direction: readerStore.getState().direction,
      leafCount: presenter.motion.leafCount,
      spreadTarget: presenter.motion.spreadTarget,
      pointer: { x: pointerState.x, y: pointerState.y },
      hoverGlow: pageEffectsStore.getState().sources.hover.edgeGlow,
      anchors: anchorStore.getState().rects,
    }),
    diary: () => diaryBookStore.getState(),
    inset: (px) => {
      viewportInsetStore.getState().setBottom(px);
    },
    perf: snapshotPerf,
    info: () => ({
      calls: gl.info.render.calls,
      triangles: gl.info.render.triangles,
      geometries: gl.info.memory.geometries,
      textures: gl.info.memory.textures,
    }),
    snap: (open, spread) => {
      presenter.motion.snap({ open, spread });
    },
    resetMeter: () => {
      perfState.meter.reset();
    },
    theta: (index) => presenter.motion.thetas[index] ?? 0,
    freeze: (frozen) => {
      presenter.motion.frozen = frozen;
    },
    step: (seconds) => {
      const { motion } = presenter;
      const wasFrozen = motion.frozen;
      motion.frozen = false;
      for (let left = seconds; left > 1e-6; left -= 0.25) motion.update(Math.min(0.25, left));
      motion.frozen = wasFrozen;
    },
    layout: (direction) => {
      presenter.setLayout(direction);
    },
    camera: (pose) => {
      devCamera.enabled = pose !== null;
      if (pose) {
        devCamera.position = pose.position;
        devCamera.target = pose.target;
      }
    },
  };
  window.__diary = handle;
  return () => {
    if (window.__diary === handle) delete window.__diary;
  };
}
