import {
  BufferAttribute,
  BufferGeometry,
  CanvasTexture,
  QuadraticBezierCurve3,
  SRGBColorSpace,
  Vector3,
} from 'three';
import { QUILL_TIP } from './sceneConstants';

/*
 * A quill: a shaft that curves and tapers (a thick hollow calamus at the bottom, in the well, to a fine tip) and a vane
 * of soft barbs on either side of it, wider on one side than the other, as a real feather is. In the quill's own frame
 * (x is "out", away from the candle, y is up, z across the vane); the inkwell stands it up and leans it.
 */

/** The shaft's centre line: from down in the well, bowing a little, to the tip the layout allows for. */
export const QUILL_PATH = new QuadraticBezierCurve3(
  new Vector3(0.02, 0.2, 0),
  new Vector3(0.05, 0.52, 0),
  new Vector3(QUILL_TIP.out, QUILL_TIP.height, 0),
);

const SHAFT_RINGS = 22;
const SHAFT_SIDES = 8;
const BASE_RADIUS = 0.0115;
const TIP_RADIUS = 0.0028;

export interface QuillShaft {
  geometry: BufferGeometry;
  ringSize: number;
  rings: number;
}

/** The shaft: a tube along the path whose radius falls from the calamus to the tip. */
export function quillShaftGeometry(): QuillShaft {
  const positions: number[] = [];
  const normals: number[] = [];
  const indices: number[] = [];
  const point = new Vector3();
  const tangent = new Vector3();
  const side = new Vector3(0, 0, 1);
  const up = new Vector3();
  for (let ring = 0; ring < SHAFT_RINGS; ring += 1) {
    const t = ring / (SHAFT_RINGS - 1);
    QUILL_PATH.getPoint(t, point);
    QUILL_PATH.getTangent(t, tangent);
    up.crossVectors(side, tangent).normalize(); // perpendicular to the shaft, in the plane of the curve
    const radius = BASE_RADIUS + (TIP_RADIUS - BASE_RADIUS) * Math.pow(t, 0.75);
    for (let i = 0; i < SHAFT_SIDES; i += 1) {
      const angle = (i / SHAFT_SIDES) * Math.PI * 2;
      const nx = Math.cos(angle) * up.x + Math.sin(angle) * side.x;
      const ny = Math.cos(angle) * up.y + Math.sin(angle) * side.y;
      const nz = Math.cos(angle) * up.z + Math.sin(angle) * side.z;
      positions.push(point.x + nx * radius, point.y + ny * radius, point.z + nz * radius);
      normals.push(nx, ny, nz);
    }
  }
  for (let ring = 0; ring < SHAFT_RINGS - 1; ring += 1) {
    for (let i = 0; i < SHAFT_SIDES; i += 1) {
      const a = ring * SHAFT_SIDES + i;
      const b = ring * SHAFT_SIDES + ((i + 1) % SHAFT_SIDES);
      const c = a + SHAFT_SIDES;
      const d = b + SHAFT_SIDES;
      indices.push(a, c, b, b, c, d);
    }
  }
  // Close the tip.
  const tipCentre = positions.length / 3;
  QUILL_PATH.getPoint(1, point);
  positions.push(point.x, point.y, point.z);
  normals.push(tangent.x, tangent.y, tangent.z);
  const last = (SHAFT_RINGS - 1) * SHAFT_SIDES;
  for (let i = 0; i < SHAFT_SIDES; i += 1) indices.push(last + i, tipCentre, last + ((i + 1) % SHAFT_SIDES));
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(Float32Array.from(positions), 3));
  geometry.setAttribute('normal', new BufferAttribute(Float32Array.from(normals), 3));
  geometry.setIndex(indices);
  return { geometry, ringSize: SHAFT_SIDES, rings: SHAFT_RINGS };
}

/** Where along the shaft the vane begins (below it the calamus is bare). */
const VANE_FROM = 0.3;
const VANE_WIDTH = 0.085;

