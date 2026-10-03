import { BufferAttribute, BufferGeometry, DynamicDrawUsage } from 'three';
import { BOARD_OVERHANG, PAGE_H } from './dimensions';

/*
 * The spine: the leather that joins the two boards, a rounded back with raised cords. It is an elliptical
 * arc from the top of the front board, around the outside of the hinge, to the table. As the cover opens
 * the arc flattens (the front board comes down to the table), so the geometry is rewritten in place while
 * the cover moves: a few thousand vertices, no allocation.
 *
 * Details of a bound spine: five raised cords (flat-topped, steep-sided, about 2 mm high and 6 mm wide, which the
 * texture gilds on either side), a rolled headcap at the head and the tail, a shallow French groove where the
 * leather meets each board, and a cap that closes each end of the shell (a hollow shell seen from the head or the
 * tail is a see-through torn flap).
 */

export const SPINE_ARC_SEGMENTS = 28;
export const SPINE_LENGTH_SEGMENTS = 144;
export const SPINE_LENGTH = PAGE_H + 2 * BOARD_OVERHANG;
/** Cord positions as fractions of the half length. Symmetric about the middle: a half turn leaves them as they were. */
export const BAND_FRACTIONS = [-0.64, -0.32, 0, 0.32, 0.64] as const;
const BAND_HEIGHT = 0.022;
const BAND_HALF_WIDTH = 0.034;
/** The part of a cord's half width that is flat on top; the rest is the steep side. */
const PLATEAU = 0.55;
/** The headcap: a roll of leather this thick (scene units) over this length at each end. */
const CAP_HEIGHT = 0.012;
const CAP_LENGTH = 0.06;
/** The French groove: this deep, at this fraction of the arc from each board. */
const GROOVE_DEPTH = 0.006;
const GROOVE_AT = 0.036;
const GROOVE_WIDTH = 0.012;

export interface SpineProfile {
  /** 0 closed .. 1 open: the raised cords flatten as the cover opens (they would poke through the pages). */
  open: number;
  /** +1 when the book is laid out LTR (the spine bulges towards -x), -1 for RTL. */
  outward: 1 | -1;
  /** Height of the top of the spine at the hinge. */
  yTop: number;
}

/** The height and slope along the spine of the cords: flat on top, steep at the sides. */
function bump(z: number): { height: number; slope: number } {
  let height = 0;
  let slope = 0;
  const half = SPINE_LENGTH / 2;
  for (const fraction of BAND_FRACTIONS) {
    const d = (z - fraction * half) / BAND_HALF_WIDTH;
    const a = Math.abs(d);
    if (a >= 1) continue;
    if (a <= PLATEAU) {
      height += 1;
      continue;
    }
    const t = (a - PLATEAU) / (1 - PLATEAU);
    height += 1 - t * t * (3 - 2 * t);
    slope += ((-6 * t * (1 - t)) / (1 - PLATEAU) / BAND_HALF_WIDTH) * Math.sign(d);
  }
  return { height, slope };
}

/** How far the roll of the headcap stands out at `z` (0 away from the ends): a quarter-round bead, full at the very end. */
function capRoll(z: number): number {
  const fromEnd = SPINE_LENGTH / 2 - Math.abs(z);
  if (fromEnd >= CAP_LENGTH) return 0;
  const t = Math.max(fromEnd, 0) / CAP_LENGTH;
  return CAP_HEIGHT * Math.sqrt(Math.max(1 - t * t, 0));
}

/** The French groove along the arc: how deep it is at `u` (0..1 along the arc). */
function groove(u: number): number {
  const a = (u - GROOVE_AT) / GROOVE_WIDTH;
  const b = (u - (1 - GROOVE_AT)) / GROOVE_WIDTH;
  return GROOVE_DEPTH * (Math.exp(-a * a) + Math.exp(-b * b));
}

const ARC_VERTICES = (SPINE_LENGTH_SEGMENTS + 1) * (SPINE_ARC_SEGMENTS + 1);
const CAP_VERTICES = SPINE_ARC_SEGMENTS + 2;
const HEAD = ARC_VERTICES;
const TAIL = ARC_VERTICES + CAP_VERTICES;

export function createSpineGeometry(): BufferGeometry {
  const columns = SPINE_LENGTH_SEGMENTS;
  const rows = SPINE_ARC_SEGMENTS;
  const count = ARC_VERTICES + 2 * CAP_VERTICES;
  const geometry = new BufferGeometry();
  const position = new BufferAttribute(new Float32Array(count * 3), 3);
  const normal = new BufferAttribute(new Float32Array(count * 3), 3);
  position.setUsage(DynamicDrawUsage);
  normal.setUsage(DynamicDrawUsage);
  geometry.setAttribute('position', position);
  geometry.setAttribute('normal', normal);
  const uvs = new Float32Array(count * 2);
  for (let row = 0; row <= rows; row += 1) {
    for (let column = 0; column <= columns; column += 1) {
      uvs.set([row / rows, column / columns], (row * (columns + 1) + column) * 2);
    }
  }
  // The caps sample the leather at the end of the arc (v = 0 at the head, 1 at the tail), the centre in the middle.
  for (const [base, v] of [
    [HEAD, 0],
    [TAIL, 1],
  ] as const) {
    for (let row = 0; row <= rows; row += 1) uvs.set([row / rows, v], (base + row) * 2);
    uvs.set([0.5, v], (base + rows + 1) * 2);
  }
  geometry.setAttribute('uv', new BufferAttribute(uvs, 2));
  geometry.setIndex(spineIndices(1));
  return geometry;
}

