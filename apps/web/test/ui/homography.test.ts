import { describe, expect, it } from 'vitest';
import {
  applyHomography,
  cssMatrix3d,
  homography,
  pageMatrix,
  rectQuad,
  type Quad,
} from '../../src/ui/diary/homography';

const close = (a: number, b: number) => expect(a).toBeCloseTo(b, 4);

describe('homography', () => {
  it('maps a rectangle onto a trapezoid corner by corner', () => {
    const page = rectQuad(520, 728);
    const screen: Quad = [
      { x: 310, y: 120 },
      { x: 960, y: 118 },
      { x: 1010, y: 820 },
      { x: 270, y: 822 },
    ];
    const h = homography(page, screen);
    expect(h).not.toBeNull();
    if (!h) return;
    page.forEach((corner, i) => {
      const mapped = applyHomography(h, corner);
      close(mapped.x, screen[i]?.x ?? NaN);
      close(mapped.y, screen[i]?.y ?? NaN);
    });
  });

  it('keeps straight lines straight and sends the centre of the page where the diagonals of the quad cross', () => {
    const screen: Quad = [
      { x: 100, y: 100 },
      { x: 500, y: 100 },
      { x: 600, y: 500 },
      { x: 0, y: 500 },
    ];
    const h = homography(rectQuad(10, 10), screen);
    if (!h) throw new Error('no map');
    const centre = applyHomography(h, { x: 5, y: 5 });
    // The diagonals of a symmetric trapezoid meet on its axis, x = 300.
    close(centre.x, 300);
    expect(centre.y).toBeGreaterThan(100);
    expect(centre.y).toBeLessThan(500);
    // Perspective: the nearer (lower, wider) half of the page takes more of the screen than the far half.
    const middleFar = applyHomography(h, { x: 5, y: 0 }).y;
    const middleNear = applyHomography(h, { x: 5, y: 10 }).y;
    expect(centre.y - middleFar).toBeLessThan(middleNear - centre.y);
  });

  it('is the identity (up to a translation) for the same rectangle', () => {
    const h = homography(rectQuad(100, 100), [
      { x: 20, y: 30 },
      { x: 120, y: 30 },
      { x: 120, y: 130 },
      { x: 20, y: 130 },
    ]);
    if (!h) throw new Error('no map');
    const point = applyHomography(h, { x: 50, y: 50 });
    close(point.x, 70);
    close(point.y, 80);
  });

  it('gives no map for a degenerate quad (all four corners on one line)', () => {
    const line: Quad = [
      { x: 0, y: 0 },
      { x: 1, y: 1 },
      { x: 2, y: 2 },
      { x: 3, y: 3 },
    ];
    expect(homography(rectQuad(10, 10), line)).toBeNull();
  });

  it('writes the map as a CSS matrix3d with the perspective terms in the right places', () => {
    const h = homography(rectQuad(520, 728), [
      { x: 0, y: 0 },
      { x: 520, y: 0 },
      { x: 520, y: 728 },
      { x: 0, y: 728 },
    ]);
    if (!h) throw new Error('no map');
    expect(cssMatrix3d(h)).toBe('matrix3d(1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1)');
    const skew = homography(rectQuad(100, 100), [
      { x: 0, y: 0 },
      { x: 100, y: 0 },
      { x: 90, y: 100 },
      { x: 10, y: 100 },
    ]);
    if (!skew) throw new Error('no map');
    const values = cssMatrix3d(skew).slice('matrix3d('.length, -1).split(',').map(Number);
    expect(values).toHaveLength(16);
    // The fourth column's first two entries are the perspective terms (g, h in the map): none sideways, some with depth.
    expect(values[3]).toBeCloseTo(0, 6);
    expect(Math.abs(values[7] ?? 0)).toBeGreaterThan(0);
    // The map carries the translation in the last column and leaves z alone.
    expect(values[10]).toBe(1);
    expect(values[15]).toBe(1);
  });
});

describe('the page is never laid diagonally', () => {
  const lines = (matrix: string) => {
    const v = matrix.slice('matrix3d('.length, -1).split(',').map(Number);
    // Where the ends of a horizontal line across the middle of the surface land.
    const at = (x: number, y: number) => {
      const w = (v[3] ?? 0) * x + (v[7] ?? 0) * y + (v[15] ?? 1);
      return {
        x: ((v[0] ?? 0) * x + (v[4] ?? 0) * y + (v[12] ?? 0)) / w,
        y: ((v[1] ?? 0) * x + (v[5] ?? 0) * y + (v[13] ?? 0)) / w,
      };
    };
    const a = at(0, 364);
    const b = at(520, 364);
    return (Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI;
  };

  it('a page seen squarely keeps its perspective and its lines run parallel to the top of the screen', () => {
    const matrix = pageMatrix(
      [
        { x: 441, y: -6 },
        { x: 999, y: -6 },
        { x: 1032, y: 801 },
        { x: 408, y: 801 },
      ],
      520,
      728,
    );
    expect(Math.abs(lines(matrix ?? ''))).toBeLessThan(0.01);
  });

  it('a page the camera sees turned is laid on squarely: scale and shift only, lines horizontal', () => {
    const matrix = pageMatrix(
      [
        { x: 300, y: 100 },
        { x: 800, y: 260 },
        { x: 760, y: 820 },
        { x: 240, y: 700 },
      ],
      520,
      728,
    );
    expect(matrix).not.toBeNull();
    expect(Math.abs(lines(matrix ?? ''))).toBeLessThan(0.01);
  });
});
