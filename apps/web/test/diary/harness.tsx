import type { AnswerStreamEvent, Citation, Conversation } from '@enchanted/shared';
import { act, cleanup, render } from '@testing-library/react';
import { vi } from 'vitest';
import { startDiaryPages } from '../../src/diarypage/controller';
import { anchorStore, type ScreenQuad } from '../../src/state/anchorStore';
import { chatStore } from '../../src/state/chatStore';
import { diaryBookStore } from '../../src/state/diaryBook';
import { startAskEffect } from '../../src/state/effects/ask';
import { startConversationEffect } from '../../src/state/effects/conversation';
import { experienceStore, initialExperienceState, type Phase } from '../../src/state/experience';
import { pageEffectsStore } from '../../src/state/pageEffectsStore';
import { readerStore } from '../../src/state/readerStore';
import { settingsStore } from '../../src/state/settingsStore';
import { DiaryWriting } from '../../src/ui/diary/DiaryWriting';
import { flyleafStore } from '../../src/ui/diary/flyleafStore';
import { setDraft } from '../../src/ui/diary/quillDraft';
import { DiaryMenu } from '../../src/ui/reader/DiaryMenu';
import { viewportInsetStore } from '../../src/state/viewportInset';
import { installFetch, json, type FetchCall } from '../helpers/network';
import { DOCUMENT_ID, makeDocument } from '../fixtures';

export const MESSAGE_ID = '0c9b1e52-4a0b-4f0f-b9f6-2f1d5c3a9e77';
export const CHUNK_ID = '5d0a3d1c-7f31-4c1e-8f7e-0d9d3a9d6b11';
const encoder = new TextEncoder();

export const frame = (event: AnswerStreamEvent): string => `data: ${JSON.stringify(event)}\n\n`;

export const citation = (over: Partial<Citation> = {}): Citation => ({
  marker: 'S1',
  chunkId: CHUNK_ID,
  pageStart: 12,
  pageEnd: 12,
  sectionTitle: 'The Founding',
  snippet: 'x',
  language: 'en',
  direction: 'ltr',
  highlights: [{ page: 12, rects: [{ x: 0.1, y: 0.2, w: 0.5, h: 0.05 }] }],
  ...over,
});

export const done = (
  over: Partial<Extract<AnswerStreamEvent, { type: 'done' }>> = {},
): AnswerStreamEvent => ({
  type: 'done',
  messageId: MESSAGE_ID,
  answer: 'It was founded in 1847 [S1].',
  mode: 'answer',
  grounded: true,
  refusedBy: null,
  timingsMs: { retrieval: 1, firstToken: 2, total: 3 },
  ...over,
});

export const retrieval: AnswerStreamEvent = {
  type: 'retrieval',
  query: 'Q',
  rewrittenQuery: null,
  searchedChunks: 312,
  retrievedChunks: 6,
  pages: [3, 7, 12],
  evidence: 'strong',
  timingsMs: { embed: 1, semantic: 2, lexical: 1, total: 5 },
};

/** An answer stream the test writes by hand. */
export function openStream() {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
  });
  return {
    response: new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } }),
    send: (...events: AnswerStreamEvent[]) => {
      for (const event of events) controller.enqueue(encoder.encode(frame(event)));
    },
    raw: (text: string) => {
      controller.enqueue(encoder.encode(text));
    },
    end: () => {
      controller.close();
    },
    break: () => {
      controller.error(new TypeError('network error'));
    },
  };
}

/** Where the two pages are on the screen, distinct so that a test can tell which one the surface lay on. */
export const RIGHT_PAGE: ScreenQuad = [
  { x: 700, y: 80 },
  { x: 1200, y: 90 },
  { x: 1260, y: 760 },
  { x: 690, y: 770 },
];
export const LEFT_PAGE: ScreenQuad = [
  { x: 140, y: 90 },
  { x: 640, y: 80 },
  { x: 650, y: 770 },
  { x: 80, y: 760 },
];

export interface HarnessOptions {
  phase?: Phase;
  /** The reader is not diving yet (the surface is not up). */
  idle?: boolean;
  width?: number;
  reduced?: boolean;
  direction?: 'ltr' | 'rtl';
  language?: 'en' | 'ar';
  conversation?: Conversation;
  routes?: Record<string, (call: FetchCall) => Response | Promise<Response>>;
}

const stops: (() => void)[] = [];

/** The real stores and effects, a mocked network, and the diary's page mounted, with the reader writing on it. */
export function mountDiary(options: HarnessOptions = {}) {
  const {
    phase = 'manuscript',
    width = 1400,
    reduced = true,
    direction = 'ltr',
    language = 'en',
    idle = false,
  } = options;
  vi.stubGlobal('innerWidth', width);
  window.innerWidth = width;
  settingsStore.setState({
    quality: 'auto',
    resolvedQuality: null,
    sound: false,
    reducedMotion: reduced ? 'reduce' : 'no-preference',
    systemReducedMotion: false,
    reducedMotionResolved: reduced,
    view: 'immersive',
    uiLanguage: language,
    forcedSimple: null,
  });
  chatStore.getState().reset();
  flyleafStore.getState().reset();
  diaryBookStore.getState().reset();
  viewportInsetStore.getState().setBottom(0);
  setDraft('');
  pageEffectsStore.getState().clearAll();
  anchorStore.getState().reset();
  anchorStore.getState().setLayoutDirection(direction);
  // The camera is at rest on the page: the surface may be shown.
  anchorStore.getState().setQuads({ leftPage: LEFT_PAGE, rightPage: RIGHT_PAGE });
  anchorStore.getState().setStable(true);
  readerStore.getState().reset();
  readerStore.getState().setNarrow(width < 720);
  readerStore.getState().setDocument(40, direction);
  readerStore.getState().goToSpread(2);
  experienceStore.setState({
    ...initialExperienceState,
    phase,
    sessionChecked: true,
    documentId: DOCUMENT_ID,
  });
  const fetchLog = installFetch({
    [`GET /api/documents/${DOCUMENT_ID}/conversation`]: () =>
      json(200, options.conversation ?? { documentId: DOCUMENT_ID, messages: [] }),
    ...options.routes,
  });
  stops.push(startAskEffect(), startConversationEffect(), startDiaryPages());
  // The controller dives on its own when the manuscript is there; a test that wants the page closed steps back.
  if (idle) diaryBookStore.getState().stopWriting();
  if (!idle) {
    // On the flyleaf the page is the flyleaf (no leaf is bound); in the manuscript, the diary's own page.
    if (phase === 'awaiting') diaryBookStore.getState().startWriting(undefined, { bindLeaf: false });
    else diaryBookStore.getState().startWriting();
  }
  const view = render(
    <>
      <DiaryWriting />
      <DiaryMenu />
    </>,
  );
  return { ...view, calls: fetchLog.calls };
}

export function unmountDiary(): void {
  cleanup();
  for (const stop of stops.splice(0)) stop();
  vi.unstubAllGlobals();
}

/** Lets pending promises and a few frames of the clock run (the answer stream is read asynchronously). */
export async function settle(ms = 50): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
}

export { makeDocument };
