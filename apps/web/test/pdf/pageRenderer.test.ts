import { afterEach, describe, expect, it, vi } from 'vitest';
import { PAGE_ASPECT } from '../../src/book/pageAspect';
import {
  BINDING_MARGIN,
  OUTER_MARGIN,
  fitPage,
  releaseParchmentCache,
  renderPage,
  zeroCanvas,
} from '../../src/pdf/pageRenderer';
import { canvasKit, fakeDocument, fakePage, orderedCanvasKit, settle } from './helpers';

afterEach(() => {
  releaseParchmentCache();
  vi.restoreAllMocks();
});

describe('fitPage (the letterbox)', () => {
  const A4 = { w: 595, h: 842 };

  it("keeps the leaf at the book's fixed aspect, whatever the page", () => {
    for (const [w, h] of [
      [595, 842],
      [842, 595],
      [300, 300],
      [100, 1000],
    ] as const) {
      const fit = fitPage(1200, w, h, 'left');
      expect(fit.width).toBe(1200);
      expect(fit.height).toBe(Math.round(1200 * PAGE_ASPECT));
    }
  });

  it("never stretches: the fitted page has the page's own aspect, inside the leaf and its margins", () => {
    for (const [w, h] of [
      [595, 842],
      [842, 595],
      [300, 300],
      [100, 1000],
      [1000, 100],
    ] as const) {
      for (const edge of ['left', 'right'] as const) {
        const fit = fitPage(1000, w, h, edge);
        expect(fit.w / fit.h).toBeCloseTo(w / h, 6);
        expect(fit.x).toBeGreaterThanOrEqual(1000 * Math.min(OUTER_MARGIN, BINDING_MARGIN) - 1e-9);
        expect(fit.y).toBeGreaterThanOrEqual(1000 * OUTER_MARGIN - 1e-9);
        expect(fit.x + fit.w).toBeLessThanOrEqual(1000 - 1000 * OUTER_MARGIN + 1e-9);
        expect(fit.y + fit.h).toBeLessThanOrEqual(fit.height - 1000 * OUTER_MARGIN + 1e-9);
      }
    }
  });

  it('fills the width of the leaf for a portrait A4 page (width is the limit) and leaves bands above and below a landscape one', () => {
    const portrait = fitPage(1000, A4.w, A4.h, 'left');
    expect(portrait.w).toBeCloseTo(1000 * (1 - OUTER_MARGIN - BINDING_MARGIN), 6);
    const landscape = fitPage(1000, A4.h, A4.w, 'left');
    expect(landscape.w).toBeCloseTo(1000 * (1 - OUTER_MARGIN - BINDING_MARGIN), 6);
    expect(landscape.y).toBeGreaterThan(portrait.y + 100);
  });

  it('keeps the wider margin on the side of the gutter', () => {
    const gutterLeft = fitPage(1000, A4.w, A4.h, 'left');
    const gutterRight = fitPage(1000, A4.w, A4.h, 'right');
    expect(gutterLeft.x).toBeCloseTo(1000 * BINDING_MARGIN, 6);
    expect(gutterRight.x).toBeCloseTo(1000 * OUTER_MARGIN, 6);
    expect(gutterLeft.x).toBeGreaterThan(gutterRight.x);
  });
});

