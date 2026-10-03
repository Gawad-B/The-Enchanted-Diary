import type { Citation } from '@enchanted/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PageImageRenderer, RenderRequest } from '../../src/pdf/pageImageService';
import { startRevealClock } from '../../src/reveal/clock';
import { createRevealStore } from '../../src/reveal/revealStore';
import { beatDurations } from '../../src/reveal/timeline';
import { revealZoom } from '../../src/scene/revealZoom';
import { createChatStore } from '../../src/state/chatStore';
import { createDiaryBookStore } from '../../src/state/diaryBook';
import {
  beginTruth,
  dismissTruth,
  skipTruth,
  startRevealEffect,
  truthPagesOf,
} from '../../src/state/effects/reveal';
import { createExperienceStore, type ExperienceEvent } from '../../src/state/experience';
import { createPageEffectsStore } from '../../src/state/pageEffectsStore';
import { createReaderStore } from '../../src/state/readerStore';
import { createSettingsStore } from '../../src/state/settingsStore';
import { startWatchdogs } from '../../src/state/watchdogs';

const citation = (page: number, rect = { x: 0.1, y: 0.2, w: 0.5, h: 0.05 }): Citation => ({
  marker: 'S1',
  chunkId: `chunk-${String(page)}`,
  pageStart: page,
  pageEnd: page,
  sectionTitle: null,
  snippet: 'x',
  language: 'en',
  direction: 'ltr',
  highlights: [{ page, rects: [rect] }],
});

function setup(options: { reduced?: boolean; citations?: Citation[]; question?: string } = {}) {
  const experience = createExperienceStore({ phase: 'manuscript', sessionChecked: true, epoch: 3 });
  const reveal = createRevealStore();
  const reader = createReaderStore({ pageCount: 40, hasDocument: true, spread: 1 });
  const diary = createDiaryBookStore();
  diary.getState().setLeaves(2);
  diary.getState().startWriting(1);
  const effects = createPageEffectsStore();
  const settings = createSettingsStore({
    storage: null,
    matchMedia: null,
    language: 'en',
  });
  settings.getState().setReducedMotion(options.reduced ? 'reduce' : 'no-preference');
  const chat = createChatStore();
  chat.getState().setMessages([
    {
      id: 'q1',
      role: 'user',
      kind: 'question',
      content: options.question ?? 'Who wrote it?',
      citations: [],
      createdAt: '2026-10-01T10:00:00.000Z',
    },
    {
      id: 'a1',
      role: 'assistant',
      kind: 'answer',
      content: 'Alaric wrote it [S1].',
      mode: 'answer',
      grounded: true,
      citations: options.citations ?? [citation(12), citation(30)],
      createdAt: '2026-10-01T10:00:01.000Z',
    },
  ]);
  const requests: RenderRequest[] = [];
  const canvas = document.createElement('canvas');
  const images: PageImageRenderer = {
    enqueue: (request) => {
      requests.push(request);
      return { promise: Promise.resolve(canvas), setPriority: () => undefined, cancel: () => undefined };
    },
  };
  const dispatched: ExperienceEvent[] = [];
  const dispatch = experience.getState().dispatch;
  experience.setState({
    dispatch: (event) => {
      dispatched.push(event);
      dispatch(event);
    },
  });
  const stop = startRevealEffect({
    experience,
    reveal,
    reader,
    diary,
    effects,
    settings,
    chat,
    images,
    // A rAF substitute driven by the (fake) timers, so the real clock runs on real beat durations.
    startClock: (clockOptions) =>
      startRevealClock({
        ...clockOptions,
        now: () => Date.now(),
        requestFrame: (callback) => window.setTimeout(callback, 16),
        cancelFrame: (handle) => {
          window.clearTimeout(handle);
        },
      }),
  });
  return { experience, reveal, reader, diary, effects, requests, dispatched, stop, settings };
}

