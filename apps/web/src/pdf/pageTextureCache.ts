import type { NormalizedRect } from '@enchanted/shared';
import type { Texture } from 'three';
import { zeroCanvas } from './pageRenderer';

/** How finished a cached page picture is: the cheap first pass, or the tier's full width. */
export type Stage = 'quick' | 'full';

export interface CachedPage {
  texture: Texture;
  canvas: HTMLCanvasElement;
  stage: Stage;
  /** The passages this canvas glows under (null: none); compared by identity with what is wanted. */
  highlight: readonly NormalizedRect[] | null;
  /** When the book last read it (the cache's own clock); the least recent is evicted first. */
  lastUsed: number;
}

/**
 * The LRU of page textures. It knows nothing of rendering: it holds up to `size` textures, evicts the least recently used
 * page that the caller does not want (`isWanted`: the window of faces in view and near), and when it lets a texture go it
 * disposes it and zeroes its canvas, so a texture and its pixels never outlive their place here.
 */
export class PageTextureCache {
  private readonly entries = new Map<number, CachedPage>();
  private clock = 0;

  constructor(private readonly isWanted: (page: number) => boolean) {}

  get size(): number {
    return this.entries.size;
  }

  pages(): number[] {
    return [...this.entries.keys()];
  }

  /** The entry, without counting as a use. */
  peek(page: number): CachedPage | undefined {
    return this.entries.get(page);
  }

  /** The entry, counting as a use (the book reads it). */
  use(page: number): CachedPage | undefined {
    const entry = this.entries.get(page);
    if (entry) {
      this.clock += 1;
      entry.lastUsed = this.clock;
    }
    return entry;
  }

  add(page: number, entry: Omit<CachedPage, 'lastUsed'>): void {
    this.clock += 1;
    this.entries.set(page, { ...entry, lastUsed: this.clock });
  }

  /** Lets a page go: disposes its texture and zeroes its canvas. */
  evict(page: number): void {
    const entry = this.entries.get(page);
    if (!entry) return;
    this.entries.delete(page);
    entry.texture.dispose();
    zeroCanvas(entry.canvas);
  }

  /** Evicts least recently used pages outside the window until at most `size` are alive; true when any went. */
  trim(size: number): boolean {
    let evicted = false;
    while (this.entries.size > size) {
      const victim = this.victim();
      if (victim === null) break;
      this.evict(victim);
      evicted = true;
    }
    return evicted;
  }

  /**
   * Makes room for one more texture of `page`. `ok` is false when every texture alive is one the window needs, or when
   * `page` itself has left the window and the cache is full (a late render takes a place only if one is free); `evicted`
   * says whether pages were let go on the way.
   */
  makeRoom(page: number, size: number): { ok: boolean; evicted: boolean } {
    if (!this.isWanted(page) && this.entries.size >= size) return { ok: false, evicted: false };
    let evicted = false;
    while (this.entries.size >= size) {
      const victim = this.victim();
      if (victim === null) return { ok: false, evicted };
      this.evict(victim);
      evicted = true;
    }
    return { ok: true, evicted };
  }

  clear(): void {
    for (const page of [...this.entries.keys()]) this.evict(page);
  }

  /** The least recently used page that is not in the window. */
  private victim(): number | null {
    let oldest: number | null = null;
    let age = Infinity;
    for (const [page, entry] of this.entries) {
      if (this.isWanted(page) || entry.lastUsed >= age) continue;
      oldest = page;
      age = entry.lastUsed;
    }
    return oldest;
  }
}
