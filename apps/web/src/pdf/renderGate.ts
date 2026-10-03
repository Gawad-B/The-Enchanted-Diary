/**
 * Whether a page turn (or the cover, or the book flipping over) is animating right now. Drawing a PDF page costs a few
 * to a few tens of milliseconds of main-thread time, which a turn in progress cannot spare: the scene says when it is
 * busy and the page image service holds its renders back until it is not. A plain flag with listeners; the scene writes it
 * from its frame loop (it only notifies when the value changes), so nothing re-renders per frame.
 */
export interface RenderGate {
  busy(): boolean;
  setBusy(busy: boolean): void;
  /** Called when the gate changes; returns the unsubscribe function. */
  subscribe(listener: () => void): () => void;
}

export function createRenderGate(): RenderGate {
  let busy = false;
  const listeners = new Set<() => void>();
  return {
    busy: () => busy,
    setBusy: (next) => {
      if (next === busy) return;
      busy = next;
      for (const listener of [...listeners]) listener();
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

export const renderGate = createRenderGate();
