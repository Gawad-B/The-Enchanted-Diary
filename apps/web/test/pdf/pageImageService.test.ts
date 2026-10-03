import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PageImageService } from '../../src/pdf/pageImageService';
import type { PdfDocumentLike, RenderOptions } from '../../src/pdf/pageRenderer';
import { createRenderGate, type RenderGate } from '../../src/pdf/renderGate';
import { settle } from './helpers';

/** A renderer double: records the order jobs START in, and finishes a job when the test says so. */
function rendererDouble() {
  const started: { page: number; width: number; signal: AbortSignal }[] = [];
  const finishers = new Map<number, () => void>();
  let concurrent = 0;
  let peak = 0;
  const render = vi.fn(
    (_pdf: PdfDocumentLike, page: number, width: number, signal: AbortSignal, _options?: RenderOptions) => {
      started.push({ page, width, signal });
      concurrent += 1;
      peak = Math.max(peak, concurrent);
      return new Promise<HTMLCanvasElement>((resolve, reject) => {
        const done = (): void => {
          concurrent -= 1;
        };
        finishers.set(page, () => {
          done();
          resolve({ width, height: Math.round(width * 1.4) } as HTMLCanvasElement);
        });
        signal.addEventListener('abort', () => {
          done();
          reject(new DOMException('cancelled', 'AbortError'));
        });
      });
    },
  );
  return {
    render,
    started,
    finish: (page: number) => finishers.get(page)?.(),
    pages: () => started.map((entry) => entry.page),
    peak: () => peak,
  };
}

const PDF = { numPages: 50, getPage: vi.fn() } as unknown as PdfDocumentLike;
let gate: RenderGate;
let double: ReturnType<typeof rendererDouble>;
let service: PageImageService;

beforeEach(() => {
  gate = createRenderGate();
  double = rendererDouble();
  service = new PageImageService({ gate, render: double.render });
  service.setDocument(PDF);
});
afterEach(() => {
  service.dispose();
});

describe('PageImageService', () => {
  it('renders one page at a time, lowest priority number first, equal priorities in the order asked', async () => {
    const jobs = [
      service.enqueue({ page: 5, width: 400, priority: 5 }),
      service.enqueue({ page: 2, width: 400, priority: 1 }),
      service.enqueue({ page: 9, width: 400, priority: 1 }),
      service.enqueue({ page: 3, width: 400, priority: 3 }),
    ];
    for (let turn = 0; turn < 4; turn += 1) {
      await settle();
      const running = double.started.at(-1);
      if (running) double.finish(running.page);
    }
    await Promise.all(jobs.map((job) => job.promise));
    expect(double.pages()).toEqual([2, 9, 3, 5]);
    expect(double.peak()).toBe(1);
  });

  it('can change the priority of a job that is still waiting', async () => {
    const first = service.enqueue({ page: 1, width: 400, priority: 0 });
    const late = service.enqueue({ page: 7, width: 400, priority: 9 });
    const other = service.enqueue({ page: 8, width: 400, priority: 5 });
    await settle();
    late.setPriority(1); // now ahead of 8
    double.finish(1);
    await first.promise;
    await settle();
    expect(double.pages()).toEqual([1, 7]);
    double.finish(7);
    await settle();
    double.finish(8);
    await Promise.all([late.promise, other.promise]);
  });

  it('cancels a job that has not started (its promise rejects with an AbortError, it never reaches the renderer)', async () => {
    service.enqueue({ page: 1, width: 400, priority: 0 });
    const waiting = service.enqueue({ page: 2, width: 400, priority: 1 });
    await settle();
    waiting.cancel();
    await expect(waiting.promise).rejects.toMatchObject({ name: 'AbortError' });
    double.finish(1);
    await settle();
    expect(double.pages()).toEqual([1]);
  });

  it('cancels the render under way when the caller aborts', async () => {
    const controller = new AbortController();
    const job = service.enqueue({ page: 4, width: 400, priority: 0, signal: controller.signal });
    await settle();
    controller.abort();
    await expect(job.promise).rejects.toMatchObject({ name: 'AbortError' });
    expect(double.started[0]?.signal.aborted).toBe(true);
    await service.whenIdle();
  });

  it('starts NO render while a turn animates (not even the cheap pass of a page in view) and resumes when it ends', async () => {
    gate.setBusy(true);
    const full = service.enqueue({ page: 3, width: 1200, priority: 3 });
    const quick = service.enqueue({ page: 4, width: 400, priority: 0 });
    await settle(4);
    expect(double.pages()).toEqual([]);
    gate.setBusy(false);
    await settle();
    expect(double.pages()).toEqual([4]); // nearest priority first
    double.finish(4);
    await quick.promise;
    await settle();
    expect(double.pages()).toEqual([4, 3]);
    double.finish(3);
    await full.promise;
  });

  it('lets a render that is already running when a turn begins finish (its picture is held back by the page source)', async () => {
    const running = service.enqueue({ page: 7, width: 1200, priority: 0 });
    const waiting = service.enqueue({ page: 8, width: 1200, priority: 1 });
    await settle();
    expect(double.pages()).toEqual([7]);
    gate.setBusy(true);
    expect(double.started[0]?.signal.aborted).toBe(false); // not cancelled
    double.finish(7);
    await expect(running.promise).resolves.toBeDefined();
    await settle(4);
    expect(double.pages()).toEqual([7]); // and the next one does not start
    gate.setBusy(false);
    await settle();
    expect(double.pages()).toEqual([7, 8]);
    double.finish(8);
    await waiting.promise;
  });

  it('waits for a document: jobs asked before one is open are served by the first', async () => {
    const early = new PageImageService({ gate, render: double.render });
    const job = early.enqueue({ page: 6, width: 400, priority: 0 });
    await settle();
    expect(double.pages()).toEqual([]);
    early.setDocument(PDF);
    await settle();
    expect(double.pages()).toEqual([6]);
    double.finish(6);
    await job.promise;
    early.dispose();
  });

  it('cancels the jobs of the previous document when another one replaces it, and the running render', async () => {
    const running = service.enqueue({ page: 1, width: 400, priority: 0 });
    const waiting = service.enqueue({ page: 2, width: 400, priority: 1 });
    await settle();
    service.setDocument({ numPages: 3, getPage: vi.fn() });
    await expect(running.promise).rejects.toMatchObject({ name: 'AbortError' });
    await expect(waiting.promise).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('keeps no reference to what it renders (consumers own their canvases) and reports idle', async () => {
    const job = service.enqueue({ page: 1, width: 400, priority: 0 });
    await settle();
    double.finish(1);
    const canvas = await job.promise;
    expect(canvas.width).toBe(400);
    await service.whenIdle();
    expect(service.pending).toBe(0);
  });

  it('a render that fails rejects only its own job and the queue goes on', async () => {
    const renderFail = vi.fn((_pdf: PdfDocumentLike, page: number) =>
      page === 1
        ? Promise.reject(new Error('corrupt page'))
        : Promise.resolve({ width: 1 } as HTMLCanvasElement),
    );
    const other = new PageImageService({ gate, render: renderFail });
    other.setDocument(PDF);
    const bad = other.enqueue({ page: 1, width: 400, priority: 0 });
    const good = other.enqueue({ page: 2, width: 400, priority: 1 });
    await expect(bad.promise).rejects.toThrow('corrupt page');
    await expect(good.promise).resolves.toBeDefined();
    other.dispose();
  });
});
