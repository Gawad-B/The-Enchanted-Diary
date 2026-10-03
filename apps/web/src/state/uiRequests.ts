import { createStore, useStore, type StoreApi } from 'zustand';

/**
 * Requests from the 3D scene to the DOM layer: the scene can only draw, so when the visitor clicks a part of
 * the book that stands for a control (the flyleaf's invitation), it asks the owner of that control to act.
 * `choose-manuscript` opens the file picker (wired by the upload interaction); `read-sample` offers the sample manuscript
 * (the upload effect fetches it).
 */
export type UiRequestType = 'choose-manuscript';

export interface UiRequest {
  type: UiRequestType;
  /** Increases with every request, so asking twice in a row is two events. */
  id: number;
}

export interface UiRequestState {
  latest: UiRequest | null;
  request(type: UiRequestType): void;
}

export type UiRequestStore = StoreApi<UiRequestState>;

export function createUiRequestStore(): UiRequestStore {
  let counter = 0;
  return createStore<UiRequestState>()((set) => ({
    latest: null,
    request: (type) => {
      counter += 1;
      set({ latest: { type, id: counter } });
    },
  }));
}

export const uiRequestStore = createUiRequestStore();

/** Calls `handler` for every request of `type` made after subscribing; returns the unsubscribe function. */
export function onUiRequest(
  type: UiRequestType,
  handler: () => void,
  store: UiRequestStore = uiRequestStore,
): () => void {
  return store.subscribe((state, previous) => {
    if (state.latest && state.latest !== previous.latest && (state.latest.type as string) === type) handler();
  });
}

export function useUiRequest<T>(selector: (state: UiRequestState) => T): T {
  return useStore(uiRequestStore, selector);
}
