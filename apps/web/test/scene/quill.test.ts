import { Box3, Vector3, type BufferGeometry } from 'three';
import { describe, expect, it } from 'vitest';
import {
  QUILL_PATH,
  quillShaftGeometry,
  quillVaneGeometry,
  vaneWidthAt,
} from '../../src/scene/quillGeometry';
import { QUILL_TIP } from '../../src/scene/sceneConstants';

/*
 * The quill: a shaft that curves and tapers from a thick hollow calamus to a fine tip, and a vane of soft barbs on either
 * side of it (wider on one side, as a real feather is), standing in the inkwell and leaning away from the candle.
 */

function radiusAlong(geometry: BufferGeometry, ring: number, perRing: number): number {
  // The shaft is rings of `perRing` vertices; the radius of a ring is the distance of its vertices from their centre.
  const position = geometry.getAttribute('position');
  const centre = new Vector3();
  for (let i = 0; i < perRing; i += 1) {
    centre.add(
      new Vector3(
        position.getX(ring * perRing + i),
        position.getY(ring * perRing + i),
        position.getZ(ring * perRing + i),
      ),
    );
  }
  centre.divideScalar(perRing);
  return new Vector3(
    position.getX(ring * perRing),
    position.getY(ring * perRing),
    position.getZ(ring * perRing),
  ).distanceTo(centre);
}

describe('the quill shaft', () => {
  it('runs from inside the inkwell to the quill tip the layout is built around, curving a little', () => {
    const base = QUILL_PATH.getPoint(0);
    const tip = QUILL_PATH.getPoint(1);
    expect(base.y).toBeLessThan(0.3); // down in the well
    expect(tip.x).toBeCloseTo(QUILL_TIP.out, 2);
    expect(tip.y).toBeCloseTo(QUILL_TIP.height, 2);
    // A curve, not a stick: the middle is off the straight line between its ends.
    const middle = QUILL_PATH.getPoint(0.5);
    const straight = base.clone().lerp(tip, 0.5);
    expect(middle.distanceTo(straight)).toBeGreaterThan(0.01);
  });

  it('tapers from a thick calamus to a fine point', () => {
    const { geometry, ringSize, rings } = quillShaftGeometry();
    const base = radiusAlong(geometry, 0, ringSize);
    const middle = radiusAlong(geometry, Math.floor(rings / 2), ringSize);
    const tip = radiusAlong(geometry, rings - 1, ringSize);
    expect(base).toBeGreaterThan(middle);
    expect(middle).toBeGreaterThan(tip);
    expect(base).toBeGreaterThan(0.008);
    expect(base).toBeLessThan(0.016);
    expect(tip).toBeLessThan(0.005);
  });

  it('is smooth: it has normals and a closed end', () => {
    const { geometry } = quillShaftGeometry();
    expect(geometry.getAttribute('normal').count).toBe(geometry.getAttribute('position').count);
    expect(geometry.getIndex()).not.toBeNull();
  });
});

describe('the vane', () => {
  it('is a soft almond: nothing at the quill, widest a little past the middle of its length, a point at the tip', () => {
    expect(vaneWidthAt(0.2)).toBe(0);
    let widest = 0;
    let at = 0;
    for (let t = 0.3; t <= 1; t += 0.01) {
      const width = vaneWidthAt(t);
      if (width > widest) {
        widest = width;
        at = t;
      }
    }
    expect(at).toBeGreaterThan(0.45);
    expect(at).toBeLessThan(0.8);
    expect(vaneWidthAt(1)).toBeLessThan(widest * 0.15);
    expect(widest).toBeGreaterThan(0.04);
    expect(widest).toBeLessThan(0.1);
  });

  it('is wider on one side of the shaft than the other, and both sides carry barbs (a texture with a soft edge)', () => {
    const { geometry, texture, sideWidths } = quillVaneGeometry();
    expect(sideWidths.wide).toBeGreaterThan(sideWidths.narrow * 1.3);
    expect(geometry.getAttribute('uv').count).toBe(geometry.getAttribute('position').count);
    expect(texture.image).toBeDefined();
    texture.dispose();
  });

  it('stays within the height and the reach the layout allows for the quill', () => {
    const { geometry, texture } = quillVaneGeometry();
    const box = new Box3().setFromBufferAttribute(geometry.getAttribute('position') as never);
    expect(box.max.y).toBeLessThanOrEqual(QUILL_TIP.height + 0.02);
    expect(box.max.x).toBeLessThanOrEqual(QUILL_TIP.out + 0.12);
    expect(box.min.x).toBeGreaterThanOrEqual(-0.1);
    texture.dispose();
  });
});
