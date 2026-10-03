import type { Direction } from '@enchanted/shared';
import { createStore, useStore, type StoreApi } from 'zustand';
import { STRINGS, type Language } from '../i18n/strings';
import { anchorStore } from '../state/anchorStore';
import { chatStore } from '../state/chatStore';
import { MAX_DIARY_LEAVES } from '../state/diaryBook';
import { settingsStore } from '../state/settingsStore';
import { exchangesOf, type DiaryExchange } from './exchanges';
import { forgetMeasures, layoutDiary, type DiaryLayout, type Measure } from './layout';
import { canvasMeasure, loadDiaryFonts, onFontsLoaded } from './measure';

/*
 * The diary's pages, kept laid out. One place works out where every line of the conversation goes (from the chat, the interface
 * language, the direction of the book and the fonts that are loaded), and everyone who draws a page reads it: the surface the
 * reader writes on, the texture of the 3D page, and the book that binds one leaf for each page.
 */

export interface DiaryLayoutState {
  layout: DiaryLayout;
  /** The exchanges the pages hold (the oldest ones that did not fit are not in it), the one being written last. */
  exchanges: readonly DiaryExchange[];
  /** How many of the oldest exchanges are no longer on a page: they are in the accessible log only. */
  dropped: number;
  /** Counts the times the layout was worked out again (a cheap way to know a page may have changed). */
  revision: number;
  set: (next: Pick<DiaryLayoutState, 'layout' | 'exchanges' | 'dropped'>) => void;
}

export type DiaryLayoutStore = StoreApi<DiaryLayoutState>;

const EMPTY: DiaryLayout = {
  pages: [{ index: 0, lines: [], notes: [] }],
  spans: {},
  next: { page: 0, row: 0 },
  pageCount: 1,
};

export function createDiaryLayoutStore(): DiaryLayoutStore {
  return createStore<DiaryLayoutState>()((set) => ({
    layout: EMPTY,
    exchanges: [],
    dropped: 0,
    revision: 0,
    set: (next) => {
      set((state) => ({ ...next, revision: state.revision + 1 }));
    },
  }));
}

export const diaryLayoutStore = createDiaryLayoutStore();

export function useDiaryLayout<T>(selector: (state: DiaryLayoutState) => T): T {
  return useStore(diaryLayoutStore, selector);
}

export interface DiaryComputation {
  layout: DiaryLayout;
  exchanges: DiaryExchange[];
  dropped: number;
}

/**
 * The layout of the conversation on at most `maxPages` pages: when it needs more, the oldest exchange goes off the pages (it
 * stays in the accessible log) until the rest fits. The exchange being written is never dropped.
 */
export function computeDiary(
  chat: Parameters<typeof exchangesOf>[0],
  language: Language,
  book: Direction,
  measure: Measure,
  maxPages = MAX_DIARY_LEAVES,
): DiaryComputation {
  let exchanges = exchangesOf(chat, language);
  let dropped = 0;
  const options = {
    book,
    measure,
    heading: {
      text: STRINGS[language].diary.heading,
      faces: language === 'ar' ? ('arabic' as const) : ('latin' as const),
    },
  };
  let layout = layoutDiary(exchanges, options);
  while (layout.pageCount > maxPages && exchanges.length > 1) {
    exchanges = exchanges.slice(1);
    dropped += 1;
    layout = layoutDiary(exchanges, options);
  }
  return { layout, exchanges, dropped };
}

export interface ServiceDeps {
  store?: DiaryLayoutStore;
  measure?: Measure;
  /** Loads the fonts of a script before text is measured (resolves when they are there). */
  loadFonts?: (script: 'latin' | 'arabic') => Promise<unknown>;
  onFontsLoaded?: (callback: () => void) => () => void;
}

/** A cheap fingerprint of the parts of the conversation that decide the layout (the token that just arrived changes it; a heartbeat does not). */
function signature(chat: ReturnType<typeof chatStore.getState>): string {
  const { turn } = chat;
  const parts = [String(chat.messages.length), chat.messages.at(-1)?.id ?? ''];
  if (turn) {
    parts.push(
      turn.id,
      String(turn.attempt),
      turn.status,
      String(turn.text.length),
      String(turn.hidden),
      String(turn.citations.length),
      String(turn.consulted.length),
      String(turn.citationsReceived),
      turn.done ? `${turn.done.mode}:${String(turn.done.grounded)}:${String(turn.done.truncated)}` : '-',
      turn.error?.code ?? '-',
    );
  }
  return parts.join('|');
}

/**
 * Keeps the diary layout store current: works it out now and again whenever the conversation, the interface language, the
 * direction of the book or the loaded fonts change. Returns the way to stop. The fonts are loaded first (the faces of the
 * interface language, and of Arabic when the conversation has Arabic in it), so the measures are those of the faces that are drawn.
 */
export function startDiaryLayout(deps: ServiceDeps = {}): () => void {
  const store = deps.store ?? diaryLayoutStore;
  const measure = deps.measure ?? canvasMeasure;
  const load = deps.loadFonts ?? ((script: 'latin' | 'arabic') => loadDiaryFonts(script));
  const watch = deps.onFontsLoaded ?? onFontsLoaded;
  let stopped = false;
  let lastSignature = '';
  const loaded = new Set<string>();

  const recompute = (): void => {
    if (stopped) return;
    const chat = chatStore.getState();
    const result = computeDiary(
      chat,
      settingsStore.getState().uiLanguage,
      anchorStore.getState().layoutDirection,
      measure,
    );
    // Arabic faces are loaded when there is Arabic to write (the interface language's own faces always are).
    const scripts = new Set<'latin' | 'arabic'>([
      settingsStore.getState().uiLanguage === 'ar' ? 'arabic' : 'latin',
    ]);
    for (const exchange of result.exchanges) {
      scripts.add(exchange.questionFaces);
      scripts.add(exchange.answerFaces);
    }
    for (const script of scripts) {
      if (loaded.has(script)) continue;
      loaded.add(script);
      void Promise.resolve(load(script)).then(() => {
        // The faces are there now: what was measured with their stand-ins is measured again.
        forgetMeasures(measure);
        recompute();
      });
    }
    store.getState().set(result);
  };

  recompute();
  const stopChat = chatStore.subscribe((state) => {
    const next = signature(state);
    if (next === lastSignature) return;
    lastSignature = next;
    recompute();
  });
  const stopSettings = settingsStore.subscribe((state, previous) => {
    if (state.uiLanguage !== previous.uiLanguage) recompute();
  });
  const stopAnchors = anchorStore.subscribe((state, previous) => {
    if (state.layoutDirection !== previous.layoutDirection) recompute();
  });
  const stopFonts = watch(() => {
    forgetMeasures(measure);
    recompute();
  });
  return () => {
    stopped = true;
    stopChat();
    stopSettings();
    stopAnchors();
    stopFonts();
  };
}