/** Triangle order for the outward direction: mirroring the arc reverses the winding. */
export function spineIndices(outward: 1 | -1): number[] {
  const columns = SPINE_LENGTH_SEGMENTS;
  const rows = SPINE_ARC_SEGMENTS;
  const indices: number[] = [];
  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column < columns; column += 1) {
      const a = row * (columns + 1) + column;
      const b = a + (columns + 1);
      const c = a + 1;
      const d = b + 1;
      if (outward === 1) indices.push(a, b, c, c, b, d);
      else indices.push(a, c, b, c, d, b);
    }
  }
  // The two caps, as fans from the middle of the ellipse; the head cap faces -z, the tail cap +z.
  for (const [base, facesTail] of [
    [HEAD, false],
    [TAIL, true],
  ] as const) {
    const centre = base + rows + 1;
    // For an LTR spine the tail cap runs counter-clockwise seen from +z; the head cap, seen from -z, the other way.
    const flip = (outward === 1) === facesTail;
    for (let row = 0; row < rows; row += 1) {
      if (flip) indices.push(centre, base + row, base + row + 1);
      else indices.push(centre, base + row + 1, base + row);
    }
  }
  return indices;
}

/** Rewrites the spine for the current cover height. Returns the bulge (x extent) so callers can use it. */
export function updateSpineGeometry(
  geometry: BufferGeometry,
  profile: SpineProfile,
  previousOutward: 1 | -1 | null,
): number {
  const position = geometry.getAttribute('position') as BufferAttribute;
  const normal = geometry.getAttribute('normal') as BufferAttribute;
  const columns = SPINE_LENGTH_SEGMENTS;
  const rows = SPINE_ARC_SEGMENTS;
  const yBottom = 0;
  const ry = Math.max((profile.yTop - yBottom) / 2, 0.004);
  const yc = (profile.yTop + yBottom) / 2;
  const rx = Math.max(ry * 0.92, 0.012);
  const bandScale = (1 - Math.min(Math.max(profile.open, 0), 1)) ** 2;
  // The arc never goes above the top of the board or below the table, whatever sits on it.
  for (let row = 0; row <= rows; row += 1) {
    // From the top of the front board (phi = pi / 2) around the outside to the table (phi = -pi / 2).
    const phi = Math.PI / 2 - (row / rows) * Math.PI;
    const cosPhi = Math.cos(phi);
    const sinPhi = Math.sin(phi);
    const nx = (-profile.outward * cosPhi) / rx;
    const ny = sinPhi / ry;
    const nLength = Math.hypot(nx, ny) || 1;
    // Raised cords and the headcap rise only along the back of the spine (a squared sine window), never over the
    // edges of the boards; the groove is the opposite: it is at the edges.
    const window = Math.sin(Math.PI * (row / rows)) ** 2;
    const sink = groove(row / rows) * (1 - Math.min(Math.max(profile.open, 0), 1) * 0.5);
    for (let column = 0; column <= columns; column += 1) {
      const z = -SPINE_LENGTH / 2 + (column / columns) * SPINE_LENGTH;
      const { height, slope } = bump(z);
      const radial = BAND_HEIGHT * bandScale * height * window + capRoll(z) * window - sink;
      const index = row * (columns + 1) + column;
      position.setXYZ(
        index,
        -profile.outward * rx * cosPhi + (nx / nLength) * radial,
        yc + ry * sinPhi + (ny / nLength) * radial,
        z,
      );
      const tilt = -BAND_HEIGHT * bandScale * slope * window * 0.6;
      const length = Math.hypot(nx / nLength, ny / nLength, tilt) || 1;
      normal.setXYZ(index, nx / nLength / length, ny / nLength / length, tilt / length);
    }
  }
  // The caps: the rim copies the first and last column's vertices, with the cap's own normal; the middle of the
  // ellipse is the centre of the fan.
  for (const [base, column, sign] of [
    [HEAD, 0, -1],
    [TAIL, columns, 1],
  ] as const) {
    for (let row = 0; row <= rows; row += 1) {
      const source = row * (columns + 1) + column;
      position.setXYZ(base + row, position.getX(source), position.getY(source), position.getZ(source));
      normal.setXYZ(base + row, 0, 0, sign);
    }
    position.setXYZ(base + rows + 1, 0, yc, (sign * SPINE_LENGTH) / 2);
    normal.setXYZ(base + rows + 1, 0, 0, sign);
  }
  position.needsUpdate = true;
  normal.needsUpdate = true;
  if (previousOutward !== profile.outward) geometry.setIndex(spineIndices(profile.outward));
  geometry.computeBoundingSphere();
  return rx;
}
