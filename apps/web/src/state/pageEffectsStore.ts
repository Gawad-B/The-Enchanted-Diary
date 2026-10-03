import { createStore, useStore, type StoreApi } from 'zustand';

/**
 * The magic the paper shows (global section G): ink spreading, the page glowing from within, a tremble, a
 * glow along the edges, the pull of a memory. Several parts of the product want to drive the same value
 * (hovering the book, dragging a file, real reading progress, the reveal, a citation), so each writes to its
 * own source and the book reads the maximum. Materials read the combined values as shader uniforms inside
 * the render loop; nothing re-renders per frame.
 */
export type EffectSource = 'hover' | 'drag' | 'progress' | 'reveal' | 'citation';

export interface EffectValues {
  inkSpread: number;
  glow: number;
  tremble: number;
  edgeGlow: number;
  memoryPull: number;
}

export const EFFECT_KEYS = ['inkSpread', 'glow', 'tremble', 'edgeGlow', 'memoryPull'] as const;

export const NO_EFFECTS: Readonly<EffectValues> = Object.freeze({
  inkSpread: 0,
  glow: 0,
  tremble: 0,
  edgeGlow: 0,
  memoryPull: 0,
});

const SOURCES: readonly EffectSource[] = ['hover', 'drag', 'progress', 'reveal', 'citation'];

export interface PageEffectsState {
  /** What each source currently asks for. */
  sources: Readonly<Record<EffectSource, Readonly<EffectValues>>>;
  /** The maximum over the sources, per value. */
  values: Readonly<EffectValues>;
  set(source: EffectSource, partial: Partial<EffectValues>): void;
  clear(source: EffectSource): void;
  clearAll(): void;
}

function clamp01(value: number): number {
  return Number.isFinite(value) ? Math.min(Math.max(value, 0), 1) : 0;
}

function emptySources(): Record<EffectSource, Readonly<EffectValues>> {
  return Object.fromEntries(SOURCES.map((source) => [source, NO_EFFECTS])) as Record<
    EffectSource,
    Readonly<EffectValues>
  >;
}

function combine(sources: Readonly<Record<EffectSource, Readonly<EffectValues>>>): EffectValues {
  const values: EffectValues = { ...NO_EFFECTS };
  for (const source of SOURCES) {
    for (const key of EFFECT_KEYS) values[key] = Math.max(values[key], sources[source][key]);
  }
  return values;
}

export type PageEffectsStore = StoreApi<PageEffectsState>;

export function createPageEffectsStore(): PageEffectsStore {
  return createStore<PageEffectsState>()((set, get) => ({
    sources: emptySources(),
    values: NO_EFFECTS,
    set: (source, partial) => {
      const current = get().sources[source];
      const next: EffectValues = { ...current };
      for (const key of EFFECT_KEYS) {
        const value = partial[key];
        if (value !== undefined) next[key] = clamp01(value);
      }
      const sources = { ...get().sources, [source]: next };
      set({ sources, values: combine(sources) });
    },
    clear: (source) => {
      const sources = { ...get().sources, [source]: NO_EFFECTS };
      set({ sources, values: combine(sources) });
    },
    clearAll: () => {
      set({ sources: emptySources(), values: NO_EFFECTS });
    },
  }));
}

export const pageEffectsStore = createPageEffectsStore();

export function usePageEffectsStore<T>(selector: (state: PageEffectsState) => T): T {
  return useStore(pageEffectsStore, selector);
}
