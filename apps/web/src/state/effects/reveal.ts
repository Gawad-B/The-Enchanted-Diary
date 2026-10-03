import type { NormalizedRect } from '@enchanted/shared';
import { exchangesOf } from '../../diarypage/exchanges';
import { pageImageService, type PageImageRenderer, type RenderJob } from '../../pdf/pageImageService';
import { startRevealClock, type ClockOptions, type RevealClock } from '../../reveal/clock';
import { revealStore, type RevealStore, type TruthPage } from '../../reveal/revealStore';
import type { Beat, BeatPosition } from '../../reveal/timeline';
import { resetRevealZoom, setRevealZoom } from '../../scene/revealZoom';
import { chatStore, type ChatStore } from '../chatStore';
import { diaryBookStore, type DiaryBookStore } from '../diaryBook';
import { doneEventFor, experienceStore, type ExperienceStore, type Phase } from '../experience';
import { pageEffectsStore, type PageEffectsStore } from '../pageEffectsStore';
import { readerStore, type ReaderStore } from '../readerStore';
import { settingsStore, type SettingsStore } from '../settingsStore';

/*
 * "Show me the truth": the scene's conductor. One rAF clock (reveal/clock.ts) runs the beats: the diary writes its line (the
 * book is still on the diary page), then the experience enters `revealing` while the book riffles to the cited page, the camera
 * zooms in and out, and the cited page appears with the passage glowing; the last beat (or a skip) dispatches REVEAL_DONE, so
 * `revealing` never ends only through the watchdog. There is no network in it: the pages and the passage come from the answer's
 * own citations, and the picture of the page from the page image service.
 */

/** The width the cited page is drawn at (the memory shows it large, but never wider than this). */
const PAGE_IMAGE_WIDTH = 1100;
/** How far the page's colour is pulled toward the memory's sepia at the peak (the book's `memoryPull`). */
const MEMORY_PULL = 0.6;

const easeInOut = (t: number): number => t * t * (3 - 2 * t);

export interface RevealDeps {
  experience: Pick<ExperienceStore, 'getState' | 'subscribe'>;
  reveal: RevealStore;
  reader: Pick<ReaderStore, 'getState'>;
  diary: Pick<DiaryBookStore, 'getState'>;
  effects: Pick<PageEffectsStore, 'getState'>;
  settings: Pick<SettingsStore, 'getState'>;
  chat: Pick<ChatStore, 'getState'>;
  images: PageImageRenderer;
  /** Replaceable in tests (a fake clock). */
  startClock: (options: ClockOptions) => RevealClock;
}

const defaults = (): RevealDeps => ({
  experience: experienceStore,
  reveal: revealStore,
  reader: readerStore,
  diary: diaryBookStore,
  effects: pageEffectsStore,
  settings: settingsStore,
  chat: chatStore,
  images: pageImageService,
  startClock: startRevealClock,
});

/** The pages an answer rests on: the cited ones in the order cited (else the consulted ones), else page 1. */
export function truthPagesOf(
  chips: readonly { pageStart: number; rects: NormalizedRect[]; kind: string }[],
): TruthPage[] {
  const cited = chips.filter((chip) => chip.kind === 'cited');
  const source = cited.length > 0 ? cited : chips;
  const seen = new Set<number>();
  const pages: TruthPage[] = [];
  for (const chip of source) {
    if (seen.has(chip.pageStart)) continue;
    seen.add(chip.pageStart);
    pages.push({ page: chip.pageStart, rects: chip.rects });
  }
  return pages.length > 0 ? pages : [{ page: 1, rects: [] }];
}

interface Running {
  clock: RevealClock;
  controller: AbortController;
  image: RenderJob | null;
  highlighted: boolean;
}

let current: {
  skip(): void;
  stop(): void;
  begin(exchangeId: string | null): boolean;
  dismiss(): void;
} | null = null;

/** Starts the scene for an answer (the exchange id), or for the latest answer when null; false when it cannot start now. */
export function beginTruth(exchangeId: string | null): boolean {
  return current?.begin(exchangeId) ?? false;
}

/** Skip: the cited page appears in 200 ms and the scene ends. */
export function skipTruth(): void {
  current?.skip();
}

/** "Return to my page": back to the diary page the visitor was writing on. */
export function dismissTruth(): void {
  current?.dismiss();
}

