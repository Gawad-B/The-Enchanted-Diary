import { createStore, useStore, type StoreApi } from 'zustand';
import { closeIntent } from './closeIntent';
import { experienceStore, type ExperienceStore, type ExperienceStoreState } from './experience';

/**
 * The questions the diary asks before something the reader cannot undo. The diary menu and the drop of a file over a
 * manuscript that is already bound only ASK here; the dispatch happens when the reader confirms. A question does not
 * outlive the phase it was asked in (see state/effects/confirm.ts).
 */
export type ConfirmRequest =
  { kind: 'offerAnother' } | { kind: 'replace'; file: File } | { kind: 'close' } | { kind: 'reset' };

export interface ConfirmState {
  request: ConfirmRequest | null;
  /** Counts the questions asked: a new question is a new dialog (it takes the focus afresh), even if the kind is the same. */
  serial: number;
  /** What had the focus when the question was asked: the dialog gives the focus back to it. */
  opener: HTMLElement | null;
  ask(request: ConfirmRequest): void;
  dismiss(): void;
}

export type ConfirmStore = StoreApi<ConfirmState>;

export function createConfirmStore(): ConfirmStore {
  return createStore<ConfirmState>()((set) => ({
    request: null,
    serial: 0,
    opener: null,
    ask: (request) => {
      // Taken now, while the asker still has the focus: once the dialog is up the rest of the stage is inert, and a browser
      // moves the focus off an inert element at once.
      const focused = typeof document === 'undefined' ? null : document.activeElement;
      set((state) => ({
        request,
        serial: state.serial + 1,
        opener: focused instanceof HTMLElement && focused !== document.body ? focused : null,
      }));
    },
    dismiss: () => {
      set({ request: null });
    },
  }));
}

export const confirmStore = createConfirmStore();

export function useConfirmStore<T>(selector: (state: ConfirmState) => T): T {
  return useStore(confirmStore, selector);
}

/** What confirming does: the events the experience reducer knows, never a network call from here. */
export function carryOut(
  request: ConfirmRequest,
  experience: Pick<ExperienceStore, 'getState'> = experienceStore,
): void {
  const dispatch = (event: Parameters<ExperienceStoreState['dispatch']>[0]): void => {
    experience.getState().dispatch(event);
  };
  switch (request.kind) {
    case 'offerAnother':
      dispatch({ type: 'REPLACE_REQUESTED' });
      return;
    case 'replace':
      dispatch({ type: 'REPLACE_REQUESTED', file: request.file });
      return;
    case 'close':
      dispatch({ type: 'CLOSE_REQUESTED' });
      return;
    case 'reset':
      closeIntent.requestReset();
      dispatch({ type: 'CLOSE_REQUESTED' });
      // The reducer ignores a close in some phases (a book that is turning its pages): the intent must not wait for a later,
      // unrelated closing, which would then reset the session instead of deleting its document.
      if (experience.getState().phase !== 'closing') closeIntent.clear();
      return;
  }
}
