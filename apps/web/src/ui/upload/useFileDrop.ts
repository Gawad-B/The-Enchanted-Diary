import { useEffect, useRef, useState } from 'react';
import { offerFile } from '../../state/offerFile';
import { pageEffectsStore } from '../../state/pageEffectsStore';

/** How strongly the book's edges glow while a file is dragged over the window. */
export const DRAG_EDGE_GLOW = 0.85;

function carriesFiles(event: DragEvent): boolean {
  return event.dataTransfer?.types.includes('Files') === true;
}

/**
 * Dragging a file anywhere over the window: the book's edges glow (`edgeGlow`, source "drag") and `dragging` is true (the
 * stage shows a soft "release to offer" hint); dropping it anywhere offers it (what then happens depends on the phase: see
 * `offerFile`, which also turns a file away in the phases that cannot take it).
 *
 * The browser's own behaviour for a file dropped on a page (leaving the app to show the PDF) is prevented for the whole
 * life of the hook, in EVERY phase and before the session has been checked: a miss must never throw the reader out of
 * the diary. `offersAccepted` gates only the glow and the hint (the book is not asking for a file in every phase).
 */
export function useFileDrop(offersAccepted = true): { dragging: boolean } {
  const [dragging, setDragging] = useState(false);
  const glow = useRef(offersAccepted);
  // The listeners below live as long as the page and read this when a drag begins; a phase that stops asking for files lets go
  // of the glow at once (the hint is hidden by the return value, the book's edges by this).
  useEffect(() => {
    glow.current = offersAccepted;
    if (!offersAccepted) pageEffectsStore.getState().clear('drag');
  }, [offersAccepted]);

  useEffect(() => {
    // dragenter and dragleave fire for every element crossed: count them to know when the drag really left the window.
    let depth = 0;
    const end = (): void => {
      depth = 0;
      setDragging(false);
      pageEffectsStore.getState().clear('drag');
    };
    const onEnter = (event: DragEvent): void => {
      if (!carriesFiles(event)) return;
      event.preventDefault();
      depth += 1;
      if (depth === 1 && glow.current) {
        setDragging(true);
        pageEffectsStore.getState().set('drag', { edgeGlow: DRAG_EDGE_GLOW });
      }
    };
    const onOver = (event: DragEvent): void => {
      if (!carriesFiles(event)) return;
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = glow.current ? 'copy' : 'none';
    };
    const onLeave = (event: DragEvent): void => {
      if (!carriesFiles(event)) return;
      depth = Math.max(0, depth - 1);
      if (depth === 0) end();
    };
    const onDrop = (event: DragEvent): void => {
      if (!carriesFiles(event)) return;
      event.preventDefault();
      const file = event.dataTransfer?.files[0];
      end();
      if (file) void offerFile(file);
    };
    window.addEventListener('dragenter', onEnter);
    window.addEventListener('dragover', onOver);
    window.addEventListener('dragleave', onLeave);
    window.addEventListener('drop', onDrop);
    return () => {
      window.removeEventListener('dragenter', onEnter);
      window.removeEventListener('dragover', onOver);
      window.removeEventListener('dragleave', onLeave);
      window.removeEventListener('drop', onDrop);
      end();
    };
  }, []);

  return { dragging: dragging && offersAccepted };
}