export function startRevealEffect(overrides: Partial<RevealDeps> = {}): () => void {
  const deps = { ...defaults(), ...overrides };
  const { experience, reveal, reader, diary, effects, settings, chat, images } = deps;
  let running: Running | null = null;

  const clearVisuals = (): void => {
    resetRevealZoom();
    effects.getState().clear('reveal');
  };

  const stopImage = (): void => {
    if (!running) return;
    running.controller.abort();
    running.controller = new AbortController();
    running.image = null;
  };

  const cleanup = (): void => {
    if (running) {
      running.clock.stop();
      running.controller.abort();
      if (running.highlighted) reader.getState().clearHighlight();
    }
    running = null;
    clearVisuals();
    reveal.getState().reset();
  };

  /** Draws the page in view (the service waits for the riffle to end, then renders). */
  const loadImage = (): void => {
    if (!running) return;
    stopImage();
    const { pages, index } = reveal.getState();
    const target = pages[index];
    if (!target) return;
    const mine = running;
    const job = images.enqueue({
      page: target.page,
      width: PAGE_IMAGE_WIDTH,
      priority: 0,
      highlight: target.rects,
      signal: mine.controller.signal,
    });
    mine.image = job;
    job.promise.then(
      (canvas) => {
        if (running !== mine || mine.image !== job) return;
        reveal.getState().setImage({ page: target.page, canvas });
      },
      (error: unknown) => {
        if (running !== mine || mine.image !== job) return;
        if (error instanceof DOMException && error.name === 'AbortError') return;
        reveal.getState().setImageFailed(true);
      },
    );
  };

  /** Turns the book to the page in view and makes its passage glow. */
  const showPage = (): void => {
    if (!running) return;
    const { pages, index } = reveal.getState();
    const target = pages[index];
    if (!target) return;
    reader.getState().goToPage(target.page);
    reader.getState().setHighlight(target.page, target.rects);
    running.highlighted = true;
    loadImage();
  };

  const onEnter = (beat: Beat): void => {
    if (!running) return;
    if (beat === 'riffle') {
      if (experience.getState().phase === 'manuscript') {
        // The diary page the visitor was on is remembered; the camera pulls back from it, and the book riffles to the page.
        diary.getState().leaveForCitation();
        experience.getState().dispatch({ type: 'REVEAL_TRIGGERED' });
      }
      const { pages, index } = reveal.getState();
      const target = pages[index];
      if (target) reader.getState().goToPage(target.page);
      loadImage();
    } else if (beat === 'zoomIn') {
      const { pages, index } = reveal.getState();
      const target = pages[index];
      if (target) {
        reader.getState().setHighlight(target.page, target.rects);
        running.highlighted = true;
      }
    }
  };

  const onFrame = (position: BeatPosition, dtMs: number): void => {
    const reduced = settings.getState().reducedMotionResolved;
    reveal.getState().setBeat(position.beat, position.t);
    if (reduced) return;
    let zoom = 0;
    let pull = 0;
    if (position.beat === 'zoomIn') {
      zoom = easeInOut(position.t);
      pull = MEMORY_PULL * zoom;
    } else if (position.beat === 'zoomOut') {
      zoom = 1 - easeInOut(position.t);
      pull = MEMORY_PULL;
    } else if (position.beat === 'page') {
      pull = MEMORY_PULL;
    }
    setRevealZoom(zoom, dtMs);
    effects.getState().set('reveal', { memoryPull: pull });
  };

  const onDone = (): void => {
    const { phase, epoch } = experience.getState();
    resetRevealZoom();
    if (phase !== 'revealing') return;
    const event = doneEventFor('revealing', epoch);
    if (event) experience.getState().dispatch(event);
  };

  const begin = (exchangeId: string | null, from?: Beat): boolean => {
    if (running) return false;
    const phase = experience.getState().phase;
    if (from === undefined && phase !== 'manuscript') return false;
    const exchanges = exchangesOf(chat.getState(), settings.getState().uiLanguage);
    const exchange =
      (exchangeId === null ? undefined : exchanges.find((entry) => entry.id === exchangeId)) ??
      [...exchanges].reverse().find((entry) => entry.chips.length > 0);
    const pages = truthPagesOf(exchange?.chips ?? []);
    reveal.getState().request(exchangeId);
    reveal
      .getState()
      .begin(pages, exchange?.language ?? settings.getState().uiLanguage, diary.getState().page);
    const reduced = settings.getState().reducedMotionResolved;
    const controller = new AbortController();
    const mine: Running = {
      clock: { skip: () => undefined, stop: () => undefined, finished: false },
      controller,
      image: null,
      highlighted: false,
    };
    running = mine;
    mine.clock = deps.startClock({ reducedMotion: reduced, from, onEnter, onFrame, onDone });
    return true;
  };

  const stopExperience = experience.subscribe((state, previous) => {
    if (state.epoch === previous.epoch) return;
    const phase: Phase = state.phase;
    if (phase === 'revealing') {
      // Entered from somewhere else (an old trigger phrase): the scene starts at the riffle, for the latest answer.
      if (!running) begin(null, 'riffle');
    } else if (phase === 'manuscript') {
      // Back from the memory by a way other than the ribbon: the scene is over. (While the line is written the phase is
      // still the manuscript and the scene is running: that is not a way back.)
      if (previous.phase === 'memory') cleanup();
    } else if (phase !== 'memory') {
      cleanup();
    }
  });

  const stopReveal = reveal.subscribe((state, previous) => {
    if (running && state.index !== previous.index) showPage();
  });

  current = {
    skip: () => {
      running?.clock.skip();
    },
    stop: cleanup,
    begin: (exchangeId) => begin(exchangeId),
    dismiss: () => {
      const returnTo = reveal.getState().returnTo;
      if (experience.getState().phase !== 'memory') return;
      experience.getState().dispatch({ type: 'MEMORY_DISMISSED' });
      reader.getState().clearHighlight();
      cleanup();
      diary.getState().startWriting(returnTo ?? undefined);
    },
  };

  if (experience.getState().phase === 'revealing') begin(null, 'riffle');

  return () => {
    stopExperience();
    stopReveal();
    cleanup();
    current = null;
  };
}
