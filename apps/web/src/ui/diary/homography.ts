/*
 * Laying a flat piece of the interface onto a page of the 3D book. The page is a quadrilateral on the screen (four corners
 * projected from the scene); the surface is a rectangle in CSS px. The projective map between them is a 3 by 3 matrix, and CSS
 * can apply it as a `matrix3d`: the real textarea, the ink and the notes then lie on the page with its perspective, and the
 * browser still treats them as ordinary, focusable, selectable elements.
 */

export interface Point {
  x: number;
  y: number;
}

export type Quad = readonly [Point, Point, Point, Point];

/** The eight coefficients a..h of the map (x, y) to ((a x + b y + c) / (g x + h y + 1), (d x + e y + f) / (g x + h y + 1)). */
export type Homography = readonly [number, number, number, number, number, number, number, number];

function rowOf<T>(rows: readonly T[], index: number): T {
  const found = rows[index];
  if (found === undefined) throw new RangeError(`no row ${String(index)}`);
  return found;
}

/** Solves a small linear system by Gaussian elimination with partial pivoting; null when it is singular. */
function solve(matrix: number[][], rhs: number[]): number[] | null {
  const n = rhs.length;
  const a = matrix.map((row, i) => [...row, rhs[i] ?? 0]);
  for (let column = 0; column < n; column += 1) {
    let pivot = column;
    for (let row = column + 1; row < n; row += 1) {
      if (Math.abs(a[row]?.[column] ?? 0) > Math.abs(a[pivot]?.[column] ?? 0)) pivot = row;
    }
    const top = a[pivot];
    if (!top || Math.abs(top[column] ?? 0) < 1e-12) return null;
    [a[column], a[pivot]] = [top, rowOf(a, column)];
    const lead = rowOf(a, column);
    for (let row = column + 1; row < n; row += 1) {
      const current = rowOf(a, row);
      const factor = (current[column] ?? 0) / (lead[column] ?? 1);
      for (let k = column; k <= n; k += 1) current[k] = (current[k] ?? 0) - factor * (lead[k] ?? 0);
    }
  }
  const x = new Array<number>(n).fill(0);
  for (let row = n - 1; row >= 0; row -= 1) {
    const current = rowOf(a, row);
    let sum = current[n] ?? 0;
    for (let k = row + 1; k < n; k += 1) sum -= (current[k] ?? 0) * (x[k] ?? 0);
    x[row] = sum / (current[row] ?? 1);
  }
  return x;
}

/** The projective map taking the corners `from` to the corners `to` (in the same order), or null for a degenerate quad. */
export function homography(from: Quad, to: Quad): Homography | null {
  const rows: number[][] = [];
  const rhs: number[] = [];
  for (let i = 0; i < 4; i += 1) {
    const { x, y } = rowOf(from, i);
    const { x: u, y: v } = rowOf(to, i);
    rows.push([x, y, 1, 0, 0, 0, -x * u, -y * u]);
    rhs.push(u);
    rows.push([0, 0, 0, x, y, 1, -x * v, -y * v]);
    rhs.push(v);
  }
  const solved = solve(rows, rhs);
  return solved?.length === 8 ? (solved as unknown as Homography) : null;
}

/** Where the map takes a point. */
export function applyHomography(h: Homography, point: Point): Point {
  const [a, b, c, d, e, f, g, hh] = h;
  const w = g * point.x + hh * point.y + 1;
  return { x: (a * point.x + b * point.y + c) / w, y: (d * point.x + e * point.y + f) / w };
}

/** The CSS `matrix3d(...)` of the map (column-major; z is left alone). Use with `transform-origin: 0 0`. */
export function cssMatrix3d(h: Homography): string {
  const [a, b, c, d, e, f, g, hh] = h;
  const values = [a, d, 0, g, b, e, 0, hh, 0, 0, 1, 0, c, f, 0, 1];
  return `matrix3d(${values.map((value) => String(Math.round(value * 1e7) / 1e7)).join(',')})`;
}

/** The corners of a rectangle at the origin, in the order the quads of the anchors are (top left, top right, bottom right, bottom left). */
export function rectQuad(width: number, height: number): Quad {
  return [
    { x: 0, y: 0 },
    { x: width, y: 0 },
    { x: width, y: height },
    { x: 0, y: height },
  ];
}

/** How far the lines of the page (a horizontal line across it) are turned on the screen, in degrees: 0 when parallel to the screen's top. */
export function baselineAngle(h: Homography, width: number, height: number): number {
  const a = applyHomography(h, { x: 0, y: height / 2 });
  const b = applyHomography(h, { x: width, y: height / 2 });
  return (Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI;
}

/** The most the lines may be turned (degrees) before the page is laid on the screen squarely instead. */
export const MAX_TILT_DEG = 0.75;

/**
 * The CSS matrix that lays a `width` by `height` surface on the quad of a page: its perspective when the page is seen squarely
 * (its lines parallel to the top of the screen), and otherwise a plain scale and shift onto the middle of the page, so that the
 * writing is never diagonal or skewed whatever the camera does.
 */
export function pageMatrix(quad: Quad, width: number, height: number): string | null {
  const map = homography(rectQuad(width, height), quad);
  if (map && Math.abs(baselineAngle(map, width, height)) <= MAX_TILT_DEG) return cssMatrix3d(map);
  const xs = quad.map((p) => p.x);
  const ys = quad.map((p) => p.y);
  const pageWidth = Math.max(...xs) - Math.min(...xs);
  const pageHeight = Math.max(...ys) - Math.min(...ys);
  const scale = Math.min(pageWidth / width, pageHeight / height);
  if (!(scale > 0) || !Number.isFinite(scale)) return null;
  const x = (Math.min(...xs) + Math.max(...xs)) / 2 - (width * scale) / 2;
  const y = (Math.min(...ys) + Math.max(...ys)) / 2 - (height * scale) / 2;
  return `matrix3d(${String(scale)},0,0,0,0,${String(scale)},0,0,0,0,1,0,${String(x)},${String(y)},0,1)`;
}
