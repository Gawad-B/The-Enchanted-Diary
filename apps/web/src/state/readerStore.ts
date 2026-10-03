import type { Direction, NormalizedRect } from '@enchanted/shared';
import { createStore, useStore, type StoreApi } from 'zustand';
import {
  clampSpread,
  maxSpread,
  navigateNarrow,
  sideOfPage,
  spreadForPage,
  turnedSide,
  unturnedSide,
  type NavigationAction,
  type Side,
} from '../book/bookLayout';

/**
 * Where the reader is in the book (global section G). One source of truth for the 3D book, the PDF engine,
 * the conversation (citations turn pages), the reveal and the 2D fallback. It knows nothing about three.js.
 */
export interface Highlight {
  page: number;
  rects: NormalizedRect[];
  /** Changes on every `setHighlight`, so a repeated highlight of the same passage still re-triggers effects. */
  token: number;
}

export interface ReaderState {
  /** Reading direction of the document, or the interface direction while the book holds none. */
  direction: Direction;
  pageCount: number;
  hasDocument: boolean;
  /** Number of turned leaves; 0 is the bookplate spread. */
  spread: number;
  /** Narrow screens show one page: which side of the spread is in view (null on wide screens). */
  focusSide: Side | null;
  /** True on narrow screens: navigation walks one page at a time and `goToPage` sets `focusSide`. */
  narrow: boolean;
  /** "Read closely": one page fills the picture, even on a wide screen. Paging then walks one page at a time, as on a phone. */
  closely: boolean;
  highlight: Highlight | null;

  setDirection(direction: Direction): void;
  setNarrow(narrow: boolean): void;
  setClosely(closely: boolean): void;
  setDocument(pageCount: number, direction: Direction): void;
  clearDocument(): void;
  navigate(action: NavigationAction): void;
  next(): void;
  prev(): void;
  goToSpread(spread: number): void;
  goToPage(page: number): void;
  setHighlight(page: number, rects: NormalizedRect[]): void;
  clearHighlight(): void;
  reset(): void;
}

type ReaderData = Pick<
  ReaderState,
  'direction' | 'pageCount' | 'hasDocument' | 'spread' | 'focusSide' | 'narrow' | 'closely' | 'highlight'
>;

const emptyReader: ReaderData = {
  direction: 'ltr',
  pageCount: 0,
  hasDocument: false,
  spread: 0,
  focusSide: null,
  narrow: false,
  closely: false,
  highlight: null,
};

export type ReaderStore = StoreApi<ReaderState>;

export function createReaderStore(initial: Partial<ReaderData> = {}): ReaderStore {
  let highlightToken = 0;
  return createStore<ReaderState>()((set, get) => {
    /** One page at a time: a narrow screen, or "Read closely". */
    const single = (state: ReaderData): boolean => state.narrow || state.closely;
    /** The side in view for a spread on a narrow screen: the first page read there. */
    const firstSideOf = (spread: number, direction: Direction): Side =>
      spread <= 0 ? unturnedSide(direction) : turnedSide(direction);

    const moveTo = (spread: number, focusSide?: Side | null): void => {
      const state = get();
      const target = clampSpread(spread, state.pageCount, state.hasDocument);
      set({
        spread: target,
        focusSide: single(state) ? (focusSide ?? firstSideOf(target, state.direction)) : null,
      });
    };

    return {
      ...emptyReader,
      ...initial,

      setDirection: (direction) => {
        const state = get();
        // The spread's meaning is direction-free; only the side in view has to follow the layout.
        set({ direction, focusSide: single(state) ? firstSideOf(state.spread, direction) : null });
      },
      setNarrow: (narrow) => {
        const state = get();
        set({
          narrow,
          focusSide:
            narrow || state.closely ? (state.focusSide ?? firstSideOf(state.spread, state.direction)) : null,
        });
      },
      setClosely: (closely) => {
        const state = get();
        if (closely === state.closely) return;
        set({
          closely,
          focusSide:
            closely || state.narrow ? (state.focusSide ?? firstSideOf(state.spread, state.direction)) : null,
        });
      },
      setDocument: (pageCount, direction) => {
        const state = get();
        const count = Math.max(0, Math.floor(pageCount));
        const spread = clampSpread(state.spread, count, count > 0);
        set({
          pageCount: count,
          hasDocument: count > 0,
          direction,
          spread,
          focusSide: single(state) ? firstSideOf(spread, direction) : null,
          highlight: null,
        });
      },
      clearDocument: () => {
        const state = get();
        set({
          pageCount: 0,
          hasDocument: false,
          spread: 0,
          // The closed book has nothing to read closely.
          closely: false,
          focusSide: state.narrow ? unturnedSide(state.direction) : null,
          highlight: null,
        });
      },

      navigate: (action) => {
        const state = get();
        if (!state.hasDocument) return;
        if (action === 'first') {
          moveTo(1);
        } else if (action === 'last') {
          // On a narrow screen "last" is the last real page, not a blank face.
          if (single(state)) get().goToPage(state.pageCount);
          else moveTo(maxSpread(state.pageCount));
        } else if (single(state)) {
          const target = navigateNarrow(
            { spread: state.spread, focusSide: state.focusSide },
            action,
            state.direction,
            state.pageCount,
          );
          moveTo(target.spread, target.focusSide);
        } else {
          moveTo(state.spread + (action === 'next' ? 1 : -1));
        }
      },
      next: () => {
        get().navigate('next');
      },
      prev: () => {
        get().navigate('prev');
      },
      goToSpread: (spread) => {
        moveTo(spread);
      },
      goToPage: (page) => {
        const state = get();
        if (!state.hasDocument) return;
        const clamped = Math.min(Math.max(Math.round(page), 1), state.pageCount);
        moveTo(spreadForPage(clamped), sideOfPage(clamped, state.direction));
      },

      setHighlight: (page, rects) => {
        highlightToken += 1;
        set({ highlight: { page, rects, token: highlightToken } });
      },
      clearHighlight: () => {
        set({ highlight: null });
      },
      reset: () => {
        set({ ...emptyReader, narrow: get().narrow });
      },
    };
  });
}

export const readerStore = createReaderStore();

export function useReaderStore<T>(selector: (state: ReaderState) => T): T {
  return useStore(readerStore, selector);
}
