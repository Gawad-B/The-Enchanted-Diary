import type { NormalizedRect } from '@enchanted/shared';
import { createStore, useStore, type StoreApi } from 'zustand';
import type { Language } from '../i18n/strings';
import type { Beat } from './timeline';

/**
 * What the "Show me the truth" scene is showing: the pages the answer rests on, the one in view, the beat of the clock and the
 * picture of the page. The clock and the effect write it; the DOM scene reads it. It knows nothing of three.js.
 */
export interface TruthPage {
  page: number;
  /** The passage to glow, in fractions of the page (empty for a page the diary only consulted). */
  rects: NormalizedRect[];
}

export interface RevealState {
  /** The exchange the visitor asked about (the scene looks its pages up when it starts); null = the latest answer. */
  requestedFor: string | null;
  /** The pages of the answer, in the order it cites them; empty until the scene starts. */
  pages: TruthPage[];
  index: number;
  /** The language the diary writes the line in (the script of the question). */
  language: Language;
  /** The diary page the visitor was writing on, to come back to. */
  returnTo: number | null;
  beat: Beat | null;
  t: number;
  /** The page picture of the page in view: null while it is being drawn. */
  image: { page: number; canvas: HTMLCanvasElement } | null;
  imageFailed: boolean;

  request(exchangeId: string | null): void;
  begin(pages: TruthPage[], language: Language, returnTo: number | null): void;
  setBeat(beat: Beat | null, t: number): void;
  setIndex(index: number): void;
  setImage(image: RevealState['image']): void;
  setImageFailed(failed: boolean): void;
  reset(): void;
}

const empty = {
  requestedFor: null,
  pages: [] as TruthPage[],
  index: 0,
  language: 'en' as Language,
  returnTo: null,
  beat: null,
  t: 0,
  image: null,
  imageFailed: false,
};

export type RevealStore = StoreApi<RevealState>;

export function createRevealStore(): RevealStore {
  return createStore<RevealState>()((set) => ({
    ...empty,
    request: (requestedFor) => {
      set({ requestedFor });
    },
    begin: (pages, language, returnTo) => {
      set({ pages, language, returnTo, index: 0, beat: null, t: 0, image: null, imageFailed: false });
    },
    setBeat: (beat, t) => {
      set({ beat, t });
    },
    setIndex: (index) => {
      set({ index, image: null, imageFailed: false });
    },
    setImage: (image) => {
      set({ image });
    },
    setImageFailed: (imageFailed) => {
      set({ imageFailed });
    },
    reset: () => {
      set({ ...empty });
    },
  }));
}

export const revealStore = createRevealStore();

export function useRevealStore<T>(selector: (state: RevealState) => T): T {
  return useStore(revealStore, selector);
}
