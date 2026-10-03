import type { Direction } from '@enchanted/shared';
import { CanvasTexture, SRGBColorSpace, type Texture } from 'three';
import { diaryPageOf, type LeafFace } from '../book/bookLayout';
import type { PageTextureSource } from '../book/pageSource';
import { drawParchment } from '../book/paperTexture';
import type { DiaryPageLayout } from './layout';
import { heightFor, paintPageInk, paintRules } from './paint';
import type { DiaryBookStore } from '../state/diaryBook';
import type { DiaryLayoutStore } from './service';

/*
 * The textures of the diary's own pages (global section T): the ruled sheet with the ink of what was written on it. A page is
 * drawn from the shared layout, so it carries exactly the lines the reader saw written. The page the reader is writing on right
 * now (the live page) is drawn without ink, because the surface laid over it shows the same lines wet and moving; when the
 * reader leaves it, it is drawn again with them, so the page that is seen from afar and when the book is turned holds the ink.
 */

export interface DiaryPageSourceDeps {
  /** Width of a page texture, in pixels (the tier's page texture width). */
  pageWidth: number;
  layout: Pick<DiaryLayoutStore, 'getState' | 'subscribe'>;
  /** The diary's book: which page is live (drawn without ink). */
  book: Pick<DiaryBookStore, 'getState' | 'subscribe'>;
  direction?: Direction;
  anisotropy?: number;
  createCanvas?: (width: number, height: number) => HTMLCanvasElement;
}

function defaultCreateCanvas(width: number, height: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

interface Entry {
  texture: CanvasTexture;
  canvas: HTMLCanvasElement;
  signature: string;
}

/** What decides how a page looks: the text of its lines and notes and where they sit. */
export function pageSignature(page: DiaryPageLayout | undefined): string {
  if (!page) return '';
  const lines = page.lines.map(
    (line) =>
      `${line.key}@${String(line.row)}${line.dir}${String(line.indent)}:${line.chunks
        .map((chunk) => `${chunk.hand}${chunk.bold ? 'b' : ''}${chunk.dir}${chunk.text}`)
        .join('\u0001')}`,
  );
  const notes = page.notes.map(
    (note) => `${note.key}@${String(note.row)}:${String(Math.round(note.x))}:${note.label}:${note.kind}`,
  );
  return `${lines.join('\u0002')}\u0003${notes.join('\u0002')}`;
}

export class DiaryPageSource implements PageTextureSource {
  readonly id = 'diary';
  private readonly entries = new Map<number, Entry>();
  private readonly bases = new Map<number, HTMLCanvasElement>();
  private readonly listeners = new Set<() => void>();
  private readonly pending = new Set<number>();
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();
  private readonly stopLayout: () => void;
  private readonly stopBook: () => void;
  private readonly createCanvas: (width: number, height: number) => HTMLCanvasElement;
  private direction: Direction;
  private live: number | null = null;
  private disposed = false;

  constructor(private readonly deps: DiaryPageSourceDeps) {
    this.createCanvas = deps.createCanvas ?? defaultCreateCanvas;
    this.direction = deps.direction ?? 'ltr';
    this.stopLayout = deps.layout.subscribe(() => {
      this.refreshAll();
    });
    this.live = deps.book.getState().livePage;
    this.stopBook = deps.book.subscribe((state, previous) => {
      if (state.livePage !== previous.livePage) this.setLive(state.livePage);
    });
  }

  getTexture(face: LeafFace): Texture | null {
    const page = diaryPageOf(face);
    if (page === null) return null;
    const entry = this.entries.get(page);
    if (!entry) this.schedule(page);
    return entry?.texture ?? null;
  }

  isReady(face: LeafFace): boolean {
    const page = diaryPageOf(face);
    return page !== null && this.entries.has(page) && !this.pending.has(page);
  }

  request(faces: readonly LeafFace[]): void {
    for (const face of faces) {
      const page = diaryPageOf(face);
      if (page !== null) this.schedule(page);
    }
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** The page the reader is writing on (drawn without ink, the surface shows it), or null when none is. */
  setLive(page: number | null): void {
    if (page === this.live) return;
    const before = this.live;
    this.live = page;
    for (const changed of [before, page]) {
      if (changed !== null && this.entries.has(changed)) this.draw(changed);
    }
    this.notify();
  }

  /** The direction the book is laid out in changed: the sheet's rules and margins are drawn on the other side. */
  setDirection(direction: Direction): void {
    if (direction === this.direction) return;
    this.direction = direction;
    this.bases.clear();
    for (const page of this.entries.keys()) this.draw(page);
    this.notify();
  }

  dispose(): void {
    this.disposed = true;
    this.stopLayout();
    this.stopBook();
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
    for (const entry of this.entries.values()) entry.texture.dispose();
    this.entries.clear();
    this.bases.clear();
    this.listeners.clear();
  }

  private notify(): void {
    for (const listener of [...this.listeners]) listener();
  }

  /** The layout changed: pages whose lines changed are drawn again. */
  private refreshAll(): void {
    if (this.disposed) return;
    let changed = false;
    for (const [page, entry] of this.entries) {
      if (page === this.live) continue;
      if (entry.signature !== this.signatureOf(page)) {
        this.draw(page);
        changed = true;
      }
    }
    if (changed) this.notify();
  }

  private signatureOf(page: number): string {
    return page === this.live ? 'live' : pageSignature(this.deps.layout.getState().layout.pages[page]);
  }

  /** One page per turn of the event loop: a first draw of the parchment must not sit in the middle of a frame. */
  private schedule(page: number): void {
    if (this.disposed || this.pending.has(page) || this.entries.has(page)) return;
    this.pending.add(page);
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      this.pending.delete(page);
      if (this.disposed) return;
      this.draw(page);
      this.notify();
    }, 0);
    this.timers.add(timer);
  }

  /** The sheet (parchment and rules) every page is drawn on; two of them, so neighbouring pages are not twins. */
  private baseFor(page: number): HTMLCanvasElement | null {
    const key = page % 2;
    const known = this.bases.get(key);
    if (known) return known;
    const width = Math.round(this.deps.pageWidth);
    const canvas = this.createCanvas(width, heightFor(width));
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    drawParchment(ctx, canvas.width, canvas.height, this.createCanvas, { seed: 301 + key * 17 });
    paintRules(ctx, canvas.width, this.direction);
    this.bases.set(key, canvas);
    return canvas;
  }

  private draw(page: number): void {
    const base = this.baseFor(page);
    if (!base) return; // no 2D canvas (a test environment): the page stays unavailable
    let entry = this.entries.get(page);
    const canvas = entry?.canvas ?? this.createCanvas(base.width, base.height);
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(base, 0, 0);
    const layoutPage = this.deps.layout.getState().layout.pages[page];
    if (page !== this.live && layoutPage) paintPageInk(ctx, canvas.width, layoutPage, this.direction);
    const signature = this.signatureOf(page);
    if (entry) {
      entry.signature = signature;
      entry.texture.needsUpdate = true;
    } else {
      const texture = new CanvasTexture(canvas);
      texture.colorSpace = SRGBColorSpace;
      texture.anisotropy = this.deps.anisotropy ?? 4;
      entry = { texture, canvas, signature };
      this.entries.set(page, entry);
    }
  }
}
