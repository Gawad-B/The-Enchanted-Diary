import type { Texture } from 'three';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LeafFace } from '../../src/book/bookLayout';
import { visibleAndNearFaces } from '../../src/book/bookLayout';
import { createPageSourceRegistry, type PageTextureSource } from '../../src/book/pageSource';
import type { PageImageRenderer, RenderJob, RenderRequest } from '../../src/pdf/pageImageService';
import { createRenderGate } from '../../src/pdf/renderGate';
import { PdfPageSource, QUICK_WIDTH, type PdfPageSourceDeps } from '../../src/pdf/PdfPageSource';
import { settle } from './helpers';

interface FakeTexture {
  image: { width: number };
  needsUpdate: boolean;
  disposed: boolean;
  dispose(): void;
}

/** The page image service as the source sees it: jobs that finish when the test says so. */
function rendererDouble() {
  interface Job {
    request: RenderRequest;
    priority: number;
    cancelled: boolean;
    resolve(canvas: HTMLCanvasElement): void;
    reject(error: unknown): void;
  }
  const jobs: Job[] = [];
  const canvases: HTMLCanvasElement[] = [];
  const renderer: PageImageRenderer = {
    enqueue(request) {
      let job!: Job;
      const promise = new Promise<HTMLCanvasElement>((resolve, reject) => {
        job = { request, priority: request.priority, cancelled: false, resolve, reject };
      });
      jobs.push(job);
      const handle: RenderJob = {
        promise,
        setPriority: (priority) => {
          job.priority = priority;
        },
        cancel: () => {
          job.cancelled = true;
          job.reject(new DOMException('cancelled', 'AbortError'));
        },
      };
      return handle;
    },
  };
  const live = (page: number, width?: number): Job[] =>
    jobs.filter(
      (job) =>
        job.request.page === page && !job.cancelled && (width === undefined || job.request.width === width),
    );
  const finish = async (page: number, width?: number): Promise<void> => {
    const job = live(page, width)[0];
    if (!job) throw new Error(`no live job for page ${String(page)}`);
    const canvas = {
      width: job.request.width,
      height: Math.round(job.request.width * 1.4),
    } as HTMLCanvasElement;
    canvases.push(canvas);
    job.cancelled = true; // spent
    job.resolve(canvas);
    await settle(1);
  };
  return { renderer, jobs, canvases, live, finish };
}

let textures: FakeTexture[];
let parchmentListeners: (() => void)[];
let parchmentRequests: LeafFace[][];

const parchment: PageTextureSource = {
  id: 'parchment-double',
  getTexture: (face) => ({ face }) as unknown as Texture,
  isReady: (face) => face !== 'endpaper',
  request: (faces) => {
    parchmentRequests.push([...faces]);
  },
  subscribe: (listener) => {
    parchmentListeners.push(listener);
    return () => undefined;
  },
  dispose: () => undefined,
};

function makeSource(overrides: Partial<PdfPageSourceDeps> = {}, limits = { width: 1200, cache: 6 }) {
  const double = rendererDouble();
  const registry = createPageSourceRegistry();
  registry.set(parchment);
  const source = new PdfPageSource({
    parchment: { current: () => registry.get(), subscribe: registry.subscribe },
    renderer: double.renderer,
    pageCount: 40,
    direction: 'ltr',
    limits: () => limits,
    createTexture: (canvas) => {
      const texture: FakeTexture = {
        image: canvas,
        needsUpdate: false,
        disposed: false,
        dispose() {
          texture.disposed = true;
        },
      };
      textures.push(texture);
      return texture as unknown as Texture;
    },
    ...overrides,
  });
  source.setAvailability('ready');
  return { source, double, registry };
}

beforeEach(() => {
  textures = [];
  parchmentListeners = [];
  parchmentRequests = [];
});
afterEach(() => {
  vi.restoreAllMocks();
});

const alive = () => textures.filter((texture) => !texture.disposed);