let stops: (() => void)[] = [];
beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});
afterEach(() => {
  for (const stop of stops) stop();
  stops = [];
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function run() {
  const h = setup();
  stops.push(h.stop);
  return h;
}

describe('truthPagesOf', () => {
  it('lists cited pages in order, each once, falling back to page 1', () => {
    const rect = { x: 0, y: 0, w: 1, h: 1 };
    expect(
      truthPagesOf([
        { pageStart: 5, rects: [rect], kind: 'cited' },
        { pageStart: 5, rects: [], kind: 'cited' },
        { pageStart: 9, rects: [], kind: 'consulted' },
        { pageStart: 7, rects: [], kind: 'cited' },
      ]).map((entry) => entry.page),
    ).toEqual([5, 7]);
    expect(truthPagesOf([{ pageStart: 9, rects: [], kind: 'consulted' }]).map((p) => p.page)).toEqual([9]);
    expect(truthPagesOf([])).toEqual([{ page: 1, rects: [] }]);
  });
});

describe('Show me the truth (the scene)', () => {
  it('writes the line first (the book is still on the diary page), then riffles to the first cited page', () => {
    const h = run();
    expect(beginTruth('q1')).toBe(true);
    expect(h.reveal.getState().pages.map((p) => p.page)).toEqual([12, 30]);
    vi.advanceTimersByTime(beatDurations(false).line - 100);
    expect(h.experience.getState().phase).toBe('manuscript');
    expect(h.reveal.getState().beat).toBe('line');
    expect(h.reader.getState().spread).toBe(1);

    vi.advanceTimersByTime(300);
    expect(h.experience.getState().phase).toBe('revealing');
    expect(h.reader.getState().spread).toBe(6); // page 12 is on spread 6
    expect(h.diary.getState().writing).toBe(false); // the camera pulled back from the diary page
    expect(h.diary.getState().returnTo).toBe(1);
    expect(h.requests[0]).toMatchObject({ page: 12, highlight: [{ x: 0.1, y: 0.2, w: 0.5, h: 0.05 }] });
  });

  it('zooms in then out (clamped), glows the passage, and ends in the memory with REVEAL_DONE; the watchdog never fires', async () => {
    const h = run();
    const watchdog = startWatchdogs({
      experience: h.experience,
      settings: h.settings,
      page: document,
    });
    stops.push(watchdog);
    beginTruth('q1');
    const d = beatDurations(false);
    let peak = 0;
    for (let elapsed = 0; elapsed < 5000; elapsed += 16) {
      vi.advanceTimersByTime(16);
      peak = Math.max(peak, revealZoom.value);
    }
    await Promise.resolve();
    expect(peak).toBeGreaterThan(0.1);
    expect(peak).toBeLessThanOrEqual(0.38);
    expect(revealZoom.value).toBe(0);
    expect(h.experience.getState().phase).toBe('memory');
    expect(h.reader.getState().highlight?.page).toBe(12);
    expect(h.effects.getState().values.memoryPull).toBeGreaterThan(0.3);
    expect(h.dispatched.filter((event) => event.type === 'REVEAL_DONE')).toHaveLength(1);
    // Long past the 7 s revealing limit: the watchdog added nothing.
    vi.advanceTimersByTime(20000);
    expect(h.dispatched.filter((event) => event.type === 'REVEAL_DONE')).toHaveLength(1);
    expect(d.page).toBeGreaterThan(0);
  });

  it('switching from the immersive to the simple view mid-reveal still completes it (the clock belongs to neither presenter)', () => {
    const h = run();
    beginTruth('q1');
    vi.advanceTimersByTime(2500);
    expect(h.experience.getState().phase).toBe('revealing');
    h.settings.getState().setView('simple');
    vi.advanceTimersByTime(3000);
    expect(h.experience.getState().phase).toBe('memory');
  });

  it('delivers the page picture and keeps it for the memory', async () => {
    const h = run();
    beginTruth('q1');
    vi.advanceTimersByTime(2000);
    await Promise.resolve();
    expect(h.reveal.getState().image?.page).toBe(12);
  });

  it('skip jumps to the page in 200 ms and still dispatches REVEAL_DONE', () => {
    const h = run();
    beginTruth('q1');
    vi.advanceTimersByTime(300);
    skipTruth();
    expect(h.experience.getState().phase).toBe('revealing');
    vi.advanceTimersByTime(260);
    expect(h.experience.getState().phase).toBe('memory');
    expect(h.dispatched.filter((event) => event.type === 'REVEAL_DONE')).toHaveLength(1);
    expect(h.reader.getState().highlight?.page).toBe(12);
  });

  it('reduced motion: a crossfade to the page with no zoom and no glow of the book', () => {
    const h = setup({ reduced: true });
    stops.push(h.stop);
    beginTruth('q1');
    vi.advanceTimersByTime(1100);
    expect(h.experience.getState().phase).toBe('memory');
    expect(revealZoom.value).toBe(0);
    expect(h.effects.getState().values.memoryPull).toBe(0);
  });

  it('several citations: next and previous page turn the book, highlight and picture to the other page', async () => {
    const h = run();
    beginTruth('q1');
    vi.advanceTimersByTime(5000);
    expect(h.experience.getState().phase).toBe('memory');
    h.reveal.getState().setIndex(1);
    await Promise.resolve();
    expect(h.reader.getState().highlight?.page).toBe(30);
    expect(h.requests.at(-1)?.page).toBe(30);
    expect(h.reader.getState().spread).toBe(15);
  });

  it('"Return to my page" goes back to the manuscript, clears the glow and starts writing on the same diary page', () => {
    const h = run();
    beginTruth('q1');
    vi.advanceTimersByTime(5000);
    dismissTruth();
    expect(h.experience.getState().phase).toBe('manuscript');
    expect(h.reader.getState().highlight).toBeNull();
    expect(h.diary.getState().writing).toBe(true);
    expect(h.diary.getState().page).toBe(1);
    expect(h.reveal.getState().pages).toEqual([]);
    expect(h.effects.getState().values.memoryPull).toBe(0);
  });

  it('an answer without citations shows page 1; an old trigger phrase (REVEAL_TRIGGERED) opens the same scene', () => {
    const h = setup({ citations: [] });
    stops.push(h.stop);
    h.experience.getState().dispatch({ type: 'REVEAL_TRIGGERED' });
    expect(h.reveal.getState().pages.map((p) => p.page)).toEqual([1]);
    vi.advanceTimersByTime(4000);
    expect(h.experience.getState().phase).toBe('memory');
  });

  it('leaving the scene by another route (the document is lost) stops it and clears everything', () => {
    const h = run();
    beginTruth('q1');
    vi.advanceTimersByTime(2500);
    h.experience.getState().dispatch({
      type: 'DOCUMENT_LOST',
      error: { code: 'DOCUMENT_NOT_FOUND', message: 'gone' },
    });
    expect(h.experience.getState().phase).toBe('closing');
    expect(h.reveal.getState().pages).toEqual([]);
    expect(revealZoom.value).toBe(0);
    vi.advanceTimersByTime(8000);
    expect(h.experience.getState().phase).toBe('closing');
  });

  it('does not start from another phase, or twice at once', () => {
    const h = run();
    expect(beginTruth('q1')).toBe(true);
    expect(beginTruth('q1')).toBe(false);
    h.experience.getState().dispatch({
      type: 'DOCUMENT_LOST',
      error: { code: 'DOCUMENT_NOT_FOUND', message: 'gone' },
    });
    expect(beginTruth('q1')).toBe(false);
  });
});
