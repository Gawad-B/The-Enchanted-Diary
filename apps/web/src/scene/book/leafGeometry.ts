import { BufferAttribute, BufferGeometry } from 'three';
import type { Direction } from '@enchanted/shared';
import { leafFrame } from '../../book/bookLayout';
import { PAGE_H, PAGE_W } from './dimensions';

/**
 * The shared geometry of a leaf, built in its hinge frame: x is the distance `s` from the spine (0..PAGE_W),
 * z runs along the page height, y is up. The vertex shader bends it, rotates it and mirrors x for RTL
 * (`uSide`), so there is no negative scale anywhere. Mirroring flips the winding, so the RTL geometry
 * has its triangles in the opposite order: the front face is always the one facing up in the unturned pose
 * and `gl_FrontFacing` always means "showing the front texture".
 *
 * UVs make each face read correctly seen from that face: the front face's u runs from the screen-left to the
 * screen-right in the unturned pose (from the spine for LTR, towards it for RTL); the shader reads the back
 * face at u' = 1 - u. v is 1 at the head of the page, which is the far side (-z) from the camera.
 */
export function buildLeafGeometry(direction: Direction, segments: number): BufferGeometry {
  const frame = leafFrame(direction);
  const columns = segments;
  const rows = 4;
  const vertexCount = (columns + 1) * (rows + 1);
  const positions = new Float32Array(vertexCount * 3);
  const normals = new Float32Array(vertexCount * 3);
  const uvs = new Float32Array(vertexCount * 2);
  for (let row = 0; row <= rows; row += 1) {
    for (let column = 0; column <= columns; column += 1) {
      const index = row * (columns + 1) + column;
      const s = (column / columns) * PAGE_W;
      const z = -PAGE_H / 2 + (row / rows) * PAGE_H;
      positions.set([s, 0, z], index * 3);
      normals.set([0, 1, 0], index * 3);
      const fromSpine = column / columns;
      uvs.set([frame.frontUFromSpine ? fromSpine : 1 - fromSpine, 1 - row / rows], index * 2);
    }
  }
  const indices: number[] = [];
  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column < columns; column += 1) {
      const a = row * (columns + 1) + column;
      const b = a + 1;
      const c = a + (columns + 1);
      const d = c + 1;
      // With x = s and z increasing, (a, c, b) winds counter-clockwise seen from +y (normal up). Mirrored for RTL.
      if (frame.outward === 1) indices.push(a, c, b, b, c, d);
      else indices.push(a, b, c, b, d, c);
    }
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new BufferAttribute(normals, 3));
  geometry.setAttribute('uv', new BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  // The bend moves vertices far from their rest position: a generous bound keeps the leaf from being culled.
  geometry.computeBoundingSphere();
  if (geometry.boundingSphere) {
    geometry.boundingSphere.center.set(0, 0, 0);
    geometry.boundingSphere.radius = PAGE_W * 2.5;
  }
  return geometry;
}
