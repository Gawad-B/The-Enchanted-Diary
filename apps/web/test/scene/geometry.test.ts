import { Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import { PAGE_H, PAGE_W } from '../../src/scene/book/dimensions';
import { buildLeafGeometry } from '../../src/scene/book/leafGeometry';
import {
  BAND_FRACTIONS,
  createSpineGeometry,
  SPINE_ARC_SEGMENTS,
  SPINE_LENGTH,
  SPINE_LENGTH_SEGMENTS,
  spineIndices,
  updateSpineGeometry,
} from '../../src/scene/book/spineGeometry';

/** Normal of triangle `index` of an indexed geometry after the vertex shader's x mirror (`uSide`). */
function mirroredNormal(
  geometry: ReturnType<typeof buildLeafGeometry>,
  triangle: number,
  side: 1 | -1,
): Vector3 {
  const index = geometry.getIndex();
  const position = geometry.getAttribute('position');
  if (!index) throw new Error('no index');
  const corner = (n: number): Vector3 => {
    const i = index.getX(triangle * 3 + n);
    return new Vector3(side * position.getX(i), position.getY(i), position.getZ(i));
  };
  const a = corner(0);
  const b = corner(1);
  const c = corner(2);
  return b.sub(a).cross(c.sub(a)).normalize();
}

describe('leaf geometry', () => {
  it('spans the spine to the fore-edge and the page height, flat at y = 0', () => {
    for (const direction of ['ltr', 'rtl'] as const) {
      const geometry = buildLeafGeometry(direction, 12);
      geometry.computeBoundingBox();
      const box = geometry.boundingBox;
      expect(box?.min.x).toBeCloseTo(0);
      expect(box?.max.x).toBeCloseTo(PAGE_W);
      expect(box?.min.z).toBeCloseTo(-PAGE_H / 2);
      expect(box?.max.z).toBeCloseTo(PAGE_H / 2);
      expect(box?.min.y).toBe(0);
      expect(box?.max.y).toBe(0);
    }
  });

  it('has (segments + 1) x 5 vertices and two triangles per cell', () => {
    const geometry = buildLeafGeometry('ltr', 24);
    expect(geometry.getAttribute('position').count).toBe(25 * 5);
    expect(geometry.getIndex()?.count).toBe(24 * 4 * 6);
  });

  it('the front face always faces up after the shader mirrors x for RTL: gl_FrontFacing means "front"', () => {
    for (const [direction, side] of [
      ['ltr', 1],
      ['rtl', -1],
    ] as const) {
      const geometry = buildLeafGeometry(direction, 6);
      const triangles = (geometry.getIndex()?.count ?? 0) / 3;
      for (let triangle = 0; triangle < triangles; triangle += 1) {
        expect(mirroredNormal(geometry, triangle, side).y).toBeGreaterThan(0.999);
      }
    }
  });

  it('without the mirror an RTL leaf would face down (so the winding flip is necessary)', () => {
    expect(mirroredNormal(buildLeafGeometry('rtl', 6), 0, 1).y).toBeLessThan(-0.999);
  });

  it('LTR: u grows with the distance from the spine; RTL: u shrinks with it', () => {
    const uv = (direction: 'ltr' | 'rtl') => buildLeafGeometry(direction, 4).getAttribute('uv');
    const ltr = uv('ltr');
    const rtl = uv('rtl');
    expect(ltr.getX(0)).toBe(0);
    expect(ltr.getX(4)).toBe(1);
    expect(rtl.getX(0)).toBe(1);
    expect(rtl.getX(4)).toBe(0);
  });

  it('u runs left to right on screen for the front face in the unturned pose, in both directions', () => {
    for (const [direction, side] of [
      ['ltr', 1],
      ['rtl', -1],
    ] as const) {
      const geometry = buildLeafGeometry(direction, 4);
      const position = geometry.getAttribute('position');
      const uv = geometry.getAttribute('uv');
      // Screen x of a vertex in the unturned pose is side * s; u must increase with it.
      const first = side * position.getX(0);
      const last = side * position.getX(4);
      const direct = (uv.getX(4) - uv.getX(0)) * (last - first);
      expect(direct).toBeGreaterThan(0);
    }
  });

  it('v is 1 at the head of the page (the far side, -z) and 0 at the tail', () => {
    const geometry = buildLeafGeometry('ltr', 4);
    const position = geometry.getAttribute('position');
    const uv = geometry.getAttribute('uv');
    const last = position.count - 1;
    expect(position.getZ(0)).toBeCloseTo(-PAGE_H / 2);
    expect(uv.getY(0)).toBe(1);
    expect(position.getZ(last)).toBeCloseTo(PAGE_H / 2);
    expect(uv.getY(last)).toBe(0);
  });

  it('has a generous bounding sphere so a bent leaf is never culled', () => {
    expect(buildLeafGeometry('ltr', 8).boundingSphere?.radius).toBeGreaterThan(PAGE_W * 2);
  });
});

describe('spine geometry', () => {
  const vertex = (geometry: ReturnType<typeof createSpineGeometry>, row: number, column: number) => {
    const position = geometry.getAttribute('position');
    const i = row * (SPINE_LENGTH_SEGMENTS + 1) + column;
    return new Vector3(position.getX(i), position.getY(i), position.getZ(i));
  };

  it('is an arc from the top of the front board, round the outside of the hinge, to the table', () => {
    const geometry = createSpineGeometry();
    updateSpineGeometry(geometry, { outward: 1, yTop: 0.4, open: 0 }, null);
    const column = SPINE_LENGTH_SEGMENTS / 2 + 1; // between bands
    expect(vertex(geometry, 0, column).y).toBeCloseTo(0.4, 2);
    expect(vertex(geometry, SPINE_ARC_SEGMENTS, column).y).toBeCloseTo(0, 2);
    const middle = vertex(geometry, SPINE_ARC_SEGMENTS / 2, column);
    expect(middle.y).toBeCloseTo(0.2, 2);
    // LTR: the spine bulges towards -x; RTL towards +x.
    expect(middle.x).toBeLessThan(-0.1);
    updateSpineGeometry(geometry, { outward: -1, yTop: 0.4, open: 0 }, 1);
    expect(vertex(geometry, SPINE_ARC_SEGMENTS / 2, column).x).toBeGreaterThan(0.1);
  });

  it('flattens as the cover comes down: an open book has a thin spine', () => {
    const geometry = createSpineGeometry();
    updateSpineGeometry(geometry, { outward: 1, yTop: 0.04, open: 1 }, null);
    const middle = vertex(geometry, SPINE_ARC_SEGMENTS / 2, 3);
    expect(Math.abs(middle.x)).toBeLessThan(0.03);
    expect(middle.y).toBeLessThan(0.05);
  });

  it('the raised bands are symmetric about the middle of the spine (a half turn leaves them as they were)', () => {
    const fractions = [...BAND_FRACTIONS];
    for (const fraction of fractions) expect(fractions).toContain(-fraction);
    const geometry = createSpineGeometry();
    updateSpineGeometry(geometry, { outward: 1, yTop: 0.4, open: 0 }, null);
    const row = SPINE_ARC_SEGMENTS / 2;
    for (let column = 0; column <= SPINE_LENGTH_SEGMENTS; column += 1) {
      const a = vertex(geometry, row, column);
      const b = vertex(geometry, row, SPINE_LENGTH_SEGMENTS - column);
      expect(a.x).toBeCloseTo(b.x, 4);
      expect(a.y).toBeCloseTo(b.y, 4);
      expect(a.z).toBeCloseTo(-b.z, 4);
    }
  });

  it('a band stands proud of the leather between the bands, and not at all once the cover is open', () => {
    const closed = createSpineGeometry();
    updateSpineGeometry(closed, { outward: 1, yTop: 0.4, open: 0 }, null);
    const row = SPINE_ARC_SEGMENTS / 2;
    const columnOf = (fraction: number): number =>
      Math.round(((fraction * (SPINE_LENGTH / 2) + SPINE_LENGTH / 2) / SPINE_LENGTH) * SPINE_LENGTH_SEGMENTS);
    const bandColumn = columnOf(BAND_FRACTIONS[3]);
    const gapColumn = columnOf(0.16); // between the band in the middle and the next
    expect(Math.abs(vertex(closed, row, bandColumn).x)).toBeGreaterThan(
      Math.abs(vertex(closed, row, gapColumn).x) + 0.01,
    );
    const open = createSpineGeometry();
    updateSpineGeometry(open, { outward: 1, yTop: 0.4, open: 1 }, null);
    expect(vertex(open, row, bandColumn).x).toBeCloseTo(vertex(open, row, gapColumn).x, 4);
  });

  it('normals have unit length and point away from the middle of the book', () => {
    const geometry = createSpineGeometry();
    updateSpineGeometry(geometry, { outward: 1, yTop: 0.4, open: 0 }, null);
    const normal = geometry.getAttribute('normal');
    const i = (SPINE_ARC_SEGMENTS / 2) * (SPINE_LENGTH_SEGMENTS + 1) + 5;
    expect(new Vector3(normal.getX(i), normal.getY(i), normal.getZ(i)).length()).toBeCloseTo(1, 4);
    expect(normal.getX(i)).toBeLessThan(-0.9);
  });

  it('mirrors the triangle order for the other direction', () => {
    const ltr = spineIndices(1);
    const rtl = spineIndices(-1);
    expect(ltr).toHaveLength(rtl.length);
    expect(ltr).not.toEqual(rtl);
    expect(new Set(ltr.slice(0, 3))).toEqual(new Set(rtl.slice(0, 3)));
  });

  it('has five raised cords, one of them in the middle: the pattern is symmetric and classic', () => {
    expect([...BAND_FRACTIONS]).toHaveLength(5);
    expect(BAND_FRACTIONS).toContain(0);
  });

  it('a cord has a flat top and steep sides (a plateau about 2 mm high and 5 to 6 mm wide), not a lump', () => {
    const geometry = createSpineGeometry();
    updateSpineGeometry(geometry, { outward: 1, yTop: 0.4, open: 0 }, null);
    const row = SPINE_ARC_SEGMENTS / 2;
    const middle = SPINE_LENGTH_SEGMENTS / 2;
    const reach = (column: number): number => Math.abs(vertex(geometry, row, column).x);
    const flat = reach(middle + 40); // between cords
    const top = reach(middle) - flat;
    expect(top).toBeGreaterThan(0.018);
    expect(top).toBeLessThan(0.03);
    // One column either side of the middle is still on the plateau (the columns are about 1.6 mm apart).
    expect(reach(middle + 1) - flat).toBeGreaterThan(top * 0.8);
    expect(reach(middle - 1) - flat).toBeGreaterThan(top * 0.8);
    // Three columns on (5 mm from the middle) it is back on the leather.
    expect(reach(middle + 3) - flat).toBeLessThan(top * 0.2);
  });

  it('is closed at the head and the tail: nothing of the shell is open to see through', () => {
    for (const outward of [1, -1] as const) {
      const geometry = createSpineGeometry();
      updateSpineGeometry(geometry, { outward: 1, yTop: 0.4, open: 0 }, null);
      if (outward === -1) updateSpineGeometry(geometry, { outward: -1, yTop: 0.4, open: 0 }, 1);
      const position = geometry.getAttribute('position');
      const normal = geometry.getAttribute('normal');
      const arcVertices = (SPINE_ARC_SEGMENTS + 1) * (SPINE_LENGTH_SEGMENTS + 1);
      const capVertices = SPINE_ARC_SEGMENTS + 2; // the rim, with its own normals, and the centre
      expect(position.count).toBe(arcVertices + 2 * capVertices);
      const headCentre = arcVertices + SPINE_ARC_SEGMENTS + 1;
      const tailCentre = headCentre + capVertices;
      expect(position.getZ(headCentre)).toBeCloseTo(-SPINE_LENGTH / 2, 5);
      expect(position.getZ(tailCentre)).toBeCloseTo(SPINE_LENGTH / 2, 5);
      expect(normal.getZ(headCentre)).toBeCloseTo(-1, 5);
      expect(normal.getZ(tailCentre)).toBeCloseTo(1, 5);
      const indices = geometry.getIndex();
      if (!indices) throw new Error('the spine is indexed');
      expect(indices.count).toBe(SPINE_ARC_SEGMENTS * SPINE_LENGTH_SEGMENTS * 6 + 2 * SPINE_ARC_SEGMENTS * 3);
      // The cap triangles are the last ones; each must face outward (away from the middle of the spine along z).
      const a = new Vector3();
      const b = new Vector3();
      const c = new Vector3();
      const first = SPINE_ARC_SEGMENTS * SPINE_LENGTH_SEGMENTS * 6;
      for (let t = first; t < indices.count; t += 3) {
        a.fromBufferAttribute(position, indices.getX(t));
        b.fromBufferAttribute(position, indices.getX(t + 1));
        c.fromBufferAttribute(position, indices.getX(t + 2));
        const face = b.clone().sub(a).cross(c.clone().sub(a));
        const head = t < first + SPINE_ARC_SEGMENTS * 3;
        expect(Math.sign(face.z), `${String(outward)} ${head ? 'head' : 'tail'} ${String(t)}`).toBe(
          head ? -1 : 1,
        );
      }
    }
  });

  it('rolls into a headcap at each end and sinks into a groove where the leather meets the boards', () => {
    const geometry = createSpineGeometry();
    updateSpineGeometry(geometry, { outward: 1, yTop: 0.4, open: 0 }, null);
    const row = SPINE_ARC_SEGMENTS / 2;
    const reach = (column: number): number => Math.abs(vertex(geometry, row, column).x);
    const cap = reach(0);
    const leatherBetween = reach(Math.round(SPINE_LENGTH_SEGMENTS * 0.25));
    expect(cap).toBeGreaterThan(leatherBetween + 0.006);
    expect(reach(SPINE_LENGTH_SEGMENTS)).toBeCloseTo(cap, 5);
    // The groove: a vertex just inside the joint with the board lies closer to the ellipse's middle than its neighbours.
    const column = Math.round(SPINE_LENGTH_SEGMENTS * 0.25);
    const radius = (r: number): number =>
      Math.hypot(vertex(geometry, r, column).x, vertex(geometry, r, column).y - 0.2);
    expect(radius(1)).toBeLessThan(radius(3) - 0.003);
  });

  it('stays inside the book: never below the table, never above the top of the board, never past the ends', () => {
    for (const open of [0, 0.5, 1]) {
      const geometry = createSpineGeometry();
      const yTop = 0.4 - 0.34 * open;
      updateSpineGeometry(geometry, { outward: 1, yTop, open }, null);
      const position = geometry.getAttribute('position');
      for (let i = 0; i < position.count; i += 1) {
        expect(position.getY(i)).toBeGreaterThan(-0.0005);
        expect(position.getY(i)).toBeLessThan(yTop + 0.001);
        expect(Math.abs(position.getZ(i))).toBeLessThan(SPINE_LENGTH / 2 + 1e-6);
      }
    }
  });
});
