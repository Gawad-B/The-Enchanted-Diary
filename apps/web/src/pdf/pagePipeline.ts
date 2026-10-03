import { CanvasTexture, SRGBColorSpace, type Texture } from 'three';
import type { Direction, NormalizedRect } from '@enchanted/shared';
import { sideOfPage, type Side } from '../book/bookLayout';
import type { PageImageRenderer, RenderJob } from './pageImageService';
import { zeroCanvas } from './pageRenderer';
import type { PageTextureCache, Stage } from './pageTextureCache';
import type { RenderGate } from './renderGate';

/*
 * From "this page is wanted" to "its texture is in the cache": the two passes (a cheap one at ~400 px, then the tier's full
 * width, which replaces it), the jobs in flight, and the pictures that finished while a turn animated.
 *
 * The page image service never STARTS a render during a turn. A render that was already running when the turn began is let
 * finish, but its picture is not handed to the book until the turn is over: creating a texture, uploading it and binding it
 * costs a frame what a turn cannot spare. Such a picture waits in `staged`, and is installed one per turn of the event loop
 * when the gate opens.
 */

/** Width of the cheap first pass. */
export const QUICK_WIDTH = 400;

/** The two faces in view: their passes go before those of the faces beyond. */
const FACES_IN_VIEW = 2;

export interface PageSourceLimits {
  /** Width in pixels of a full-resolution page texture. */
  width: number;
  /** How many page textures may be alive at once. */
  cache: number;
}

export interface PipelineDeps {
  renderer: PageImageRenderer;
  cache: PageTextureCache;
  direction: Direction;
  /** Read at every request, so a change of tier applies to the pages drawn from then on. */
  limits: () => PageSourceLimits;
  /** The faces in view and near, most urgent first. */
  wanted: () => readonly number[];
  /** The passages `page` glows under now (null: none). Compared by identity with what a cached picture was drawn with. */
  highlightFor: (page: number) => readonly NormalizedRect[] | null;
  /** The cache's contents changed: whoever reads textures must read them again. */
  changed: () => void;
  anisotropy?: () => number;
  createTexture?: (canvas: HTMLCanvasElement) => Texture;
  /** Called with each new texture just before the book can see it (the GPU upload). */
  upload?: (texture: Texture) => void;
  gate?: Pick<RenderGate, 'busy' | 'subscribe'>;
}

interface Pending {
  job: RenderJob;
  stage: Stage;
}

/** A finished picture waiting for the turn to end. */
interface Staged {
  page: number;
  stage: Stage;
  job: RenderJob;
  highlight: readonly NormalizedRect[] | null;
  canvas: HTMLCanvasElement;
}

export class PagePipeline {
  private readonly pending = new Map<number, Pending>();
  private staged: Staged[] = [];
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;
  private readonly stopGate: (() => void) | null;

  constructor(private readonly deps: PipelineDeps) {
    this.stopGate =
      deps.gate?.subscribe(() => {
        if (!deps.gate?.busy()) this.scheduleFlush();
      }) ?? null;
  }

  /** The window moved: stop what left it, let go of what no longer fits, and ask for what is in it. */
  update(): void {
    const wanted = this.deps.wanted();
    const limits = this.deps.limits();
    // Renders for faces that left the window are cancelled: the queue works on what is in view now.
    for (const [page, pending] of this.pending) {
      if (!wanted.includes(page)) {
        pending.job.cancel();
        this.pending.delete(page);
      }
    }
    this.dropStaged((page) => !wanted.includes(page));
    // Whoever holds a texture that is let go here is told, so the book never keeps drawing a disposed one.
    if (this.deps.cache.trim(limits.cache)) this.deps.changed();
    wanted.forEach((page, rank) => {
      this.want(page, rank, limits);
    });
  }

  /** Redraws a resident page after its highlight changed (a page that is not alive picks the highlight up when drawn). */
  redraw(page: number): void {
    if (!this.deps.cache.peek(page)) return;
    const pending = this.pending.get(page);
    if (pending) {
      pending.job.cancel();
      this.pending.delete(page);
    }
    const wanted = this.deps.wanted();
    const rank = wanted.indexOf(page);
    // A page outside the window (a citation's page, not turned to yet) goes last until the window reaches it.
    this.schedule(
      page,
      'full',
      rank >= 0 ? rank : wanted.length,
      this.deps.limits(),
      this.deps.highlightFor(page),
    );
  }

  /** Cancels every job and drops every staged picture. */
  cancelAll(): void {
    for (const pending of this.pending.values()) pending.job.cancel();
    this.pending.clear();
    this.dropStaged(() => true);
  }

  dispose(): void {
    this.disposed = true;
    this.stopGate?.();
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = null;
    this.cancelAll();
  }

  // --- the passes --------------------------------------------------------------------------------------------------

  /** Makes sure `page` is, or is on its way to being, a full-resolution texture without a stale highlight. */
  private want(page: number, rank: number, limits: PageSourceLimits): void {
    const entry = this.deps.cache.peek(page);
    const highlight = this.deps.highlightFor(page);
    const pending = this.pending.get(page);
    if (pending) {
      pending.job.setPriority(this.priority(pending.stage, rank));
      return;
    }
    if (entry?.stage === 'full' && entry.highlight === highlight) return;
    // Nothing yet: a cheap pass first (unless the full width is cheap already), then the full one.
    const stage: Stage = !entry && limits.width > QUICK_WIDTH ? 'quick' : 'full';
    this.schedule(page, stage, rank, limits, highlight);
  }

