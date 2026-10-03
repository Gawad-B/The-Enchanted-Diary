import { useEffect, type RefObject } from 'react';
import { unturnedSide } from '../../book/bookLayout';
import { PAGE_HEIGHT, PAGE_WIDTH } from '../../diarypage/typography';
import { anchorStore, useAnchorStore } from '../../state/anchorStore';
import { diaryBookStore, useDiaryBook } from '../../state/diaryBook';
import { viewportInsetStore } from '../../state/viewportInset';
import { pageMatrix } from './homography';

/** How long the surface takes to appear before the page under it is drawn without ink (the same ink, twice, for that long). */
export const LIVE_AFTER_MS = 160;

/**
 * Lays the surface on the page of the 3D book: the four corners of the page as the camera sees them (from the anchors) give the
 * projective map, which is written straight to the element as a CSS `matrix3d` with a transient subscription (no React render
 * per frame, like every overlay on the book). Until the camera has told where the page is, the element stays hidden.
 */
export function useSurfacePlacement(ref: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    const place = (): void => {
      const element = ref.current;
      if (!element) return;
      const { quads, layoutDirection } = anchorStore.getState();
      const quad = quads[unturnedSide(layoutDirection) === 'right' ? 'rightPage' : 'leftPage'];
      const matrix = quad ? pageMatrix(quad, PAGE_WIDTH, PAGE_HEIGHT) : null;
      if (!matrix) {
        element.dataset.placed = 'false';
        element.style.removeProperty('transform');
        return;
      }
      element.dataset.placed = 'true';
      element.style.transform = matrix;
    };
    place();
    return anchorStore.subscribe(place);
  }, [ref]);
}

/**
 * Whether the surface may be shown: the reader is writing, the camera has arrived at the page and the book is still. The
 * surface appears over a page that is not moving, never over one that is.
 */
export function useSurfaceReady(): boolean {
  const writing = useDiaryBook((state) => state.writing);
  const moving = useDiaryBook((state) => state.moving);
  const stable = useAnchorStore((state) => state.stable);
  const placed = useAnchorStore((state) => {
    const quad = state.quads[unturnedSide(state.layoutDirection) === 'right' ? 'rightPage' : 'leftPage'];
    return quad !== null;
  });
  return writing && stable && !moving && placed;
}

/**
 * Tells the book which page the surface lies over, so that the page's texture is drawn without the ink the surface shows (and
 * with it again as soon as the surface lets go). The page is handed over a moment after the surface is up.
 */
export function useLivePage(ready: boolean, page: number, bake = true): void {
  useEffect(() => {
    if (!ready || !bake) {
      diaryBookStore.getState().setLivePage(null);
      return undefined;
    }
    const timer = setTimeout(() => {
      diaryBookStore.getState().setLivePage(page);
    }, LIVE_AFTER_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [ready, page, bake]);
}

/**
 * On a phone the keyboard covers the lower part of the screen while the reader writes: the visual viewport tells how much, and the
 * camera frames the page above it (the diary's own framing reads `viewportInsetStore`).
 */
export function useKeyboardInset(active: boolean): void {
  useEffect(() => {
    const viewport = typeof window === 'undefined' ? undefined : window.visualViewport;
    if (!active || !viewport) return undefined;
    const sync = (): void => {
      const covered = window.innerHeight - viewport.height - viewport.offsetTop;
      // A few px are the browser's own chrome, not a keyboard.
      viewportInsetStore.getState().setBottom(covered > 80 ? covered : 0);
    };
    sync();
    viewport.addEventListener('resize', sync);
    viewport.addEventListener('scroll', sync);
    return () => {
      viewport.removeEventListener('resize', sync);
      viewport.removeEventListener('scroll', sync);
      viewportInsetStore.getState().setBottom(0);
    };
  }, [active]);
}
