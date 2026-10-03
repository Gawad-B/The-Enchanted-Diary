import { useEffect, useRef } from 'react';
import { anchorStore, type AnchorRects, type ScreenRect } from '../../state/anchorStore';

/** Where, in CSS px, an overlay sits, given the book's rectangles on the screen (null: not known yet). */
export type Zone = (rects: AnchorRects) => ScreenRect | null;

/** The part of the flyleaf a band covers: fractions of its height from its top, inset a little from its sides. */
export function flyleafBand(from: number, to: number, inset = 0.1): Zone {
  return ({ flyleaf }) =>
    flyleaf
      ? {
          x: flyleaf.x + flyleaf.width * inset,
          y: flyleaf.y + flyleaf.height * from,
          width: flyleaf.width * (1 - 2 * inset),
          height: flyleaf.height * (to - from),
        }
      : null;
}

/**
 * Where, on the flyleaf, the controls and the messages sit: from half way down to near the foot, and well in from the sides.
 * The flyleaf's anchor is the bounding box of the page as the camera sees it, which is as wide as the page's widest edge (the
 * foot); at the height of the messages the paper is narrower, and the decorative frame narrower still. 16% on each side keeps
 * even the longest line inside the frame at every camera pose of `awaiting`.
 */
export const FLYLEAF_ZONE = [0.5, 0.955, 0.16] as const;
/** On a phone the page is seen from steeper above, nearly a rectangle: less of the bounding box is outside the paper. */
export const FLYLEAF_INSET_NARROW = 0.12;
const NARROW_WIDTH_PX = 720;

/** The zone of the flyleaf the controls and the messages use (see FLYLEAF_ZONE): the inset follows the width of the screen. */
export const flyleafZone: Zone = (rects) => {
  const [from, to, inset] = FLYLEAF_ZONE;
  const narrow = typeof window !== 'undefined' && window.innerWidth < NARROW_WIDTH_PX;
  return flyleafBand(from, to, narrow ? FLYLEAF_INSET_NARROW : inset)(rects);
};

/**
 * Just above the closed book, on the dark of the room (the camera lowers the closed book to leave that room). With no room
 * above (a very short screen) it sits on the cover's lower third instead, where the leather is plain.
 */
export const aboveBook: Zone = ({ book }) => {
  if (!book) return null;
  const height = 130;
  const width = Math.min(
    Math.max(book.width * 1.2, 320),
    typeof window === 'undefined' ? 480 : window.innerWidth - 16,
  );
  const x = book.x + book.width / 2 - width / 2;
  const above = book.y - height - 8;
  return { x, y: above >= 8 ? above : book.y + book.height * 0.62, width, height };
};

/**
 * Keeps an element on a zone of the 3D book with a transient subscription: the position is written straight to the element
 * (a transform and a size), with no React render per frame. Until the camera has reported where the book is, the element
 * stays where the stylesheet puts it (centred), so it is never unreachable. It fades while the camera moves (`data-stable`).
 */
export function useAnchoredBox<T extends HTMLElement>(zone: Zone, active = true): React.RefObject<T | null> {
  const ref = useRef<T>(null);
  useEffect(() => {
    if (!active) return undefined;
    const place = (): void => {
      const element = ref.current;
      if (!element) return;
      const { rects, stable } = anchorStore.getState();
      const rect = zone(rects);
      if (!rect) {
        element.dataset.placed = 'false';
        for (const property of ['width', 'height', 'transform']) element.style.removeProperty(property);
        return;
      }
      element.dataset.placed = 'true';
      element.dataset.stable = String(stable);
      element.style.width = `${String(Math.round(rect.width))}px`;
      element.style.maxHeight = `${String(Math.round(rect.height))}px`;
      element.style.transform = `translate(${String(Math.round(rect.x))}px, ${String(Math.round(rect.y))}px)`;
    };
    place();
    return anchorStore.subscribe(place);
  }, [active, zone]);
  return ref;
}