describe('PdfPageSource: what it draws and what it hands to the parchment', () => {
  it('gives the faces that are not pages to the parchment source, and asks it for them', () => {
    const { source } = makeSource();
    expect(source.getTexture('flyleaf')).toEqual({ face: 'flyleaf' });
    expect(source.getTexture('bookplate')).toEqual({ face: 'bookplate' });
    expect(source.getTexture('endpaper')).toEqual({ face: 'endpaper' });
    expect(source.getTexture('blank')).toEqual({ face: 'blank' });
    expect(source.isReady('endpaper')).toBe(false);
    expect(source.isReady('blank')).toBe(true);
    source.request(['endpaper', 'bookplate', 1]);
    expect(parchmentRequests).toEqual([['endpaper', 'bookplate']]);
  });

  it('treats a number outside the document as plain parchment, not as a page to render', () => {
    const { source, double } = makeSource();
    expect(source.getTexture(99)).toEqual({ face: 99 });
    source.request([99, 0]);
    expect(double.jobs).toHaveLength(0);
  });

  it('follows a replaced parchment source (a remounted scene) and re-announces its textures', () => {
    const { source, registry } = makeSource();
    const listener = vi.fn();
    source.subscribe(listener);
    const next: PageTextureSource = {
      ...parchment,
      id: 'second',
      getTexture: () => ({ face: 'second' }) as unknown as Texture,
    };
    registry.set(next);
    expect(listener).toHaveBeenCalled();
    expect(source.getTexture('blank')).toEqual({ face: 'second' });
    const before = listener.mock.calls.length;
    parchmentListeners.at(-1)?.(); // the new parchment finished a face
    expect(listener.mock.calls.length).toBe(before + 1);
  });
});

describe('PdfPageSource: two passes', () => {
  it('draws a cheap pass first, then the full width, and is ready only with the full one', async () => {
    const { source, double } = makeSource();
    source.request([1, 2]);
    expect(double.live(1).map((job) => job.request.width)).toEqual([QUICK_WIDTH]);
    expect(source.getTexture(1)).toBeNull();
    expect(source.isReady(1)).toBe(false);

    await double.finish(1, QUICK_WIDTH);
    expect(source.getTexture(1)).not.toBeNull(); // something readable is on the leaf
    expect(source.isReady(1)).toBe(false);
    expect(double.live(1).map((job) => job.request.width)).toEqual([1200]);

    await double.finish(1, 1200);
    expect(source.isReady(1)).toBe(true);
    expect(alive()).toHaveLength(1); // the cheap texture was disposed when the full one replaced it
    expect(textures[0]?.disposed).toBe(true);
  });

  it('skips the cheap pass when the full width is no wider (the low tier)', () => {
    const { source, double } = makeSource({}, { width: 400, cache: 6 });
    source.request([1]);
    expect(double.live(1).map((job) => job.request.width)).toEqual([400]);
  });

  it('orders the passes: the cheap and then the full pass of the two faces in view, then those of the faces beyond', async () => {
    const { source, double } = makeSource();
    source.request([1, 2, 3, 4]);
    const priority = (page: number) => double.live(page)[0]?.priority ?? Number.NaN;
    const cheap = [1, 2, 3, 4].map(priority);
    expect(cheap).toEqual([...cheap].sort((a, b) => a - b)); // nearest first
    await double.finish(1, QUICK_WIDTH);
    const full = priority(1);
    // the full pass of a face in view goes before the cheap pass of ANY face beyond the two, and after the other in-view pass
    expect(cheap[1]).toBeLessThan(full);
    expect(full).toBeLessThan(cheap[2] ?? 0);
  });

  it('asks pdf.js to keep what it decoded after the cheap pass (the full pass uses it) and to clean up after the full one', async () => {
    const { source, double } = makeSource();
    source.request([1]);
    expect(double.live(1)[0]?.request.keepPage).toBe(true);
    await double.finish(1, QUICK_WIDTH);
    expect(double.live(1)[0]?.request.keepPage).toBe(false);
  });

  it('there is no urgent pass any more: nothing is asked to run during a turn', () => {
    const { source, double } = makeSource();
    source.request([1, 2, 3]);
    for (const job of double.jobs) expect('urgent' in job.request).toBe(false);
  });

  it('knows which edge of a page the gutter is on: an odd page of an LTR book is on the left, its gutter on its right; RTL mirrors', () => {
    const ltr = makeSource();
    ltr.source.request([1, 2]);
    expect(ltr.double.live(1)[0]?.request.bindingEdge).toBe('right');
    expect(ltr.double.live(2)[0]?.request.bindingEdge).toBe('left');
    const rtl = makeSource({ direction: 'rtl' });
    rtl.source.request([1, 2]);
    expect(rtl.double.live(1)[0]?.request.bindingEdge).toBe('left');
    expect(rtl.double.live(2)[0]?.request.bindingEdge).toBe('right');
  });
});

