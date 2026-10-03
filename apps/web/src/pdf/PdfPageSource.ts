import type { Texture } from 'three';
import type { Direction, NormalizedRect } from '@enchanted/shared';
import type { LeafFace } from '../book/bookLayout';
import type { PageTextureSource } from '../book/pageSource';
import type { PageImageRenderer } from './pageImageService';
import { PagePipeline, QUICK_WIDTH, type PageSourceLimits } from './pagePipeline';
import { PageTextureCache } from './pageTextureCache';
import type { RenderGate } from './renderGate';

export { QUICK_WIDTH, type PageSourceLimits };

/*
 * The PDF-backed page source: the textures of the book's numbered faces are PDF pages. The faces that are not pages (the
 * flyleaf, the bookplate, the endpaper, blank sheets) are the diary's own and come from the parchment source.
 *
 * It answers the book (`getTexture`, `isReady`, `request`) and keeps the document-level state: which faces are wanted, the
 * highlight, whether the browser can draw the document at all, the replaceable parchment. The work of getting a page into the
 * cache (the passes, the jobs, the pictures that finish during a turn) is the PagePipeline's; the LRU is the
 * PageTextureCache's: the faces of the window (the spread in view and its neighbours) are never evicted to make room for a
 * face further away, and an evicted texture is disposed and its canvas zeroed.
 */

/** Where the parchment source (the faces that are not pages) comes from: it can be replaced while a document is open. */
export interface ParchmentLink {
  current(): PageTextureSource | null;
  /** Called when the parchment source is replaced. */
  subscribe(listener: () => void): () => void;
}

export interface PdfPageSourceDeps {
  parchment: ParchmentLink;
  renderer: PageImageRenderer;
  pageCount: number;
  /** The direction the book is laid out in: it decides which edge of a page the gutter is on. */
  direction: Direction;
  /** Read at every request, so a change of tier applies to the pages drawn from then on. */
  limits: () => PageSourceLimits;
  anisotropy?: () => number;
  /** Makes a texture of a page canvas (tests give fakes). */
  createTexture?: (canvas: HTMLCanvasElement) => Texture;
  /** Called with each new texture just before the book can see it (the production wiring uploads it to the GPU). */
  upload?: (texture: Texture) => void;
  /** Whether a turn or a riffle animates: pictures that finish meanwhile wait for it to end. */
  gate?: Pick<RenderGate, 'busy' | 'subscribe'>;
}

export type PdfAvailability = 'pending' | 'ready' | 'failed';

export class PdfPageSource implements PageTextureSource {
  readonly id = 'pdf';
  private wanted: number[] = [];
  private readonly cache = new PageTextureCache((page) => this.wanted.includes(page));
  private readonly pipeline: PagePipeline;
  private readonly listeners = new Set<() => void>();
  private highlight: { page: number; rects: readonly NormalizedRect[] } | null = null;
  private availability: PdfAvailability = 'pending';
  private disposed = false;
  private stopParchment: (() => void) | null = null;
  private readonly stopLink: () => void;

  constructor(private readonly deps: PdfPageSourceDeps) {
    this.pipeline = new PagePipeline({
      renderer: deps.renderer,
      cache: this.cache,
      direction: deps.direction,
      limits: deps.limits,
      wanted: () => this.wanted,
      highlightFor: (page) => this.highlightFor(page),
      changed: () => {
        this.emit();
      },
      ...(deps.anisotropy ? { anisotropy: deps.anisotropy } : {}),
      ...(deps.createTexture ? { createTexture: deps.createTexture } : {}),
      ...(deps.upload ? { upload: deps.upload } : {}),
      ...(deps.gate ? { gate: deps.gate } : {}),
    });
    this.stopLink = deps.parchment.subscribe(() => {
      this.attachParchment();
      this.emit();
    });
    this.attachParchment();
  }

  /** Numbers of the pages whose textures are alive (tests, and the memory budget check). */
  get cachedPages(): number[] {
    return this.cache.pages();
  }

  private isPage(face: LeafFace): face is number {
    return typeof face === 'number' && face >= 1 && face <= this.deps.pageCount;
  }

  private attachParchment(): void {
    this.stopParchment?.();
    const parchment = this.deps.parchment.current();
    this.stopParchment = parchment
      ? parchment.subscribe(() => {
          this.emit();
        })
      : null;
  }

  getTexture(face: LeafFace): Texture | null {
    if (!this.isPage(face)) return this.deps.parchment.current()?.getTexture(face) ?? null;
    return this.cache.use(face)?.texture ?? null;
  }

  isReady(face: LeafFace): boolean {
    if (!this.isPage(face)) return this.deps.parchment.current()?.isReady(face) ?? true;
    // A document this browser cannot draw must not hold the unveiling: its faces stay plain parchment.
    if (this.availability === 'failed') return true;
    const entry = this.cache.peek(face);
    return entry?.stage === 'full' && entry.highlight === this.highlightFor(face);
  }

  request(faces: readonly LeafFace[]): void {
    if (this.disposed) return;
    const pages: number[] = [];
    const others: LeafFace[] = [];
    for (const face of faces) {
      if (this.isPage(face)) {
        if (!pages.includes(face)) pages.push(face);
      } else {
        others.push(face);
      }
    }
    if (others.length > 0) this.deps.parchment.current()?.request(others);
    if (this.availability === 'failed') return;
    this.wanted = pages.slice(0, this.deps.limits().cache);
    this.pipeline.update();
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** The browser can (or cannot) draw this document's pages. `failed` makes every page face parchment and ready. */
  setAvailability(availability: PdfAvailability): void {
    if (this.availability === availability) return;
    this.availability = availability;
    if (availability === 'failed') this.pipeline.cancelAll();
    this.emit();
  }

  /** Glows the given passages of `page` (fractions of the page, origin top-left); the page is drawn again with them. */
  setHighlight(page: number, rects: readonly NormalizedRect[]): void {
    if (this.disposed || !this.isPage(page)) return;
    const previous = this.highlight?.page;
    this.highlight = { page, rects };
    if (previous !== undefined && previous !== page) this.pipeline.redraw(previous);
    this.pipeline.redraw(page);
  }

  /** Removes the glow (the reader turned away). */
  clearHighlight(): void {
    const previous = this.highlight?.page;
    this.highlight = null;
    if (previous !== undefined) this.pipeline.redraw(previous);
  }

  /**
   * Lets every texture and canvas go (the scene is gone: a lost WebGL context, the simple view) without ending the source:
   * the next request draws the pages again if the scene comes back.
   */
  release(): void {
    this.pipeline.cancelAll();
    this.wanted = [];
    this.cache.clear();
    this.emit();
  }

  dispose(): void {
    this.disposed = true;
    this.stopLink();
    this.stopParchment?.();
    this.stopParchment = null;
    this.pipeline.dispose();
    this.cache.clear();
    this.listeners.clear();
  }

  private highlightFor(page: number): readonly NormalizedRect[] | null {
    return this.highlight?.page === page ? this.highlight.rects : null;
  }

  private emit(): void {
    for (const listener of [...this.listeners]) listener();
  }
}
