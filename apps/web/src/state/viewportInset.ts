import { createStore, useStore, type StoreApi } from 'zustand';

/**
 * Pixels at the bottom of the screen that something else covers: the on-screen keyboard of a phone while the reader writes in
 * the diary (global section T: the page is framed above it). Written by the writing surface from the visual viewport, read by
 * the camera rig; it knows nothing of either.
 */
export interface ViewportInsetState {
  bottomPx: number;
  setBottom: (px: number) => void;
}

export type ViewportInsetStore = StoreApi<ViewportInsetState>;

export function createViewportInsetStore(): ViewportInsetStore {
  return createStore<ViewportInsetState>()((set) => ({
    bottomPx: 0,
    setBottom: (px) => {
      const next = Math.max(Math.round(px), 0);
      set((state) => (state.bottomPx === next ? state : { bottomPx: next }));
    },
  }));
}

export const viewportInsetStore = createViewportInsetStore();

export function useViewportInset<T>(selector: (state: ViewportInsetState) => T): T {
  return useStore(viewportInsetStore, selector);
}