describe('PdfPageSource: the LRU cache', () => {
  async function fill(source: PdfPageSource, double: ReturnType<typeof rendererDouble>, pages: number[]) {
    source.request(pages);
    for (const page of pages) {
      await double.finish(page, QUICK_WIDTH);
      await double.finish(page, 1200);
    }
  }

  it('never keeps more textures alive than the cache size, however far the reader leafs', async () => {
    const { source, double } = makeSource({}, { width: 1200, cache: 6 });
    for (let spread = 1; spread <= 20; spread += 1) {
      const faces = visibleAndNearFaces(spread, 40, 2, true);
      source.request(faces);
      // finish whatever the source asked for, most urgent first
      for (const face of faces.slice(0, 6)) {
        if (typeof face !== 'number') continue;
        for (let pass = 0; pass < 2; pass += 1) {
          const job = double.live(face)[0];
          if (job) await double.finish(face, job.request.width);
        }
      }
      expect(alive().length).toBeLessThanOrEqual(6);
      expect(source.cachedPages.length).toBeLessThanOrEqual(6);
    }
    // every texture ever made and not alive was disposed (nothing leaked on the GPU)
    expect(textures.length).toBeGreaterThan(6);
    expect(alive()).toHaveLength(source.cachedPages.length);
  });

  it('evicts the least recently used page that is out of the window, disposes its texture and zeroes its canvas', async () => {
    const { source, double } = makeSource({}, { width: 1200, cache: 4 });
    await fill(source, double, [1, 2, 3, 4]);
    expect(source.cachedPages.sort()).toEqual([1, 2, 3, 4]);
    source.getTexture(1); // 1 is the most recently used
    source.getTexture(3);
    source.getTexture(4);
    source.request([10, 11]); // the window moved; 1..4 are out of it
    await double.finish(10, QUICK_WIDTH);
    await double.finish(10, 1200);
    // the oldest (page 2, never read again) went first
    expect(source.cachedPages).not.toContain(2);
    const evicted = textures.filter((texture) => texture.disposed && texture.image.width === 0);
    expect(evicted.length).toBeGreaterThan(0); // disposed, and its canvas zeroed
    await double.finish(11, QUICK_WIDTH);
    await double.finish(11, 1200);
    expect(alive().length).toBeLessThanOrEqual(4);
    // then page 1 (touched before 3 and 4) made room for page 11
    expect(source.cachedPages.sort((a, b) => a - b)).toEqual([3, 4, 10, 11]);
  });

  it('zeroes the canvas of an evicted texture', async () => {
    const { source, double } = makeSource({}, { width: 1200, cache: 2 });
    await fill(source, double, [1, 2]);
    const firstCanvas = textures.find((t) => t.image.width === 1200)?.image as { width: number };
    expect(firstCanvas.width).toBe(1200);
    source.request([5, 6]);
    await double.finish(5, QUICK_WIDTH);
    expect(source.cachedPages).toHaveLength(2);
    expect(firstCanvas.width).toBe(0);
  });

  it('never evicts a page of the current window to make room for one further away', async () => {
    const { source, double } = makeSource({}, { width: 1200, cache: 3 });
    source.request([1, 2, 3]);
    for (const page of [1, 2, 3]) {
      await double.finish(page, QUICK_WIDTH);
      await double.finish(page, 1200);
    }
    // a late render for a page that is no longer wanted finds no free place and is dropped
    source.request([1, 2, 3]);
    expect(source.cachedPages.sort()).toEqual([1, 2, 3]);
    expect(alive()).toHaveLength(3);
  });

  it('cancels the renders of faces that fall out of the window', () => {
    const { source, double } = makeSource();
    source.request([1, 2, 3, 4]);
    expect(double.live(3)).toHaveLength(1);
    source.request([1, 2]);
    expect(double.live(3)).toHaveLength(0);
    expect(double.live(4)).toHaveLength(0);
    expect(double.live(1)).toHaveLength(1);
  });

  it('truncates a window larger than the cache to its most urgent faces', () => {
    const { source, double } = makeSource({}, { width: 1200, cache: 3 });
    source.request([1, 2, 3, 4, 5, 6]);
    expect([1, 2, 3, 4, 5, 6].filter((page) => double.live(page).length > 0)).toEqual([1, 2, 3]);
  });

  it('a smaller cache after a change of tier trims the cache at the next request', async () => {
    let limits = { width: 1200, cache: 6 };
    const { source, double } = makeSource({ limits: () => limits });
    await fill(source, double, [1, 2, 3, 4, 5, 6]);
    expect(alive()).toHaveLength(6);
    limits = { width: 800, cache: 3 };
    source.request([4, 5, 6]);
    expect(alive()).toHaveLength(3);
    expect(source.cachedPages.sort()).toEqual([4, 5, 6]);
  });

  it('dispose() disposes every texture, cancels every render and forgets its listeners', async () => {
    const { source, double } = makeSource();
    await fill(source, double, [1, 2]);
    source.request([1, 2, 3, 4]);
    const listener = vi.fn();
    source.subscribe(listener);
    source.dispose();
    expect(alive()).toHaveLength(0);
    expect(double.live(3)).toHaveLength(0);
    expect(source.cachedPages).toEqual([]);
    source.request([5]);
    expect(double.live(5)).toHaveLength(0); // a disposed source asks for nothing
  });

  it('a canvas that arrives after the source was disposed is zeroed, not turned into a texture', async () => {
    const { source, double } = makeSource();
    source.request([1]);
    const job = double.live(1)[0];
    const canvas = { width: 400, height: 560 } as HTMLCanvasElement;
    // the render had finished (its promise is settled) when the source went away; the reaction runs after
    job?.resolve(canvas);
    source.dispose();
    await settle(1);
    expect(canvas.width).toBe(0);
    expect(textures).toHaveLength(0);
  });

  it('hands every new texture to `upload` BEFORE the book is told (its first draw then costs nothing)', async () => {
    const order: string[] = [];
    const upload = vi.fn(() => {
      order.push('upload');
    });
    const { source, double } = makeSource({ upload });
    source.subscribe(() => {
      order.push('emit');
    });
    source.request([1]);
    await double.finish(1, QUICK_WIDTH);
    expect(upload).toHaveBeenCalledTimes(1);
    expect(order).toEqual(['upload', 'emit']);
    await double.finish(1, 1200);
    expect(upload).toHaveBeenCalledTimes(2);
  });

  it('notifies subscribers whenever a texture becomes available or changes', async () => {
    const { source, double } = makeSource();
    const listener = vi.fn();
    source.subscribe(listener);
    source.request([1]);
    await double.finish(1, QUICK_WIDTH);
    expect(listener).toHaveBeenCalledTimes(1);
    await double.finish(1, 1200);
    expect(listener).toHaveBeenCalledTimes(2);
  });
});

