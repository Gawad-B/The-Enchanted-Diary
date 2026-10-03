import type { Texture } from 'three';
import type { LeafFace } from './bookLayout';

/**
 * Where the textures of the book's faces come from. The 3D book asks a source for the texture of each face
 * it shows; the source decides how it is made (procedural parchment before a document is loaded, rendered PDF
 * pages after). The interface is deliberately generic so the PDF-backed source can replace the parchment one.
 */
export interface PageTextureSource {
  readonly id: string;
  /**
   * The texture of a face, or null while it is not ready (the book shows plain parchment meanwhile). A source may give a
   * stand-in of the right colour instead (`isReady` is still false until the final texture is there).
   */
  getTexture(face: LeafFace): Texture | null;
  /** True once `getTexture(face)` returns the face's final texture. */
  isReady(face: LeafFace): boolean;
  /** Asks for faces to be prepared, most urgent first. */
  request(faces: readonly LeafFace[]): void;
  /** Called whenever a texture became available or changed. Returns the unsubscribe function. */
  subscribe(listener: () => void): () => void;
  /** Releases every texture the source created. */
  dispose(): void;
}

/**
 * The source the 3D book currently reads from. The scene registers the parchment source; the PDF engine
 * replaces it once a document is loaded (and must hand back every face it does not draw to the parchment).
 */
export interface PageSourceRegistry {
  get(): PageTextureSource | null;
  set(source: PageTextureSource | null): void;
  subscribe(listener: () => void): () => void;
}

export function createPageSourceRegistry(): PageSourceRegistry {
  let current: PageTextureSource | null = null;
  const listeners = new Set<() => void>();
  return {
    get: () => current,
    set: (source) => {
      if (source === current) return;
      current = source;
      for (const listener of [...listeners]) listener();
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

export const pageSourceRegistry = createPageSourceRegistry();

/**
 * The scene's own parchment source (the faces that are not PDF pages). The scene writes it; the registry above holds the
 * source the book actually reads, which is this one until a document is loaded and the PDF-backed source after.
 */
export const parchmentSourceSlot = createPageSourceRegistry();
