import { createStore, useStore, type StoreApi } from 'zustand';

/**
 * Writing on the flyleaf before there is a manuscript. The diary answers in scripted in-world lines (they are about the diary
 * having nothing to remember yet, never an answer about any content); which line is a matter of how often the reader has
 * written. Only the latest exchange is kept: the words sink into the blank paper and the diary's line stays until the next.
 */
export type FlyleafLine = 'first' | 'second' | 'third' | 'nothing';

export interface FlyleafExchange {
  id: number;
  question: string;
  line: FlyleafLine;
  /** Epoch ms of the writing (the sink and the diary's reply count from here). */
  at: number;
}

export interface FlyleafState {
  current: FlyleafExchange | null;
  attempts: number;
  /** The reader wrote `question`; `secret` is the reveal phrase, which has nothing to reveal yet. */
  write: (question: string, secret: boolean) => void;
  reset: () => void;
}

const LINES: readonly FlyleafLine[] = ['first', 'second', 'third'];

export type FlyleafStore = StoreApi<FlyleafState>;

export function createFlyleafStore(): FlyleafStore {
  let counter = 0;
  return createStore<FlyleafState>()((set, get) => ({
    current: null,
    attempts: 0,
    write: (question, secret) => {
      counter += 1;
      if (secret) {
        set({ current: { id: counter, question, line: 'nothing', at: Date.now() } });
        return;
      }
      const attempts = get().attempts + 1;
      set({
        attempts,
        current: {
          id: counter,
          question,
          line: LINES[Math.min(attempts, LINES.length) - 1] ?? 'third',
          at: Date.now(),
        },
      });
    },
    reset: () => {
      set({ current: null, attempts: 0 });
    },
  }));
}

export const flyleafStore = createFlyleafStore();

export function useFlyleafStore<T>(selector: (state: FlyleafState) => T): T {
  return useStore(flyleafStore, selector);
}
