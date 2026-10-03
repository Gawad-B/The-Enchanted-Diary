import { readerStore, type ReaderStore } from './readerStore';

/** Screens narrower than this page one page at a time (the camera framing uses the same breakpoint). */
export const NARROW_BREAKPOINT_PX = 720;

/** The part of `window` this needs. */
export interface ViewportSource {
  readonly innerWidth: number;
  addEventListener(type: 'resize', listener: () => void): void;
  removeEventListener(type: 'resize', listener: () => void): void;
}

/**
 * Tells the reader whether the screen is narrow, so navigation walks one page at a time there. It is part of the
 * shared layer (both the 3D book and the 2D fallback page by the reader) and runs for the life of the page.
 */
export function startNarrowSync(
  reader: Pick<ReaderStore, 'getState'> = readerStore,
  viewport: ViewportSource = window,
): () => void {
  const apply = (): void => {
    const narrow = viewport.innerWidth < NARROW_BREAKPOINT_PX;
    if (reader.getState().narrow !== narrow) reader.getState().setNarrow(narrow);
  };
  apply();
  viewport.addEventListener('resize', apply);
  return () => {
    viewport.removeEventListener('resize', apply);
  };
}