  /**
   * Lower goes first. The two faces in view go before everything else, cheap pass first and then the full one; the faces
   * beyond follow in the same order, nearest first.
   */
  private priority(stage: Stage, rank: number): number {
    return (rank < FACES_IN_VIEW ? 0 : 100) + (stage === 'quick' ? 0 : 10) + rank;
  }

  private bindingEdge(page: number): Side {
    // The gutter is on the edge of a page that faces the other page of its spread.
    return sideOfPage(page, this.deps.direction) === 'left' ? 'right' : 'left';
  }

  private schedule(
    page: number,
    stage: Stage,
    rank: number,
    limits: PageSourceLimits,
    highlight: readonly NormalizedRect[] | null,
  ): void {
    const width = stage === 'quick' ? Math.min(QUICK_WIDTH, limits.width) : limits.width;
    const job = this.deps.renderer.enqueue({
      page,
      width,
      priority: this.priority(stage, rank),
      bindingEdge: this.bindingEdge(page),
      // pdf.js keeps what it decoded for the page until the full pass has used it.
      keepPage: stage === 'quick',
      ...(highlight ? { highlight } : {}),
    });
    this.pending.set(page, { job, stage });
    job.promise.then(
      (canvas) => {
        this.arrived(page, stage, job, highlight, canvas);
      },
      (error: unknown) => {
        if (this.pending.get(page)?.job === job) this.pending.delete(page);
        if (error instanceof DOMException && error.name === 'AbortError') return;
        console.error(`[PdfPageSource] page ${String(page)} could not be drawn`, error);
      },
    );
  }

  /** A picture is finished: handed to the book now, or after the turn that is animating. */
  private arrived(
    page: number,
    stage: Stage,
    job: RenderJob,
    highlight: readonly NormalizedRect[] | null,
    canvas: HTMLCanvasElement,
  ): void {
    // Superseded (cancelled and asked again, or the pipeline is gone): nobody wants this canvas.
    if (this.disposed || this.pending.get(page)?.job !== job) {
      zeroCanvas(canvas);
      return;
    }
    if (this.deps.gate?.busy() === true) {
      this.staged.push({ page, stage, job, highlight, canvas });
      return;
    }
    this.pending.delete(page);
    this.install(page, stage, highlight, canvas);
  }

  private install(
    page: number,
    stage: Stage,
    highlight: readonly NormalizedRect[] | null,
    canvas: HTMLCanvasElement,
  ): void {
    const { cache } = this.deps;
    const limits = this.deps.limits();
    const existing = cache.peek(page);
    if (existing?.canvas.width === canvas.width) {
      // Same size: the texture keeps its place on the GPU and takes the new picture (a highlight appearing or leaving).
      const old = existing.canvas;
      existing.canvas = canvas;
      existing.texture.image = canvas;
      existing.texture.needsUpdate = true;
      existing.stage = stage;
      existing.highlight = highlight;
      zeroCanvas(old);
    } else {
      let letGo = false;
      if (existing) {
        cache.evict(page);
        letGo = true;
      }
      const room = cache.makeRoom(page, limits.cache);
      if (!room.ok) {
        zeroCanvas(canvas);
        if (letGo || room.evicted) this.deps.changed();
        return;
      }
      const texture = this.makeTexture(canvas);
      // On the GPU before the book can ask for it: its first draw then costs nothing.
      this.deps.upload?.(texture);
      cache.add(page, { texture, canvas, stage, highlight });
    }
    this.deps.changed();
    // The cheap pass is in place: now the full one (or a highlight that changed while this one was drawn).
    const rank = this.deps.wanted().indexOf(page);
    if (rank >= 0) this.want(page, rank, limits);
  }

  private makeTexture(canvas: HTMLCanvasElement): Texture {
    if (this.deps.createTexture) return this.deps.createTexture(canvas);
    const texture = new CanvasTexture(canvas);
    texture.colorSpace = SRGBColorSpace;
    texture.anisotropy = this.deps.anisotropy?.() ?? 4;
    return texture;
  }

  // --- pictures that finished during a turn ------------------------------------------------------------------------

  private scheduleFlush(): void {
    if (this.flushTimer !== null || this.staged.length === 0 || this.disposed) return;
    // One picture per turn of the event loop: the textures of a riffle are created and uploaded one at a time.
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.flushOne();
    }, 0);
  }

  private flushOne(): void {
    if (this.disposed || this.deps.gate?.busy() === true) return; // the gate's listener brings it back
    const next = this.staged.shift();
    if (!next) return;
    if (this.pending.get(next.page)?.job === next.job) {
      this.pending.delete(next.page);
      this.install(next.page, next.stage, next.highlight, next.canvas);
    } else {
      zeroCanvas(next.canvas); // asked again meanwhile
    }
    this.scheduleFlush();
  }

  private dropStaged(drop: (page: number) => boolean): void {
    this.staged = this.staged.filter((entry) => {
      if (!drop(entry.page)) return true;
      zeroCanvas(entry.canvas);
      if (this.pending.get(entry.page)?.job === entry.job) this.pending.delete(entry.page);
      return false;
    });
  }
}
