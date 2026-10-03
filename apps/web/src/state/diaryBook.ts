import { createStore, useStore, type StoreApi } from 'zustand';
import { leadLeavesCount, sceneSpreadFor } from '../book/bookLayout';

/**
 * The diary as part of the book (global section T): its own writing pages are bound at the front, before the manuscript, and
 * the camera dives onto one of them to write. This store holds only that: how many pages are bound, whether the dive is on and
 * which page the book is turned to, and where to come back to after a citation took the reader to a page of the manuscript. The
 * 3D scene reads it to bind the leaves and to frame the page; the writing surface and the controls write it. It knows nothing
 * of three.js or React.
 */

/** At most this many diary leaves (pages) are kept; older exchanges live in the accessible log only. */
export const MAX_DIARY_LEAVES = 8;

export interface DiaryBookState {
  /** Diary pages bound at the front of the book (0 until there is something to write on). */
  leaves: number;
  /** The camera is diving onto a diary page. */
  writing: boolean;
  /** The diary page the book is turned to while writing (0-based). */
  page: number;
  /** After a citation took the reader to the manuscript: the page to come back to ("Return to the diary"), or null. */
  returnTo: number | null;
  /** The page the writing surface lies over right now: its texture is drawn without ink (the surface shows it), or null. */
  livePage: number | null;
  /** The PDF's own pages are on show (the truth scene): the book is turned to the reader's spread, not left on the diary's page. */
  pdfVisible: boolean;
  /** The 3D book is moving (a leaf turning, the cover swinging): the writing surface waits for it to be still. */
  moving: boolean;

  setLeaves: (leaves: number) => void;
  /** Dives onto a page (the last one, by default), binding the first page of the diary when it has none. */
  startWriting: (page?: number, options?: { bindLeaf?: boolean }) => void;
  stopWriting: () => void;
  /** Turns to another page while writing. */
  turnTo: (page: number) => void;
  /** Binds one more page after the last (false when the diary is full). */
  addPage: () => boolean;
  /** Pulls back from the diary to a cited page of the manuscript, remembering the page to return to. */
  leaveForCitation: () => void;
  /** Forgets the page to return to (the ribbon goes). */
  clearReturnTo: () => void;
  setLivePage: (page: number | null) => void;
  setPdfVisible: (visible: boolean) => void;
  setMoving: (moving: boolean) => void;
  reset: () => void;
}

const clampLeaves = (leaves: number): number => Math.min(Math.max(Math.round(leaves), 0), MAX_DIARY_LEAVES);

export type DiaryBookStore = StoreApi<DiaryBookState>;

export function createDiaryBookStore(): DiaryBookStore {
  return createStore<DiaryBookState>()((set, get) => ({
    leaves: 0,
    writing: false,
    page: 0,
    returnTo: null,
    livePage: null,
    pdfVisible: false,
    moving: false,
    setLeaves: (leaves) => {
      const next = clampLeaves(leaves);
      set((state) => ({ leaves: next, page: Math.min(state.page, Math.max(next - 1, 0)) }));
    },
    startWriting: (page, options = {}) => {
      const bind = options.bindLeaf ?? true;
      const leaves = bind ? Math.max(get().leaves, 1) : get().leaves;
      const last = Math.max(leaves - 1, 0);
      set({
        writing: true,
        leaves,
        page: page === undefined ? last : Math.min(Math.max(Math.round(page), 0), last),
        returnTo: null,
      });
    },
    stopWriting: () => {
      // The page the surface lay over is drawn with its ink again at once, so it holds what was written when the camera leaves.
      set({ writing: false, livePage: null });
    },
    turnTo: (page) => {
      const last = Math.max(get().leaves - 1, 0);
      const next = Math.min(Math.max(Math.round(page), 0), last);
      // The surface lets go of the page (it is drawn with its ink) and waits for the book to be still before it lies on the next one.
      if (next !== get().page) set({ page: next, livePage: null, moving: true });
    },
    addPage: () => {
      if (get().leaves >= MAX_DIARY_LEAVES) return false;
      set((state) => ({ leaves: state.leaves + 1 }));
      return true;
    },
    leaveForCitation: () => {
      set((state) => ({ writing: false, livePage: null, returnTo: state.page }));
    },
    clearReturnTo: () => {
      if (get().returnTo !== null) set({ returnTo: null });
    },
    setLivePage: (livePage) => {
      if (get().livePage !== livePage) set({ livePage });
    },
    setPdfVisible: (pdfVisible) => {
      if (get().pdfVisible !== pdfVisible) set({ pdfVisible });
    },
    setMoving: (moving) => {
      if (get().moving !== moving) set({ moving });
    },
    reset: () => {
      set({
        leaves: 0,
        writing: false,
        page: 0,
        returnTo: null,
        livePage: null,
        pdfVisible: false,
        moving: false,
      });
    },
  }));
}

export const diaryBookStore = createDiaryBookStore();

export function useDiaryBook<T>(selector: (state: DiaryBookState) => T): T {
  return useStore(diaryBookStore, selector);
}

/**
 * The book the scene shows: how many diary leaves stand before the flyleaf, and the number of turned leaves. Reading the
 * manuscript, the diary's leaves are all turned (the scene's spread is theirs plus the reader's); writing, the book is turned to
 * the diary page.
 */
export function sceneBookOf(
  diary: Pick<DiaryBookState, 'leaves' | 'writing' | 'page'> & { pdfVisible?: boolean },
  readerSpread: number,
): { diaryLeaves: number; spread: number } {
  // The book rests on the diary's page: it is turned to the PDF's pages only on purpose (the truth scene), never by stepping back.
  if (diary.writing || (diary.leaves > 0 && diary.pdfVisible !== true)) {
    return {
      diaryLeaves: diary.leaves,
      // (the diary's pages come after the blank lead leaves: the book riffles forward to the middle to reach them)
      spread: diary.leaves > 0 ? leadLeavesCount() + Math.min(Math.max(diary.page, 0), diary.leaves - 1) : 0,
    };
  }
  return { diaryLeaves: diary.leaves, spread: sceneSpreadFor(readerSpread, diary.leaves) };
}