/** Half width of the vane at `t` along the shaft: nothing on the calamus, a soft almond, a point at the tip. */
export function vaneWidthAt(t: number): number {
  if (t <= VANE_FROM) return 0;
  const x = (t - VANE_FROM) / (1 - VANE_FROM);
  // Rises quickly, is widest a little past the middle of the vane, and closes to a point.
  return VANE_WIDTH * Math.pow(Math.sin(Math.PI * Math.pow(x, 0.72)), 0.85) * (1 - 0.1 * x);
}

const VANE_ROWS = 26;
/** The narrow side is this fraction of the wide one. */
const NARROW = 0.55;

/** The barbs: fine lines leaving the shaft at an angle towards the tip, ragged at the edge, with soft gaps between them. */
function barbTexture(): CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 128;
  canvas.height = 256;
  const ctx = canvas.getContext('2d');
  if (ctx) {
    ctx.clearRect(0, 0, 128, 256);
    let seed = 17;
    const random = (): number => {
      seed = (seed * 16807) % 2147483647;
      return seed / 2147483647;
    };
    // The vane's body, a little darker near the shaft, fading to nothing at the ragged edge.
    for (let barb = 0; barb < 210; barb += 1) {
      const v = random() * 256;
      const reach = 96 + random() * 32; // each barb stops at its own length: a ragged edge
      const slant = 18 + random() * 18; // the barbs lean towards the tip (the base is at the top of the texture)
      const tone = 196 + Math.round(random() * 40);
      ctx.strokeStyle = `rgba(${String(tone)}, ${String(tone - 10)}, ${String(tone - 36)}, ${(0.55 + random() * 0.4).toFixed(2)})`;
      ctx.lineWidth = 1 + random() * 1.4;
      ctx.beginPath();
      ctx.moveTo(0, v);
      ctx.quadraticCurveTo(reach * 0.5, v + slant * 0.35, reach, v + slant);
      ctx.stroke();
    }
    // A soft body under the barbs so the vane is not all gaps, strongest at the shaft.
    const body = ctx.createLinearGradient(0, 0, 100, 0);
    body.addColorStop(0, 'rgba(206, 194, 166, 0.78)');
    body.addColorStop(0.7, 'rgba(206, 194, 166, 0.34)');
    body.addColorStop(1, 'rgba(206, 194, 166, 0)');
    ctx.globalCompositeOperation = 'destination-over';
    ctx.fillStyle = body;
    ctx.fillRect(0, 0, 128, 256);
  }
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  return texture;
}

export interface QuillVane {
  geometry: BufferGeometry;
  texture: CanvasTexture;
  sideWidths: { wide: number; narrow: number };
}

/** The vane: a strip on each side of the shaft, drooping a little away from it (a feather is not flat). */
export function quillVaneGeometry(): QuillVane {
  const positions: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  const point = new Vector3();
  const tangent = new Vector3();
  const side = new Vector3(0, 0, 1);
  const up = new Vector3();
  let maxWide = 0;
  for (const sign of [1, -1] as const) {
    const scale = sign === 1 ? 1 : NARROW;
    const base = positions.length / 3;
    for (let row = 0; row <= VANE_ROWS; row += 1) {
      const t = VANE_FROM + ((1 - VANE_FROM) * row) / VANE_ROWS;
      QUILL_PATH.getPoint(t, point);
      QUILL_PATH.getTangent(t, tangent);
      up.crossVectors(side, tangent).normalize();
      const width = vaneWidthAt(t) * scale;
      maxWide = Math.max(maxWide, width);
      const v = 1 - row / VANE_ROWS;
      // On the shaft, then out to the edge; the edge hangs a little below the shaft's plane.
      positions.push(point.x, point.y, point.z);
      uvs.push(0, v);
      positions.push(point.x - up.x * width * 0.28, point.y - up.y * width * 0.28, point.z + sign * width);
      uvs.push(1, v);
      if (row < VANE_ROWS) {
        const a = base + row * 2;
        if (sign === 1) indices.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
        else indices.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
      }
    }
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(Float32Array.from(positions), 3));
  geometry.setAttribute('uv', new BufferAttribute(Float32Array.from(uvs), 2));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return {
    geometry,
    texture: barbTexture(),
    sideWidths: { wide: VANE_WIDTH, narrow: VANE_WIDTH * NARROW },
  };
}