describe('PdfPageSource: when the pages cannot be drawn', () => {
  it('says every page face is ready (the unveiling must not wait for pages that never come) and asks for nothing', () => {
    const { source, double } = makeSource();
    source.setAvailability('failed');
    expect(source.isReady(1)).toBe(true);
    source.request([1, 2]);
    expect(double.jobs).toHaveLength(0);
    expect(source.getTexture(1)).toBeNull();
  });

  it('a page whose render failed is not retried in a loop and does not break the others', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { source, double } = makeSource();
    source.request([1, 2]);
    double.live(1)[0]?.reject(new Error('corrupt'));
    await settle(1);
    expect(error).toHaveBeenCalled();
    await double.finish(2, QUICK_WIDTH);
    expect(source.getTexture(2)).not.toBeNull();
  });
});

describe('PdfPageSource: highlights', () => {
  const rects = [{ x: 0.1, y: 0.2, w: 0.4, h: 0.05 }];

  async function ready(source: PdfPageSource, double: ReturnType<typeof rendererDouble>, page: number) {
    source.request([page]);
    await double.finish(page, QUICK_WIDTH);
    await double.finish(page, 1200);
  }

  it('draws the page again with the passages when a highlight is set, in place (same texture, same size)', async () => {
    const { source, double } = makeSource();
    await ready(source, double, 3);
    const texture = source.getTexture(3);
    expect(source.isReady(3)).toBe(true);
    source.setHighlight(3, rects);
    expect(source.isReady(3)).toBe(false); // the picture on the leaf is stale until the glow is drawn
    const job = double.live(3)[0];
    expect(job?.request.highlight).toEqual(rects);
    expect(job?.request.width).toBe(1200);
    await double.finish(3, 1200);
    expect(source.getTexture(3)).toBe(texture);
    expect((texture as unknown as FakeTexture).needsUpdate).toBe(true);
    expect(source.isReady(3)).toBe(true);
  });

  it('removes the glow when the highlight is cleared', async () => {
    const { source, double } = makeSource();
    await ready(source, double, 3);
    source.setHighlight(3, rects);
    await double.finish(3, 1200);
    source.clearHighlight();
    const job = double.live(3)[0];
    expect(job?.request.highlight).toBeUndefined();
    await double.finish(3, 1200);
    expect(source.isReady(3)).toBe(true);
    expect(textures.filter((texture) => !texture.disposed)).toHaveLength(1);
  });

  it('moves the glow: the page it left is drawn plain again', async () => {
    const { source, double } = makeSource();
    source.request([3, 4]);
    for (const page of [3, 4]) {
      await double.finish(page, QUICK_WIDTH);
      await double.finish(page, 1200);
    }
    source.setHighlight(3, rects);
    await double.finish(3, 1200);
    source.setHighlight(4, rects);
    expect(double.live(3)[0]?.request.highlight).toBeUndefined();
    expect(double.live(4)[0]?.request.highlight).toEqual(rects);
  });

  it('a page that is not alive yet picks the highlight up when it is drawn', () => {
    const { source, double } = makeSource();
    source.setHighlight(5, rects);
    source.request([5]);
    expect(double.live(5)[0]?.request.highlight).toEqual(rects);
  });

  it('a highlight set while the cheap pass is still drawing gets its own full pass', async () => {
    const { source, double } = makeSource();
    source.request([5]);
    source.setHighlight(5, rects);
    await double.finish(5, QUICK_WIDTH);
    const job = double.live(5)[0];
    expect(job?.request.width).toBe(1200);
    expect(job?.request.highlight).toEqual(rects);
  });

  it('ignores a highlight on a page that does not exist', () => {
    const { source, double } = makeSource();
    source.setHighlight(99, rects);
    expect(double.jobs).toHaveLength(0);
  });
});

