import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ParchmentPageSource, type ParchmentSourceDeps } from '../../src/book/ParchmentPageSource';
import { createPageSourceRegistry } from '../../src/book/pageSource';
import { recordingCanvas } from '../helpers/recordingCanvas';

const flush = async () => {
  for (let i = 0; i < 8; i += 1) await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
};

/** Waits until a face is drawn: the endpaper's marbling takes many turns of the event loop (one slice of rows per turn). */
async function untilReady(source: ParchmentPageSource, face: 'endpaper' | 'flyleaf' | 'bookplate' | 'blank') {
  for (let turn = 0; turn < 400 && !source.isReady(face); turn += 1) await flush();
}

const bookDocument = {
  filename: 'تقرير سنوي.pdf',
  pageCount: 12,
  languages: [{ code: 'ar', share: 1 }],
  primaryLanguage: 'ar',
  createdAt: '2026-03-14T09:30:00.000Z',
};

let loadedFonts: string[];
let fontCallbacks: (() => void)[];
let recorder: ReturnType<typeof recordingCanvas>;

function makeSource(overrides: Partial<ParchmentSourceDeps> = {}): ParchmentPageSource {
  return new ParchmentPageSource({
    pageWidth: 400,
    createCanvas: recorder.create,
    loadFont: (font) => {
      loadedFonts.push(font);
      return Promise.resolve([]);
    },
    onFontsLoaded: (callback) => {
      fontCallbacks.push(callback);
      return () => undefined;
    },
    ...overrides,
  });
}

