import { renderPage, type PdfDocumentLike, type RenderOptions } from './pageRenderer';
import { renderGate, type RenderGate } from './renderGate';

/*
 * The ONE place pages are drawn. Everything that wants a picture of a PDF page (the 3D book's textures, the page-jump
 * thumbnails, the flat fallback, the memory view) asks this service, which works through a single priority queue over the
 * single shared PDFDocumentProxy, one render at a time (pdf.js paints on the main thread; two at once only slow both).
 *
 *  - Lower `priority` numbers first; equal numbers in the order asked. A job's priority can change while it waits.
 *  - NO render starts while a turn or a riffle animates (the render gate): not even the cheap pass of a page in view. Drawing
 *    a page costs main-thread time a turn cannot spare; a page that is not ready is plain parchment until the turn ends.
 *  - Consumers own the canvases they get: the service keeps no reference, so an eviction elsewhere cannot zero a canvas
 *    somebody else holds.
 */

export interface RenderRequest extends RenderOptions {
  /** 1-based page number. */
  page: number;
  /** Width in pixels of the leaf texture. */
  width: number;
  priority: number;
  signal?: AbortSignal;
}

export interface RenderJob {
  readonly promise: Promise<HTMLCanvasElement>;
  setPriority(priority: number): void;
  /** Withdraws the job: it rejects with an AbortError (a render already under way is cancelled). */
  cancel(): void;
}

/** What the consumers of the service need (a fake in tests). */
export interface PageImageRenderer {
  enqueue(request: RenderRequest): RenderJob;
}

interface Entry {
  request: RenderRequest;
  priority: number;
  seq: number;
  pdf: PdfDocumentLike | null;
  controller: AbortController;
  resolve(canvas: HTMLCanvasElement): void;
  reject(error: unknown): void;
  settled: boolean;
  detach(): void;
}

function abortError(): DOMException {
  return new DOMException('The page render was cancelled', 'AbortError');
}

export interface PageImageServiceDeps {
  gate?: RenderGate;
  /** Replaceable in tests. */
  render?: typeof renderPage;
}

export class PageImageService implements PageImageRenderer {
  private pdf: PdfDocumentLike | null = null;
  private queue: Entry[] = [];
  private running: Entry | null = null;
  private seq = 0;
  private pumpTimer: ReturnType<typeof setTimeout> | null = null;
  private idleWaiters: (() => void)[] = [];
  private readonly gate: RenderGate;
  private readonly render: typeof renderPage;
  private readonly stopGate: () => void;

  constructor(deps: PageImageServiceDeps = {}) {
    this.gate = deps.gate ?? renderGate;
    this.render = deps.render ?? renderPage;
    this.stopGate = this.gate.subscribe(() => {
      if (!this.gate.busy()) this.schedulePump();
    });
  }

  /**
   * The document every request is drawn from (null: none). Jobs that were asked of another document are cancelled; jobs
   * that were waiting for a first document are served by it.
   */
  setDocument(pdf: PdfDocumentLike | null): void {
    if (pdf === this.pdf) return;
    const previous = this.pdf;
    this.pdf = pdf;
    for (const entry of [...this.queue]) {
      if (entry.pdf === null && pdf !== null) entry.pdf = pdf;
      else if (entry.pdf !== pdf) this.settle(entry, undefined, abortError());
    }
    if (this.running?.pdf === previous) this.running.controller.abort();
    this.schedulePump();
  }

  /** Jobs waiting plus the one under way. */
  get pending(): number {
    return this.queue.length + (this.running ? 1 : 0);
  }

  /** Resolves when nothing is waiting or running (tests, and shutdown). */
  whenIdle(): Promise<void> {
    if (this.pending === 0) return Promise.resolve();
    return new Promise((resolve) => {
      this.idleWaiters.push(resolve);
    });
  }

  enqueue(request: RenderRequest): RenderJob {
    const controller = new AbortController();
    let entry!: Entry;
    const promise = new Promise<HTMLCanvasElement>((resolve, reject) => {
      entry = {
        request,
        priority: request.priority,
        seq: (this.seq += 1),
        pdf: this.pdf,
        controller,
        resolve,
        reject,
        settled: false,
        detach: () => undefined,
      };
    });
    const { signal } = request;
    if (signal) {
      const onAbort = (): void => {
        this.cancel(entry);
      };
      if (signal.aborted) {
        queueMicrotask(onAbort);
      } else {
        signal.addEventListener('abort', onAbort, { once: true });
        entry.detach = () => {
          signal.removeEventListener('abort', onAbort);
        };
      }
    }
    this.queue.push(entry);
    this.schedulePump();
    return {
      promise,
      setPriority: (priority) => {
        entry.priority = priority;
      },
      cancel: () => {
        this.cancel(entry);
      },
    };
  }

  dispose(): void {
    this.stopGate();
    if (this.pumpTimer) clearTimeout(this.pumpTimer);
    this.pumpTimer = null;
    for (const entry of [...this.queue]) this.settle(entry, undefined, abortError());
    this.running?.controller.abort();
  }

  private cancel(entry: Entry): void {
    if (entry.settled) return;
    if (this.running === entry) {
      entry.controller.abort(); // the render rejects, which settles it
      return;
    }
    this.settle(entry, undefined, abortError());
  }

  private settle(entry: Entry, canvas: HTMLCanvasElement | undefined, error?: unknown): void {
    if (entry.settled) return;
    entry.settled = true;
    entry.detach();
    this.queue = this.queue.filter((candidate) => candidate !== entry);
    if (canvas) entry.resolve(canvas);
    else entry.reject(error);
    this.notifyIdle();
  }

  private notifyIdle(): void {
    if (this.pending > 0) return;
    const waiters = this.idleWaiters;
    this.idleWaiters = [];
    for (const waiter of waiters) waiter();
  }

  private schedulePump(): void {
    if (this.pumpTimer !== null) return;
    // A turn of the event loop between renders: input and frames run in the gaps.
    this.pumpTimer = setTimeout(() => {
      this.pumpTimer = null;
      this.pump();
    }, 0);
  }

  private next(): Entry | null {
    if (this.gate.busy()) return null;
    let best: Entry | null = null;
    for (const entry of this.queue) {
      if (
        best === null ||
        entry.priority < best.priority ||
        (entry.priority === best.priority && entry.seq < best.seq)
      ) {
        best = entry;
      }
    }
    return best;
  }

  private pump(): void {
    if (this.running) return;
    const entry = this.next();
    if (!entry?.pdf) return; // nothing to do, or no document yet
    this.queue = this.queue.filter((candidate) => candidate !== entry);
    this.running = entry;
    const { page, width, bindingEdge, highlight, createCanvas, keepPage } = entry.request;
    const options: RenderOptions = {
      ...(bindingEdge === undefined ? {} : { bindingEdge }),
      ...(highlight === undefined ? {} : { highlight }),
      ...(createCanvas === undefined ? {} : { createCanvas }),
      ...(keepPage === undefined ? {} : { keepPage }),
    };
    this.render(entry.pdf, page, width, entry.controller.signal, options).then(
      (canvas) => {
        this.running = null;
        if (entry.controller.signal.aborted) {
          canvas.width = 0;
          canvas.height = 0;
          this.settle(entry, undefined, abortError());
        } else {
          this.settle(entry, canvas);
        }
        this.schedulePump();
      },
      (error: unknown) => {
        this.running = null;
        this.settle(entry, undefined, error);
        this.schedulePump();
      },
    );
  }
}

/** The app's page image service. The PDF book (pdf/pdfBook.ts) gives it the shared document. */
export const pageImageService = new PageImageService();