describe('PdfPageSource: pictures that finish during a turn (ruling R-1)', () => {
  it('holds a picture that finishes while a turn animates: no texture, no upload, no notification until the turn is over', async () => {
    const gate = createRenderGate();
    const upload = vi.fn();
    const { source, double } = makeSource({ gate, upload });
    const listener = vi.fn();
    source.subscribe(listener);
    source.request([1, 2]);
    gate.setBusy(true); // the turn begins with the render of page 1 under way
    await double.finish(1, QUICK_WIDTH);
    expect(source.getTexture(1)).toBeNull();
    expect(upload).not.toHaveBeenCalled();
    expect(listener).not.toHaveBeenCalled();
    expect(textures).toHaveLength(0);
    gate.setBusy(false);
    await settle(2);
    expect(upload).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(source.getTexture(1)).not.toBeNull();
  });

  it('hands over the pictures of a riffle one at a time, each uploaded before the next is created', async () => {
    const gate = createRenderGate();
    const order: string[] = [];
    const { source, double } = makeSource({
      gate,
      upload: () => {
        order.push('upload');
      },
    });
    source.subscribe(() => {
      order.push('emit');
    });
    source.request([1, 2, 3]);
    gate.setBusy(true);
    for (const page of [1, 2, 3]) await double.finish(page, QUICK_WIDTH);
    expect(order).toEqual([]);
    gate.setBusy(false);
    await settle(1);
    expect(order).toEqual(['upload', 'emit']); // one picture per turn of the event loop
    await settle(4);
    expect(order).toEqual(['upload', 'emit', 'upload', 'emit', 'upload', 'emit']);
  });

  it('a picture that finished during the turn for a face that then left the window is dropped, its canvas zeroed', async () => {
    const gate = createRenderGate();
    const { source, double } = makeSource({ gate });
    source.request([1, 2]);
    gate.setBusy(true);
    await double.finish(1, QUICK_WIDTH);
    const canvas = double.canvases[0];
    source.request([2, 5]); // the riffle's destination: page 1 left the window
    gate.setBusy(false);
    await settle(3);
    expect(source.cachedPages).not.toContain(1);
    expect(canvas?.width).toBe(0);
  });

  it('a picture that finishes while a turn animates and is asked for again meanwhile is not installed twice', async () => {
    const gate = createRenderGate();
    const { source, double } = makeSource({ gate });
    source.request([1]);
    gate.setBusy(true);
    await double.finish(1, QUICK_WIDTH);
    source.setHighlight(1, [{ x: 0.1, y: 0.1, w: 0.2, h: 0.1 }]); // not resident yet: picked up when drawn
    expect(source.cachedPages).toEqual([]);
    gate.setBusy(false);
    await settle(3);
    expect(source.cachedPages).toEqual([1]);
    expect(textures.filter((texture) => !texture.disposed)).toHaveLength(1);
  });

  it('with no turn in progress a picture is handed over at once', async () => {
    const gate = createRenderGate();
    const { source, double } = makeSource({ gate });
    source.request([1]);
    await double.finish(1, QUICK_WIDTH);
    expect(source.getTexture(1)).not.toBeNull();
  });
});

