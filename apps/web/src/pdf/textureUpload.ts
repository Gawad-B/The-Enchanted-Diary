import type { Texture, WebGLRenderer } from 'three';

/*
 * A page texture is uploaded to the GPU the first time a frame draws it, which for a 1200 x 1680 texture with mipmaps is a
 * stall of several milliseconds in the middle of whatever that frame was doing. `renderer.initTexture()` does the same work
 * at a moment of our choosing: the page source calls `uploadTexture` when it hands a freshly drawn page to the book, which is
 * always after the turn that was animating when it finished (see PdfPageSource), so the first draw finds it already there.
 * The scene gives the renderer in.
 */

type UploadingRenderer = Pick<WebGLRenderer, 'initTexture'> & {
  capabilities?: Pick<WebGLRenderer['capabilities'], 'getMaxAnisotropy'>;
};

let renderer: UploadingRenderer | null = null;

/** The scene's renderer (null when the scene goes away: textures then upload on first use, as usual). */
export function setTextureRenderer(next: UploadingRenderer | null): void {
  renderer = next;
}

/** The anisotropy page textures are filtered with: the GPU's, up to 8. */
export function textureAnisotropy(): number {
  return Math.min(8, renderer?.capabilities?.getMaxAnisotropy() ?? 4);
}

/** Uploads `texture` now (a no-op without a renderer: the first draw uploads it). */
export function uploadTexture(texture: Texture): void {
  renderer?.initTexture(texture);
}
