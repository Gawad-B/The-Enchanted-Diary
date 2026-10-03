import {
  BufferAttribute,
  BufferGeometry,
  CanvasTexture,
  Color,
  CylinderGeometry,
  DoubleSide,
  MeshStandardMaterial,
  RepeatWrapping,
  SRGBColorSpace,
} from 'three';

/*
 * Two small things that make a bound book a bound book: the silk headbands (striped rolls at the head and the tail
 * of the spine side of the page block) and the ribbon bookmark (it comes out between the pages at the tail, hangs
 * over the edge and lies on the table). They are cheap solids that cost a few draw calls and say "real book".
 */

export interface BindingDetails {
  headbandGeometry: BufferGeometry;
  headbandMaterial: MeshStandardMaterial;
  ribbonGeometry: BufferGeometry;
  ribbonMaterial: MeshStandardMaterial;
  dispose(): void;
}

/** Stripes of burgundy and cream silk, along the roll. */
function headbandTexture(): CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 8;
  canvas.height = 16;
  const ctx = canvas.getContext('2d');
  if (ctx) {
    ctx.fillStyle = '#7d2230';
    ctx.fillRect(0, 0, 8, 8);
    ctx.fillStyle = '#e0cfa4';
    ctx.fillRect(0, 8, 8, 8);
  }
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  texture.wrapS = RepeatWrapping;
  texture.wrapT = RepeatWrapping;
  texture.repeat.set(1, 18);
  return texture;
}

/** How far the ribbon runs from where it comes out of the book (scene units: 6 cm of it hang and lie out). */
export const RIBBON_LENGTH = 0.6;
export const RIBBON_WIDTH = 0.06;

/**
 * The ribbon's strip, unit height: it leaves the book at y = 1 and z = 0, runs out a little, droops over the edge
 * and lies flat on the table (y = 0) with a lazy wave. The caller scales y by how high the book's edge is.
 */
export function ribbonGeometry(): BufferGeometry {
  const rows = 18;
  const positions = new Float32Array((rows + 1) * 2 * 3);
  const uvs = new Float32Array((rows + 1) * 2 * 2);
  const indices: number[] = [];
  for (let row = 0; row <= rows; row += 1) {
    const t = row / rows;
    const z = t * RIBBON_LENGTH;
    const drop = t < 0.1 ? 0 : Math.min((t - 0.1) / 0.34, 1);
    const y = 1 - drop * drop * (3 - 2 * drop);
    const sway = 0.014 * Math.sin(t * 5.2) * t;
    for (let side = 0; side < 2; side += 1) {
      const i = row * 2 + side;
      positions.set([sway + (side === 0 ? -1 : 1) * (RIBBON_WIDTH / 2), y, z], i * 3);
      uvs.set([side, t], i * 2);
    }
    if (row < rows) {
      const a = row * 2;
      indices.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
    }
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
}

export function createBindingDetails(): BindingDetails {
  const texture = headbandTexture();
  const headbandGeometry = new CylinderGeometry(0.013, 0.013, 1, 10);
  // The headbands sit in the shade of the spine; a faint glow of their own colours keeps the stripes readable there.
  const headbandMaterial = new MeshStandardMaterial({
    map: texture,
    emissiveMap: texture,
    emissive: new Color(0xffffff),
    emissiveIntensity: 0.22,
    roughness: 0.5,
    metalness: 0,
  });
  const ribbonGeometryInstance = ribbonGeometry();
  const ribbonMaterial = new MeshStandardMaterial({
    color: new Color('#6a1626'),
    roughness: 0.42,
    metalness: 0,
    side: DoubleSide,
  });
  return {
    headbandGeometry,
    headbandMaterial,
    ribbonGeometry: ribbonGeometryInstance,
    ribbonMaterial,
    dispose: () => {
      texture.dispose();
      headbandGeometry.dispose();
      headbandMaterial.dispose();
      ribbonGeometryInstance.dispose();
      ribbonMaterial.dispose();
    },
  };
}
