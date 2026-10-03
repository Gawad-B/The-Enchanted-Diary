import { createStore, useStore, type StoreApi } from 'zustand';
import type { UiError } from '../api/client';

/**
 * What the diary says about an offer that did not start an upload: the file the browser could not accept (client-side
 * validation), or one offered while the diary is still reading another. These are not phases (nothing changes in the
 * state machine), only a line for the flyleaf. Cleared when the next upload starts or the reader dismisses it.
 */
export type UploadNotice =
  | { kind: 'rejected'; error: UiError; fileName: string }
  | { kind: 'stillReading'; fileName: string }
  /** Offered while the book is turning its pages (unveiling, revealing, closing): not now. */
  | { kind: 'busy'; fileName: string };

export interface UploadNoticeState {
  notice: UploadNotice | null;
  show(notice: UploadNotice): void;
  clear(): void;
}

export type UploadNoticeStore = StoreApi<UploadNoticeState>;

export function createUploadNoticeStore(): UploadNoticeStore {
  return createStore<UploadNoticeState>()((set) => ({
    notice: null,
    show: (notice) => {
      set({ notice });
    },
    clear: () => {
      set({ notice: null });
    },
  }));
}

export const uploadNoticeStore = createUploadNoticeStore();

export function useUploadNotice<T>(selector: (state: UploadNoticeState) => T): T {
  return useStore(uploadNoticeStore, selector);
}
