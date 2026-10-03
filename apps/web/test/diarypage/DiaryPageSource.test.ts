import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DiaryPageSource, pageSignature } from '../../src/diarypage/DiaryPageSource';
import { layoutDiary, type ExchangeInput, type Measure } from '../../src/diarypage/layout';
import { createDiaryLayoutStore } from '../../src/diarypage/service';
import { createDiaryBookStore } from '../../src/state/diaryBook';
import { displayText, parseAnswer } from '../../src/ui/diary/format';
import { buildInkDoc } from '../../src/ui/diary/inkDoc';
import { recordingCanvas } from '../helpers/recordingCanvas';

/* The textures of the diary's own pages: drawn from the shared layout, without ink under the surface that shows it. */

const measure: Measure = (text) => text.length * 10;
const flush = async (): Promise<void> => {
  await new Promise((resolve) => setTimeout(resolve, 5));
};

function exchange(id: string, question: string, answer: string): ExchangeInput {
  return {
    id,
    question,
    answer: buildInkDoc(parseAnswer(displayText(answer, false), false)),
    leadUnits: 0,
    answerFaces: 'latin',
    questionFaces: 'latin',
    notes: [],
    noteFaces: 'latin',
  };
}

let recorder: ReturnType<typeof recordingCanvas>;
let layout: ReturnType<typeof createDiaryLayoutStore>;
let book: ReturnType<typeof createDiaryBookStore>;

function publish(exchanges: ExchangeInput[]): void {
  layout.getState().set({
    layout: layoutDiary(exchanges, { book: 'ltr', measure }),
    exchanges: [],
    dropped: 0,
  });
}

const texts = (): string[] =>
  recorder.calls.filter((call) => call.name === 'fillText').map((call) => String(call.args[0]));

function makeSource(): DiaryPageSource {
  return new DiaryPageSource({ pageWidth: 400, layout, book, createCanvas: recorder.create });
}

beforeEach(() => {
  recorder = recordingCanvas();
  layout = createDiaryLayoutStore();
  book = createDiaryBookStore();
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('DiaryPageSource', () => {
  it('draws a diary page on demand: nothing at first (plain parchment shows), then its texture', async () => {
    const source = makeSource();
    expect(source.isReady('diary:0')).toBe(false);
    expect(source.getTexture('diary:0')).toBeNull();
    await flush();
    expect(source.isReady('diary:0')).toBe(true);
    expect(source.getTexture('diary:0')).not.toBeNull();
    source.dispose();
  });

  it("has nothing for the faces of the manuscript or the plain ones: they are the parchment's and the PDF's", () => {
    const source = makeSource();
    for (const face of ['flyleaf', 'blank', 'endpaper', 'bookplate', 3] as const) {
      expect(source.getTexture(face)).toBeNull();
      expect(source.isReady(face)).toBe(false);
    }
    source.dispose();
  });

  it("writes the ink of the page's lines on it", async () => {
    publish([exchange('a', 'Who founded it?', 'Alaric Thornquist.')]);
    const source = makeSource();
    source.request(['diary:0']);
    await flush();
    const written = texts().join('|');
    expect(written).toContain('Who founded it?');
    expect(written).toContain('Alaric Thornquist.');
    source.dispose();
  });

  it('draws the page the reader is writing on without ink, and with it as soon as they let go', async () => {
    publish([exchange('a', 'Who?', 'Alaric.')]);
    const source = makeSource();
    source.request(['diary:0']);
    await flush();
    expect(texts()).toContain('Who?');
    recorder.calls.length = 0;
    book.getState().setLivePage(0);
    expect(texts()).toEqual([]); // redrawn blank under the surface
    book.getState().setLivePage(null);
    expect(texts()).toContain('Who?'); // and with its ink again at once
    source.dispose();
  });

  it('tells its listeners when a page changed, so the book draws it again', async () => {
    const source = makeSource();
    const listener = vi.fn();
    source.subscribe(listener);
    source.request(['diary:0']);
    await flush();
    expect(listener).toHaveBeenCalled();
    listener.mockClear();
    book.getState().setLivePage(0);
    expect(listener).toHaveBeenCalledTimes(1);
    source.dispose();
  });

  it('draws again only the pages whose lines changed when the layout does', async () => {
    publish([exchange('a', 'First?', 'One.')]);
    const source = makeSource();
    source.request(['diary:0', 'diary:1']);
    await flush();
    recorder.calls.length = 0;
    // The same layout again: nothing to draw.
    publish([exchange('a', 'First?', 'One.')]);
    expect(texts()).toEqual([]);
    // A new answer on the same page: that page is drawn again.
    publish([exchange('a', 'First?', 'One and two.')]);
    expect(texts().join('|')).toContain('One and two.');
    source.dispose();
  });

  it('never draws the live page with ink even when the layout changes under it', async () => {
    publish([exchange('a', 'Who?', 'Alaric.')]);
    const source = makeSource();
    source.request(['diary:0']);
    await flush();
    book.getState().setLivePage(0);
    recorder.calls.length = 0;
    publish([exchange('a', 'Who?', 'Alaric Thornquist, a mapmaker.')]);
    expect(texts()).toEqual([]);
    source.dispose();
  });

  it('draws the rules and margins on the other side when the direction of the book changes', async () => {
    const source = makeSource();
    source.request(['diary:0']);
    await flush();
    recorder.calls.length = 0;
    source.setDirection('rtl');
    expect(recorder.calls.some((call) => call.name === 'stroke')).toBe(true);
    source.dispose();
  });

  it('starts with the page the book already has as live', async () => {
    book.getState().setLivePage(0);
    publish([exchange('a', 'Who?', 'Alaric.')]);
    const source = makeSource();
    source.request(['diary:0']);
    await flush();
    expect(texts()).toEqual([]);
    source.dispose();
  });

  it('lets go of everything when disposed: no draw after, no listener called', async () => {
    const source = makeSource();
    const listener = vi.fn();
    source.subscribe(listener);
    source.request(['diary:2']);
    source.dispose();
    await flush();
    expect(listener).not.toHaveBeenCalled();
    expect(source.getTexture('diary:2')).toBeNull();
  });
});

describe('pageSignature', () => {
  it('is the same for the same lines and different when a word or a place changes', () => {
    const a = layoutDiary([exchange('a', 'Q?', 'One.')], { book: 'ltr', measure }).pages[0];
    const same = layoutDiary([exchange('a', 'Q?', 'One.')], { book: 'ltr', measure }).pages[0];
    const other = layoutDiary([exchange('a', 'Q?', 'Two.')], { book: 'ltr', measure }).pages[0];
    expect(pageSignature(a)).toBe(pageSignature(same));
    expect(pageSignature(a)).not.toBe(pageSignature(other));
    expect(pageSignature(undefined)).toBe('');
  });
});
