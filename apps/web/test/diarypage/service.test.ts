import type { Message } from '@enchanted/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { computeDiary, createDiaryLayoutStore, startDiaryLayout } from '../../src/diarypage/service';
import type { Measure } from '../../src/diarypage/layout';
import { anchorStore } from '../../src/state/anchorStore';
import { chatStore } from '../../src/state/chatStore';
import { settingsStore } from '../../src/state/settingsStore';

const measure: Measure = (text, font) => text.length * (font.includes('27px') ? 13 : 10);

const pair = (n: number, answer = 'An answer.'): Message[] => [
  {
    id: `00000000-0000-4000-8000-0000000${String(n).padStart(5, '0')}`,
    role: 'user',
    kind: 'question',
    content: `Question ${String(n)}?`,
    citations: [],
    createdAt: '2026-10-01T10:00:00.000Z',
  },
  {
    id: `00000000-0000-4000-8000-1000000${String(n).padStart(5, '0')}`,
    role: 'assistant',
    kind: 'answer',
    content: answer,
    mode: 'answer',
    grounded: true,
    citations: [],
    createdAt: '2026-10-01T10:00:00.000Z',
  },
];

const long = Array.from({ length: 40 }, (_, i) => `Sentence ${String(i)} of an answer that goes on.`).join(
  ' ',
);

beforeEach(() => {
  chatStore.getState().reset();
  anchorStore.getState().reset();
  settingsStore.setState({ uiLanguage: 'en' });
});
afterEach(() => {
  chatStore.getState().reset();
});

describe('computeDiary: the conversation on at most so many pages', () => {
  it('keeps everything while it fits', () => {
    const result = computeDiary({ messages: [...pair(1), ...pair(2)], turn: null }, 'en', 'ltr', measure, 8);
    expect(result.dropped).toBe(0);
    expect(result.exchanges).toHaveLength(2);
    expect(result.layout.pageCount).toBe(3);
  });

  it('lets the oldest exchanges go off the pages (they stay in the log) until the rest fits, never the one being written', () => {
    const messages = Array.from({ length: 10 }, (_, i) => pair(i, long)).flat();
    const all = computeDiary({ messages, turn: null }, 'en', 'ltr', measure, 100);
    expect(all.layout.pageCount).toBeGreaterThan(8);
    const result = computeDiary({ messages, turn: null }, 'en', 'ltr', measure, 8);
    expect(result.layout.pageCount).toBeLessThanOrEqual(8);
    expect(result.dropped).toBeGreaterThan(0);
    expect(result.exchanges.at(-1)?.question).toBe('Question 9?');
    expect(result.exchanges[0]?.question).not.toBe('Question 0?');
  });

  it('always keeps at least the last exchange, however long', () => {
    const result = computeDiary({ messages: pair(1, long.repeat(10)), turn: null }, 'en', 'ltr', measure, 2);
    expect(result.exchanges).toHaveLength(1);
  });
});

describe('startDiaryLayout: the layout kept current', () => {
  const noFonts = { loadFonts: () => Promise.resolve(), onFontsLoaded: () => () => undefined };

  it('works the layout out at once, and again when the conversation changes', () => {
    const store = createDiaryLayoutStore();
    const stop = startDiaryLayout({ store, measure, ...noFonts });
    expect(store.getState().layout.pageCount).toBe(1);
    const revision = store.getState().revision;
    chatStore.getState().setMessages(pair(1));
    expect(store.getState().exchanges).toHaveLength(1);
    expect(store.getState().revision).toBeGreaterThan(revision);
    stop();
  });

  it('a heartbeat of the stream (bytes with nothing to show) does not lay the page out again', () => {
    const store = createDiaryLayoutStore();
    const stop = startDiaryLayout({ store, measure, ...noFonts });
    const id = chatStore.getState().ask('Who?', 1000);
    expect(id).not.toBeNull();
    const revision = store.getState().revision;
    chatStore.getState().noteActivity(id ?? '', 5000);
    expect(store.getState().revision).toBe(revision);
    chatStore.getState().applyEvent(id ?? '', { type: 'token', text: 'Hello' }, 6000);
    expect(store.getState().revision).toBeGreaterThan(revision);
    stop();
  });

  it('works it out again when the interface language, the direction of the book or the loaded fonts change', () => {
    const store = createDiaryLayoutStore();
    let fontsLoaded: () => void = () => undefined;
    const stop = startDiaryLayout({
      store,
      measure,
      loadFonts: () => Promise.resolve(),
      onFontsLoaded: (callback) => {
        fontsLoaded = callback;
        return () => undefined;
      },
    });
    let revision = store.getState().revision;
    settingsStore.setState({ uiLanguage: 'ar' });
    expect(store.getState().revision).toBeGreaterThan(revision);
    revision = store.getState().revision;
    anchorStore.getState().setLayoutDirection('rtl');
    expect(store.getState().revision).toBeGreaterThan(revision);
    revision = store.getState().revision;
    fontsLoaded();
    expect(store.getState().revision).toBeGreaterThan(revision);
    stop();
  });

  it("loads the faces of each script once: the interface language's, and Arabic when there is Arabic to write", async () => {
    const store = createDiaryLayoutStore();
    const loadFonts = vi.fn((script: 'latin' | 'arabic'): Promise<void> => {
      return Promise.resolve(script).then(() => undefined);
    });
    const stop = startDiaryLayout({ store, measure, loadFonts, onFontsLoaded: () => () => undefined });
    expect(loadFonts).toHaveBeenCalledTimes(1);
    expect(loadFonts).toHaveBeenLastCalledWith('latin');
    chatStore
      .getState()
      .setMessages(pair(1).map((message, i) => (i === 0 ? { ...message, content: 'من؟' } : message)));
    expect(loadFonts).toHaveBeenCalledWith('arabic');
    chatStore.getState().setMessages([...pair(1), ...pair(2)]);
    expect(loadFonts.mock.calls.filter(([script]) => script === 'arabic')).toHaveLength(1);
    // When the faces have arrived the page is measured again with them.
    const revision = store.getState().revision;
    await Promise.resolve();
    await Promise.resolve();
    expect(store.getState().revision).toBeGreaterThan(revision);
    stop();
  });

  it('stops when told to', () => {
    const store = createDiaryLayoutStore();
    const stop = startDiaryLayout({ store, measure, ...noFonts });
    stop();
    const revision = store.getState().revision;
    chatStore.getState().setMessages(pair(1));
    expect(store.getState().revision).toBe(revision);
  });
});