describe('PdfPageSource: telling the book when a texture it may hold is let go', () => {
  it('a cache that shrinks at the next request notifies, so a disposed texture is not kept bound', async () => {
    let limits = { width: 1200, cache: 6 };
    const { source, double } = makeSource({ limits: () => limits });
    source.request([1, 2, 3, 4, 5, 6]);
    for (const page of [1, 2, 3, 4, 5, 6]) {
      await double.finish(page, QUICK_WIDTH);
      await double.finish(page, 1200);
    }
    const listener = vi.fn();
    source.subscribe(listener);
    limits = { width: 800, cache: 3 };
    source.request([4, 5, 6]);
    expect(listener).toHaveBeenCalled();
    expect(alive()).toHaveLength(3);
  });

  it("a picture that finds no room after the page's own old texture was let go still notifies", async () => {
    const { source, double } = makeSource({}, { width: 1200, cache: 2 });
    source.request([1, 2]);
    for (const page of [1, 2]) {
      await double.finish(page, QUICK_WIDTH);
      await double.finish(page, 1200);
    }
    source.request([3, 4]); // 1 and 2 are out of the window now but still alive
    const listener = vi.fn();
    source.subscribe(listener);
    await double.finish(3, QUICK_WIDTH);
    expect(listener).toHaveBeenCalled();
  });
});

describe('PdfPageSource: release()', () => {
  it('lets every texture and canvas go (the scene is gone), cancels what is under way, and draws again on the next request', async () => {
    const { source, double } = makeSource();
    source.request([1, 2]);
    for (const page of [1, 2]) {
      await double.finish(page, QUICK_WIDTH);
      await double.finish(page, 1200);
    }
    source.request([1, 2, 3]);
    const listener = vi.fn();
    source.subscribe(listener);
    source.release();
    expect(alive()).toHaveLength(0);
    expect(source.cachedPages).toEqual([]);
    expect(double.live(3)).toHaveLength(0);
    expect(listener).toHaveBeenCalled();
    source.request([1, 2]); // the immersive view is back
    expect(double.live(1)).toHaveLength(1);
  });

  it('a page outside the window that is redrawn for a highlight goes after the pages in view', async () => {
    const { source, double } = makeSource();
    source.request([3]);
    await double.finish(3, QUICK_WIDTH);
    await double.finish(3, 1200);
    source.request([5, 6]); // the window moved on; page 3 is still alive (the cache has room)
    expect(source.cachedPages).toContain(3);
    source.setHighlight(3, [{ x: 0.1, y: 0.1, w: 0.2, h: 0.1 }]);
    const highlighted = double.live(3)[0]?.priority ?? 0;
    expect(highlighted).toBeGreaterThan(double.live(5)[0]?.priority ?? Infinity);
    expect(highlighted).toBeGreaterThan(double.live(6)[0]?.priority ?? Infinity);
  });
});
