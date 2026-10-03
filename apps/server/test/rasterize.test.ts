import { loadImage } from '@napi-rs/canvas';
import { describe, expect, it } from 'vitest';
import { closePdf, loadPdf } from '../src/pdf/load.js';
import { MAX_RASTER_SIDE, rasterScale, rasterizePage } from '../src/pdf/rasterize.js';
import { readFixture } from './fixtures.js';

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

async function withDocument<T>(name: string, run: (doc: Awaited<ReturnType<typeof loadPdf>>) => Promise<T>) {
  const doc = await loadPdf(new Uint8Array(await readFixture(name)));
  try {
    return await run(doc);
  } finally {
    await closePdf(doc);
  }
}

describe('rasterScale', () => {
  it('is the DPI over 72 for an ordinary page', () => {
    expect(rasterScale(612, 792, 200)).toBeCloseTo(200 / 72, 10);
    expect(rasterScale(612, 792, 72)).toBe(1);
  });

  it('caps the longest side at 3000 pixels for a large page', () => {
    expect(MAX_RASTER_SIDE).toBe(3000);
    // An A1 poster at 200 DPI would be 6600 x 9400 pixels.
    const scale = rasterScale(1684, 2384, 200);
    expect(Math.max(1684, 2384) * scale).toBeCloseTo(3000, 6);
    expect(rasterScale(2000, 1000, 600) * 2000).toBeCloseTo(3000, 6);
  });
});

describe('rasterizePage', () => {
  it('renders a page at the requested DPI as a PNG with its pixel size', async () => {
    await withDocument('text-en.pdf', async (doc) => {
      const raster = await rasterizePage(doc, 2, { dpi: 200 });
      expect(raster.png.subarray(0, 8).equals(PNG_SIGNATURE)).toBe(true);
      expect([raster.width, raster.height]).toEqual([1700, 2200]); // 612 x 792 points at 200 DPI
      const image = await loadImage(raster.png);
      expect([image.width, image.height]).toEqual([raster.width, raster.height]);
    });
  });

  it('draws on a white background and really draws the text', async () => {
    await withDocument('text-en.pdf', async (doc) => {
      const raster = await rasterizePage(doc, 2, { dpi: 100 });
      const { createCanvas, loadImage: load } = await import('@napi-rs/canvas');
      const image = await load(raster.png);
      const canvas = createCanvas(image.width, image.height);
      const context = canvas.getContext('2d');
      context.drawImage(image, 0, 0);
      const pixels = context.getImageData(0, 0, image.width, image.height).data;
      expect([...pixels.subarray(0, 4)]).toEqual([255, 255, 255, 255]); // the corner is opaque white
      let dark = 0;
      for (let i = 0; i < pixels.length; i += 4) if ((pixels[i] ?? 255) < 100) dark += 1;
      expect(dark).toBeGreaterThan(2000); // the heading and three paragraphs
    });
  });

  it('renders a blank page as opaque white, not transparent black', async () => {
    await withDocument('empty.pdf', async (doc) => {
      const raster = await rasterizePage(doc, 1, { dpi: 50 });
      const { createCanvas, loadImage: load } = await import('@napi-rs/canvas');
      const image = await load(raster.png);
      const canvas = createCanvas(image.width, image.height);
      const context = canvas.getContext('2d');
      context.drawImage(image, 0, 0);
      const pixels = context.getImageData(0, 0, image.width, image.height).data;
      expect(pixels.every((value) => value === 255)).toBe(true);
    });
  });

  it('shows a rotated page the way it is displayed (width and height swapped)', async () => {
    await withDocument('rotated.pdf', async (doc) => {
      const raster = await rasterizePage(doc, 1, { dpi: 72 });
      expect([raster.width, raster.height]).toEqual([842, 595]);
    });
  });

  it('keeps the scale within the cap: the PNG never exceeds 3000 pixels on a side', async () => {
    await withDocument('text-en.pdf', async (doc) => {
      const raster = await rasterizePage(doc, 1, { dpi: 600 }); // 5100 x 6600 uncapped
      expect(Math.max(raster.width, raster.height)).toBeLessThanOrEqual(3000);
      expect(Math.max(raster.width, raster.height)).toBeGreaterThanOrEqual(2999);
    });
  });
});
