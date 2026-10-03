import type { ThreeEvent } from '@react-three/fiber';
import { useEffect } from 'react';
import { experienceStore } from '../../state/experience';
import { pageEffectsStore } from '../../state/pageEffectsStore';
import { uiRequestStore } from '../../state/uiRequests';
import { interactionFor } from './interaction';
import type { BookPresenter } from './useBookPresenter';

/** How strongly the closed book's edges glow while the pointer is over it. */
const HOVER_EDGE_GLOW = 0.55;

/**
 * Mounts the book (built imperatively by BookRig) and wires its pointer events. The Canvas listens on the whole
 * stage (so the pointer is tracked over the "Open the diary" button too), and only the rig's two hit areas answer
 * a raycast: hovering the closed diary makes it lift and its edges glow, clicking it (or the button over it) asks
 * the experience to open, and clicking the flyleaf in `awaiting` asks the DOM layer to open the file picker (the
 * scene can only draw).
 */
export function Book({ presenter }: { presenter: BookPresenter }) {
  const { rig } = presenter;

  useEffect(
    () => () => {
      document.body.style.cursor = '';
      pageEffectsStore.getState().clear('hover');
    },
    [],
  );

  const over = (event: ThreeEvent<PointerEvent>): void => {
    const action = interactionFor(experienceStore.getState().phase, event.object, rig);
    if (!action) return;
    if (action === 'open-book') pageEffectsStore.getState().set('hover', { edgeGlow: HOVER_EDGE_GLOW });
    document.body.style.cursor = 'pointer';
  };
  const out = (event: ThreeEvent<PointerEvent>): void => {
    // Leaving any other child must not end the hover: only the hit areas count.
    if (event.object !== rig.hitBook && event.object !== rig.hitFlyleaf) return;
    pageEffectsStore.getState().clear('hover');
    document.body.style.cursor = '';
  };
  const click = (event: ThreeEvent<MouseEvent>): void => {
    const action = interactionFor(experienceStore.getState().phase, event.object, rig);
    // In discovery the button over the book opens it (its own click reaches here too: one door, not two).
    if (action === 'choose-manuscript') uiRequestStore.getState().request('choose-manuscript');
  };

  return (
    <>
      <primitive object={rig.root} onPointerOver={over} onPointerOut={out} onClick={click} />
      <primitive object={rig.shadow} />
    </>
  );
}
