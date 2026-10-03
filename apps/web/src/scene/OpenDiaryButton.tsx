import { useEffect, useRef } from 'react';
import { anchorStore } from '../state/anchorStore';
import { experienceStore, useExperienceStore } from '../state/experience';
import { pageEffectsStore } from '../state/pageEffectsStore';

/** How strongly the book's edges glow while the keyboard focus is on it (the pointer's hover is the scene's). */
const ATTENTION_EDGE_GLOW = 0.55;

/**
 * The accessible door into the 3D diary: a real, keyboard-focusable button laid over the closed book. It is
 * visually quiet (invisible until the pointer or the keyboard focus reaches it, then a faint gold rim and a
 * small caption), and it follows the book through the anchor rectangles with a transient subscription:
 * the position is written straight to the element, with no React render per frame.
 */
export function OpenDiaryButton() {
  const phase = useExperienceStore((state) => state.phase);
  const sessionChecked = useExperienceStore((state) => state.sessionChecked);
  const button = useRef<HTMLButtonElement>(null);
  const visible = phase === 'discovery' && sessionChecked;

  useEffect(() => {
    if (!visible) return undefined;
    const place = (): void => {
      const element = button.current;
      if (!element) return;
      const { rects, stable } = anchorStore.getState();
      const rect = rects.book;
      if (!rect) {
        // Until the camera has reported where the book is, the button sits in the middle of the stage (it must
        // never be unreachable): the stylesheet gives it a default size and place.
        element.dataset.placed = 'false';
        for (const property of ['width', 'height', 'transform']) element.style.removeProperty(property);
        return;
      }
      element.dataset.placed = 'true';
      element.style.width = `${String(Math.round(rect.width))}px`;
      element.style.height = `${String(Math.round(rect.height))}px`;
      element.style.transform = `translate(${String(Math.round(rect.x))}px, ${String(Math.round(rect.y))}px)`;
      element.dataset.stable = String(stable);
    };
    place();
    return anchorStore.subscribe(place);
  }, [visible]);

  useEffect(
    () => () => {
      pageEffectsStore.getState().clear('hover');
    },
    [],
  );

  if (!visible) return null;
  const attend = (): void => {
    pageEffectsStore.getState().set('hover', { edgeGlow: ATTENTION_EDGE_GLOW });
  };
  const relax = (): void => {
    pageEffectsStore.getState().clear('hover');
  };
  return (
    <button
      ref={button}
      type="button"
      className="open-diary"
      // The book itself can be pressed (a pointer); the keyboard and screen readers have the welcome screen's button.
      aria-hidden="true"
      tabIndex={-1}
      onClick={() => {
        experienceStore.getState().dispatch({ type: 'INTERACT' });
      }}
      onFocus={attend}
      onBlur={relax}
    ></button>
  );
}