beforeEach(() => {
  loadedFonts = [];
  fontCallbacks = [];
  recorder = recordingCanvas();
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('ParchmentPageSource', () => {
  it('draws its four faces on demand and reports readiness only once they are drawn', async () => {
    const source = makeSource();
    expect(source.isReady('blank')).toBe(false);
    expect(source.getTexture('blank')).toBeNull(); // starts drawing; plain parchment is shown meanwhile
    await flush();
    expect(source.isReady('blank')).toBe(true);
    expect(source.getTexture('blank')).not.toBeNull();
    source.request(['flyleaf', 'endpaper', 'bookplate']);
    await untilReady(source, 'endpaper');
    for (const face of ['flyleaf', 'endpaper', 'bookplate', 'blank'] as const)
      expect(source.isReady(face), face).toBe(true);
  });

  it('draws the endpaper a slice of rows per turn of the event loop, never in one task, and the page is not blocked meanwhile', async () => {
    const source = makeSource({ pageWidth: 400 });
    let turns = 0;
    const busy = { ticking: true };
    // Something else that wants the main thread: it must get a turn between the slices.
    const other = (async () => {
      while (busy.ticking) {
        await new Promise((resolve) => setTimeout(resolve, 0));
        turns += 1;
      }
    })();
    source.request(['endpaper']);
    expect(source.isReady('endpaper')).toBe(false);
    await untilReady(source, 'endpaper');
    busy.ticking = false;
    await other;
    expect(source.isReady('endpaper')).toBe(true);
    // 300 x 428 px: 40 rows (12 000 pixels) a slice, so a dozen or more turns, each of them shared with the rest of the page.
    expect(turns).toBeGreaterThan(10);
  });

  it('shows a stand-in for the endpaper while it is drawn (one texture, the same each time), then the real one; other faces still show nothing until ready', async () => {
    const source = makeSource({ pageWidth: 400 });
    const stand = source.getTexture('endpaper');
    expect(stand).not.toBeNull();
    expect(source.getTexture('endpaper')).toBe(stand);
    expect(source.isReady('endpaper')).toBe(false);
    expect(source.getTexture('flyleaf')).toBeNull();
    expect(source.getTexture('bookplate')).toBeNull();
    await untilReady(source, 'endpaper');
    const real = source.getTexture('endpaper');
    expect(real).not.toBeNull();
    expect(real).not.toBe(stand);
    const dispose = vi.spyOn(stand!, 'dispose');
    source.dispose();
    expect(dispose).toHaveBeenCalled();
    expect(source.getTexture('endpaper')).toBeNull();
  });

  it('marks the moment a face is on the page (User Timing), for the end to end test', async () => {
    const mark = vi.spyOn(performance, 'mark');
    const source = makeSource({ pageWidth: 400 });
    source.request(['blank', 'endpaper']);
    await untilReady(source, 'endpaper');
    const names = mark.mock.calls.map((call) => call[0]);
    expect(names).toContain('diary:face-ready:endpaper');
    expect(names).toContain('diary:face-ready:blank');
    mark.mockRestore();
  });

  it('a slice that throws is logged with the face\'s name, the face is cleared for a retry (it does not stay "drawing" for good), and the retry draws it', async () => {
    let fail = true;
    const putImageData = vi.fn(() => {
      if (fail) throw new Error('the canvas is gone');
    });
    const source = makeSource({
      createCanvas: (width, height) => {
        const real = recorder.create(width, height);
        const context = new Proxy(real.getContext('2d') as object, {
          get: (target, key): unknown => (key === 'putImageData' ? putImageData : Reflect.get(target, key)),
        });
        return { width, height, getContext: () => context } as unknown as HTMLCanvasElement;
      },
    });
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    source.request(['endpaper']);
    for (let turn = 0; turn < 400 && error.mock.calls.length === 0; turn += 1) await flush();
    expect(error).toHaveBeenCalledTimes(1);
    expect(String(error.mock.calls[0]?.[0])).toContain('endpaper');
    expect(source.isReady('endpaper')).toBe(false);
    // Not stuck: asked again (as the book does when the spread changes), it is drawn, and this time it works.
    fail = false;
    source.request(['endpaper']);
    await untilReady(source, 'endpaper');
    expect(source.isReady('endpaper')).toBe(true);
    expect(error).toHaveBeenCalledTimes(1);
  });

  it('stops drawing the endpaper when the source is disposed in the middle of it (no texture, no error, nothing left to run)', async () => {
    const source = makeSource({ pageWidth: 400 });
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    source.request(['endpaper']);
    await flush();
    await flush();
    const callsAtDispose = recorder.calls.length;
    const canvasesAtDispose = recorder.canvases.length;
    source.dispose();
    for (let turn = 0; turn < 60; turn += 1) await flush();
    // Drawing stopped with the source: nothing more was drawn on any canvas, and no canvas was made (the sheet would
    // have put its image and its grain down by now if the slices had gone on).
    expect(recorder.calls.length).toBe(callsAtDispose);
    expect(recorder.canvases.length).toBe(canvasesAtDispose);
    expect(recorder.calls.some((call) => call.name === 'putImageData')).toBe(false);
    expect(source.isReady('endpaper')).toBe(false);
    expect(source.getTexture('endpaper')).toBeNull();
    expect(error).not.toHaveBeenCalled();
  });

  it('does not draw PDF pages: a page number shows plain parchment, and is ready when that is', async () => {
    const source = makeSource();
    expect(source.isReady(2)).toBe(false);
    source.request([1, 2, 3]);
    await flush();
    expect(source.isReady(2)).toBe(true);
    expect(source.getTexture(1)).toBe(source.getTexture('blank'));
  });

  it('loads the web fonts for the text before drawing it', async () => {
    const source = makeSource();
    source.request(['flyleaf']);
    await flush();
    expect(loadedFonts).toEqual(['64px "Petit Formal Script"']);
    const fillTextAt = recorder.calls.findIndex((call) => call.name === 'fillText');
    expect(fillTextAt).toBeGreaterThanOrEqual(0);
  });

  it('draws the invitation in Arabic, right to left, in the Arabic hand', async () => {
    const source = makeSource({ language: 'ar' });
    source.request(['flyleaf']);
    await flush();
    expect(loadedFonts).toEqual(['64px "Aref Ruqaa"']);
    expect(recorder.calls.some((call) => call.name === 'direction:rtl')).toBe(true);
  });

  it('draws the diary invitation text of the interface language', async () => {
    const source = makeSource();
    source.request(['flyleaf']);
    await flush();
    const text = recorder.calls
      .filter((call) => call.name === 'fillText')
      .map((call) => String(call.args[0]))
      .join(' ');
    expect(text).toContain('Place your document within.'.split(' ')[0]);
  });

  it('writes the bookplate with the sanitised name, drawn right to left for an Arabic name', async () => {
    const source = makeSource({ document: { ...bookDocument, filename: 'تقرير\u202e سنوي.pdf' } });
    source.request(['bookplate']);
    await flush();
    const drawn = recorder.calls
      .filter((call) => call.name === 'fillText')
      .map((call) => String(call.args[0]));
    expect(drawn.some((text) => text.includes('\u202e'))).toBe(false);
    expect(drawn.some((text) => text.includes('ت'))).toBe(true);
    expect(recorder.calls.some((call) => call.name === 'direction:rtl')).toBe(true);
    expect(loadedFonts.some((font) => font.includes('Amiri'))).toBe(true);
  });

  it('draws the bookplate again when the document or the language changes', async () => {
    const source = makeSource({ document: bookDocument });
    const listener = vi.fn();
    source.subscribe(listener);
    source.request(['bookplate', 'flyleaf']);
    await flush();
    const first = source.getTexture('bookplate');
    listener.mockClear();
    source.setDocument({ ...bookDocument, pageCount: 80 });
    await flush();
    expect(listener).toHaveBeenCalled();
    expect(source.getTexture('bookplate')).toBe(first); // same texture object, repainted in place
    expect(first?.version).toBeGreaterThan(0);
    listener.mockClear();
    source.setLanguage('ar');
    await flush();
    expect(listener).toHaveBeenCalled();
  });

  it('repaints the faces with text when more fonts finish loading', async () => {
    const source = makeSource();
    source.request(['flyleaf', 'blank']);
    await flush();
    const drawsBefore = recorder.calls.filter((call) => call.name === 'fillText').length;
    for (const callback of fontCallbacks) callback();
    await flush();
    expect(recorder.calls.filter((call) => call.name === 'fillText').length).toBeGreaterThan(drawsBefore);
  });

  it('notifies subscribers when a face becomes available, and not after dispose', async () => {
    const source = makeSource();
    const listener = vi.fn();
    const stop = source.subscribe(listener);
    source.request(['blank']);
    await flush();
    expect(listener).toHaveBeenCalledTimes(1);
    stop();
    source.request(['endpaper']);
    await untilReady(source, 'endpaper');
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('dispose releases the textures and stops drawing', async () => {
    const source = makeSource();
    source.request(['blank']);
    await flush();
    const texture = source.getTexture('blank');
    const dispose = vi.spyOn(texture!, 'dispose');
    source.dispose();
    expect(dispose).toHaveBeenCalled();
    source.request(['flyleaf']);
    await flush();
    expect(source.isReady('flyleaf')).toBe(false);
  });

  it('survives a canvas without a 2D context (the face simply stays unavailable)', async () => {
    const source = makeSource({
      createCanvas: () => ({ width: 1, height: 1, getContext: () => null }) as unknown as HTMLCanvasElement,
    });
    source.request(['blank']);
    await flush();
    expect(source.isReady('blank')).toBe(false);
  });

  it('a font that fails to load does not stop the face being drawn, and is reported (once), not swallowed', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const source = makeSource({ loadFont: () => Promise.reject(new Error('no font')) });
    source.request(['flyleaf']);
    await flush();
    expect(source.isReady('flyleaf')).toBe(true);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain('Petit Formal Script');
    // The same failing font, asked for again by a later redraw, is not reported again.
    for (const callback of fontCallbacks) callback();
    await flush();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('draws the text-bearing faces at the page texture width and the plain ones smaller', async () => {
    const source = makeSource({ pageWidth: 1000 });
    source.request(['flyleaf', 'blank', 'endpaper']);
    await untilReady(source, 'endpaper');
    const widths = recorder.canvases.map((canvas) => canvas.width);
    expect(widths).toContain(1000);
    expect(widths).toContain(600);
    expect(source.getTexture('flyleaf')?.image).toMatchObject({ width: 1000, height: 1400 });
  });
});

describe('the margin on the side of the binding', () => {
  const textX = (calls: typeof recorder.calls): number[] =>
    calls.filter((call) => call.name === 'fillText').map((call) => Number(call.args[1]));

  it('keeps the invitation a little toward the fore-edge: to the right for LTR, to the left for RTL', async () => {
    const ltr = makeSource({ direction: 'ltr' });
    ltr.request(['flyleaf']);
    await flush();
    const ltrX = textX(recorder.calls);
    expect(ltrX.length).toBeGreaterThan(0);
    for (const x of ltrX) expect(x).toBeGreaterThan(200);
    recorder = recordingCanvas();
    const rtl = makeSource({ direction: 'rtl' });
    rtl.request(['flyleaf']);
    await flush();
    for (const x of textX(recorder.calls)) expect(x).toBeLessThan(200);
  });

  it('draws again when the layout direction changes', async () => {
    const source = makeSource({ direction: 'ltr' });
    source.request(['bookplate', 'flyleaf']);
    await flush();
    const drawsBefore = textX(recorder.calls).length;
    source.setDirection('rtl');
    await flush();
    expect(textX(recorder.calls).length).toBeGreaterThan(drawsBefore);
    const lastX = textX(recorder.calls).at(-1) ?? 0;
    expect(lastX).toBeLessThan(200);
  });
});

describe('the page source registry', () => {
  it('holds the current source and tells subscribers when it is replaced', () => {
    const registry = createPageSourceRegistry();
    const listener = vi.fn();
    registry.subscribe(listener);
    const source = makeSource();
    registry.set(source);
    expect(registry.get()).toBe(source);
    expect(listener).toHaveBeenCalledTimes(1);
    registry.set(source);
    expect(listener).toHaveBeenCalledTimes(1);
    registry.set(null);
    expect(registry.get()).toBeNull();
  });
});
