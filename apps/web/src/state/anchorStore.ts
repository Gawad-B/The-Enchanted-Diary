import type { Direction } from '@enchanted/shared';
import { createStore, useStore, type StoreApi } from 'zustand';

/**
 * Where parts of the 3D book are on the screen, so DOM overlays (the "Open the diary" button, the manuscript
 * button on the flyleaf, the diary's writing area) can sit on them. Rectangles are in CSS pixels relative to
 * the viewport and come from the REST camera pose of the current phase, never from the idle drift or the
 * pointer parallax, so overlays do not wobble. `stable` is false while the camera is moving between poses;
 * overlays fade then. Overlays subscribe transiently (`anchorStore.subscribe`) and write `transform` to a ref:
 * no React render per frame.
 */
export type AnchorName = 'book' | 'flyleaf' | 'leftPage' | 'rightPage';

export interface ScreenRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type AnchorRects = Readonly<Record<AnchorName, ScreenRect | null>>;

export interface ScreenPoint {
  x: number;
  y: number;
}

/** A page as four corners on the screen: top left, top right, bottom right, bottom left (as seen, whatever the direction of the book). */
export type ScreenQuad = readonly [ScreenPoint, ScreenPoint, ScreenPoint, ScreenPoint];

export type AnchorQuads = Readonly<Record<'leftPage' | 'rightPage', ScreenQuad | null>>;

const NO_RECTS: AnchorRects = Object.freeze({ book: null, flyleaf: null, leftPage: null, rightPage: null });
const NO_QUADS: AnchorQuads = Object.freeze({ leftPage: null, rightPage: null });

export interface AnchorState {
  rects: AnchorRects;
  /** The corners of the two visible pages, for surfaces that lie on the page plane (the diary's writing surface). */
  quads: AnchorQuads;
  stable: boolean;
  /**
   * The direction the 3D book is laid out in right now. It follows the reader's direction, but an open book
   * keeps its layout until it is closed, so the anchors and the reserved regions go by this value.
   */
  layoutDirection: Direction;
  /** True while the scene draws a vignette of its own (post-processing); the stage's CSS vignette then steps aside. */
  sceneVignette: boolean;
  setLayoutDirection(direction: Direction): void;
  setSceneVignette(drawn: boolean): void;
  setRects(rects: Partial<Record<AnchorName, ScreenRect | null>>): void;
  setQuads(quads: Partial<Record<'leftPage' | 'rightPage', ScreenQuad | null>>): void;
  setStable(stable: boolean): void;
  reset(): void;
}

function sameRect(a: ScreenRect | null, b: ScreenRect | null): boolean {
  if (a === null || b === null) return a === b;
  return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
}

export type AnchorStore = StoreApi<AnchorState>;

export function createAnchorStore(): AnchorStore {
  return createStore<AnchorState>()((set, get) => ({
    rects: NO_RECTS,
    quads: NO_QUADS,
    stable: false,
    layoutDirection: 'ltr',
    sceneVignette: false,
    setLayoutDirection: (layoutDirection) => {
      if (get().layoutDirection !== layoutDirection) set({ layoutDirection });
    },
    setSceneVignette: (sceneVignette) => {
      if (get().sceneVignette !== sceneVignette) set({ sceneVignette });
    },
    setRects: (partial) => {
      const current = get().rects;
      const next: Record<AnchorName, ScreenRect | null> = { ...current };
      let changed = false;
      for (const name of Object.keys(partial) as AnchorName[]) {
        if (!(name in current)) continue; // only known anchors (a caller may pass a wider object)
        const value = partial[name] ?? null;
        if (!sameRect(current[name], value)) {
          next[name] = value;
          changed = true;
        }
      }
      if (changed) set({ rects: next });
    },
    setQuads: (partial) => {
      const current = get().quads;
      const next = { ...current, ...partial };
      const samePoint = (p: ScreenPoint, q: ScreenPoint): boolean => p.x === q.x && p.y === q.y;
      const same = (a: ScreenQuad | null, b: ScreenQuad | null): boolean =>
        a === b ||
        (a !== null &&
          b !== null &&
          samePoint(a[0], b[0]) &&
          samePoint(a[1], b[1]) &&
          samePoint(a[2], b[2]) &&
          samePoint(a[3], b[3]));
      if (!same(current.leftPage, next.leftPage) || !same(current.rightPage, next.rightPage))
        set({ quads: next });
    },
    setStable: (stable) => {
      if (get().stable !== stable) set({ stable });
    },
    reset: () => {
      set({ rects: NO_RECTS, quads: NO_QUADS, stable: false, layoutDirection: 'ltr', sceneVignette: false });
    },
  }));
}

export const anchorStore = createAnchorStore();

export function useAnchorStore<T>(selector: (state: AnchorState) => T): T {
  return useStore(anchorStore, selector);
}
