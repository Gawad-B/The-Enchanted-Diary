import { Texture } from 'three';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { setTextureRenderer, textureAnisotropy, uploadTexture } from '../../src/pdf/textureUpload';

/* A new page texture is uploaded to the GPU (`renderer.initTexture`) when the page source hands it to the book. */

afterEach(() => {
  setTextureRenderer(null);
});

function renderer(maxAnisotropy = 16) {
  return { initTexture: vi.fn(), capabilities: { getMaxAnisotropy: () => maxAnisotropy } };
}

describe('uploadTexture', () => {
  it("uploads the texture through the scene's renderer, now", () => {
    const gl = renderer();
    setTextureRenderer(gl);
    const texture = new Texture();
    uploadTexture(texture);
    expect(gl.initTexture).toHaveBeenCalledExactlyOnceWith(texture);
  });

  it('does nothing without a renderer (the first draw uploads it) and after the scene is gone', () => {
    const texture = new Texture();
    expect(() => {
      uploadTexture(texture);
    }).not.toThrow();
    const gl = renderer();
    setTextureRenderer(gl);
    setTextureRenderer(null);
    uploadTexture(texture);
    expect(gl.initTexture).not.toHaveBeenCalled();
  });

  it("filters with the GPU's anisotropy, up to 8", () => {
    expect(textureAnisotropy()).toBe(4); // no renderer yet
    setTextureRenderer(renderer(16));
    expect(textureAnisotropy()).toBe(8);
    setTextureRenderer(renderer(2));
    expect(textureAnisotropy()).toBe(2);
  });
});