describe('renderPage', () => {
  it('draws the page on the parchment with multiply blending, inside the leaf, and records a performance measure', async () => {
    const kit = canvasKit();
    const fake = fakePage(595, 842, { auto: true });
    const measure = vi.spyOn(performance, 'measure');
    const leaf = await renderPage(fakeDocument({ 3: fake.page }), 3, 800, new AbortController().signal, {
      createCanvas: kit.create,
    });
    expect(leaf.width).toBe(800);
    expect(leaf.height).toBe(Math.round(800 * PAGE_ASPECT));
    expect(fake.render).toHaveBeenCalledOnce();
    const params = fake.render.mock.calls[0]?.[0] as { canvas: unknown; viewport: { width: number } };
    expect(params.canvas).toBeDefined();
    // The page sheet is drawn at the fitted size, not at the leaf's.
    expect(params.viewport.width).toBeLessThan(800);
    const names = kit.names();
    // The parchment first, then (source-over) nothing, then the multiplied page, then back to normal.
    expect(names.filter((name) => name === 'drawImage')).toHaveLength(3);
    expect(fake.cleanup).toHaveBeenCalled();
    expect(measure).toHaveBeenCalledWith('pdf-render:3', expect.anything());
  });

  it('cleans the pdf.js page up after a render, unless the caller keeps it for the full pass that follows', async () => {
    const plain = fakePage(595, 842, { auto: true });
    await renderPage(fakeDocument({ 1: plain.page }), 1, 500, new AbortController().signal, {
      createCanvas: canvasKit().create,
    });
    expect(plain.cleanup).toHaveBeenCalledTimes(1);
    const kept = fakePage(595, 842, { auto: true });
    await renderPage(fakeDocument({ 1: kept.page }), 1, 400, new AbortController().signal, {
      createCanvas: canvasKit().create,
      keepPage: true,
    });
    expect(kept.cleanup).not.toHaveBeenCalled(); // the operator list and the images stay decoded for the full pass
  });

  it('cleans up even when it was asked to keep the page, if the render fails or is cancelled', async () => {
    const failing = fakePage(595, 842);
    const promise = renderPage(fakeDocument({ 1: failing.page }), 1, 400, new AbortController().signal, {
      createCanvas: canvasKit().create,
      keepPage: true,
    });
    await settle();
    failing.fail(new Error('bad stream'));
    await expect(promise).rejects.toThrow('bad stream');
    expect(failing.cleanup).toHaveBeenCalled();
  });

  it('multiplies the PDF page onto the parchment (the parchment is copied normally first, the multiply is the last draw)', async () => {
    const kit = orderedCanvasKit();
    await renderPage(
      fakeDocument({ 1: fakePage(595, 842, { auto: true }).page }),
      1,
      500,
      new AbortController().signal,
      {
        createCanvas: kit.create,
      },
    );
    const draws = kit.events.filter((event) => event.startsWith('drawImage'));
    // the parchment, the page, and the page again at a lower strength (the ink's dot gain: only the grey edges of glyphs darken)
    expect(draws).toEqual(['drawImage:source-over', 'drawImage:multiply', 'drawImage:multiply']);
    expect(kit.events.at(-1)).toBe('op:source-over'); // the blend mode is put back
  });

  it('puts the highlight glow UNDER the ink: before the multiply draw of the page', async () => {
    const kit = canvasKit();
    const fake = fakePage(600, 840, { auto: true });
    await renderPage(fakeDocument({ 1: fake.page }), 1, 600, new AbortController().signal, {
      createCanvas: kit.create,
      highlight: [{ x: 0.1, y: 0.2, w: 0.5, h: 0.05 }],
    });
    const calls = kit.calls.map((call) => call.name);
    const lastFill = calls.lastIndexOf('fillRect');
    const lastDraw = calls.lastIndexOf('drawImage');
    expect(lastFill).toBeGreaterThan(-1);
    expect(lastFill).toBeLessThan(lastDraw);
    // Without a highlight the leaf has one fewer fill after the parchment.
    const plain = canvasKit();
    await renderPage(
      fakeDocument({ 1: fakePage(600, 840, { auto: true }).page }),
      1,
      600,
      new AbortController().signal,
      {
        createCanvas: plain.create,
      },
    );
    expect(kit.calls.filter((c) => c.name === 'fillRect').length).toBeGreaterThan(
      plain.calls.filter((c) => c.name === 'fillRect').length,
    );
  });

  it('cancels the pdf.js render when the signal aborts, zeroes the sheet and rejects with an AbortError', async () => {
    const kit = canvasKit();
    const fake = fakePage(595, 842);
    const controller = new AbortController();
    const promise = renderPage(fakeDocument({ 2: fake.page }), 2, 500, controller.signal, {
      createCanvas: kit.create,
    });
    await settle();
    expect(fake.render).toHaveBeenCalledOnce();
    controller.abort();
    await expect(promise).rejects.toMatchObject({ name: 'AbortError' });
    expect(fake.cancel).toHaveBeenCalled();
    expect(fake.cleanup).toHaveBeenCalled();
    expect(kit.canvases[0]?.width).toBe(0); // the page sheet was zeroed
  });

  it('does not start a render when already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const getPage = vi.fn();
    await expect(renderPage({ numPages: 1, getPage }, 1, 500, controller.signal)).rejects.toMatchObject({
      name: 'AbortError',
    });
    expect(getPage).not.toHaveBeenCalled();
  });

  it('passes a pdf.js failure through', async () => {
    const kit = canvasKit();
    const fake = fakePage(595, 842);
    const promise = renderPage(fakeDocument({ 1: fake.page }), 1, 500, new AbortController().signal, {
      createCanvas: kit.create,
    });
    await settle();
    fake.fail(new Error('bad stream'));
    await expect(promise).rejects.toThrow('bad stream');
    expect(fake.cleanup).toHaveBeenCalled();
  });

  it('zeroCanvas releases the pixels', () => {
    const canvas = { width: 10, height: 20 } as HTMLCanvasElement;
    zeroCanvas(canvas);
    expect([canvas.width, canvas.height]).toEqual([0, 0]);
  });
});
