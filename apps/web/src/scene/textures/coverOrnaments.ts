import type { Ctx2D } from '../../book/paperTexture';

/*
 * The gold tooling of the cover: a double frame, a fleuron in each corner, and the diary's sigil in the middle (rings, a
 * ring of dots, petals, an eight-point star and, at its heart, an eight-petal rosette). Every piece is drawn into
 * three canvases at once (albedo gets gold, the data map the emboss, the emissive map the glow), and the whole is
 * invariant under a half turn about the centre of the cover: the corners are the same fleuron turned by right angles
 * and everything else is round, so a closed book that turns over to swap its layout direction looks the same after.
 */

const GOLD_LIGHT = '#e9c978';
const GOLD_MID = '#c19a47';
const GOLD_DARK = '#8f6b30';

function goldGradient(ctx: Ctx2D, w: number, h: number): CanvasGradient {
  const gradient = ctx.createLinearGradient(0, 0, w, h);
  gradient.addColorStop(0, GOLD_LIGHT);
  gradient.addColorStop(0.3, GOLD_MID);
  gradient.addColorStop(0.55, GOLD_DARK);
  gradient.addColorStop(0.8, GOLD_MID);
  gradient.addColorStop(1, GOLD_LIGHT);
  return gradient;
}

export function roundedRectPath(
  ctx: Ctx2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
): void {
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + width, y, x + width, y + height, radius);
  ctx.arcTo(x + width, y + height, x, y + height, radius);
  ctx.arcTo(x, y + height, x, y, radius);
  ctx.arcTo(x, y, x + width, y, radius);
  ctx.closePath();
}

/** Strokes the same gold tooling in every canvas: albedo gets gold, data gets the emboss, emissive the glow. */
export type Layer = 'albedo' | 'data' | 'emissive';

export interface Tooling {
  ctx: Ctx2D;
  layer: Layer;
  w: number;
  h: number;
}

export function toolStroke(t: Tooling, width: number, draw: () => void): void {
  const { ctx, layer, w, h } = t;
  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  if (layer === 'albedo') {
    ctx.strokeStyle = goldGradient(ctx, w, h);
    ctx.lineWidth = width;
    draw();
  } else if (layer === 'data') {
    // Pressed into the leather: lower, smoother, and partly metallic.
    ctx.strokeStyle = 'rgb(54, 70, 118)';
    ctx.lineWidth = width * 1.5;
    draw();
    ctx.strokeStyle = 'rgb(40, 62, 120)';
    ctx.lineWidth = width;
    draw();
  } else {
    ctx.strokeStyle = 'rgb(255, 214, 140)';
    ctx.lineWidth = width;
    draw();
  }
  ctx.restore();
}

/** An almond petal pointing along -y from `inner` to `outer`. */
function petal(ctx: Ctx2D, inner: number, outer: number, halfWidth: number): void {
  ctx.beginPath();
  ctx.moveTo(0, -inner);
  ctx.quadraticCurveTo(halfWidth, -(inner + outer) / 2, 0, -outer);
  ctx.quadraticCurveTo(-halfWidth, -(inner + outer) / 2, 0, -inner);
  ctx.stroke();
}

/**
 * The sigil: rings, a ring of dots, petals, an eight-point star made of two squares, and an eight-petal rosette at the
 * heart (it replaced a cross-hair, which read as a gun-sight). Eight-fold symmetric.
 */
function drawSigil(t: Tooling, cx: number, cy: number, radius: number, line: number): void {
  const { ctx } = t;
  ctx.save();
  ctx.translate(cx, cy);
  for (const [factor, scale] of [
    [1, 1.6],
    [0.965, 0.8],
    [0.74, 1.1],
    [0.38, 1.2],
    [0.215, 0.9],
  ] as const) {
    toolStroke(t, line * scale, () => {
      ctx.beginPath();
      ctx.arc(0, 0, radius * factor, 0, Math.PI * 2);
      ctx.stroke();
    });
  }
  // Sixteen rays outside the ring.
  toolStroke(t, line * 0.9, () => {
    for (let i = 0; i < 16; i += 1) {
      ctx.save();
      ctx.rotate((i * Math.PI) / 8);
      ctx.beginPath();
      ctx.moveTo(0, -radius * 1.03);
      ctx.lineTo(0, -radius * (i % 2 === 0 ? 1.13 : 1.08));
      ctx.stroke();
      ctx.restore();
    }
  });
  // A ring of dots between the two outer rings.
  toolStroke(t, line * 0.6, () => {
    for (let i = 0; i < 32; i += 1) {
      const angle = (i * Math.PI) / 16;
      ctx.beginPath();
      ctx.arc(Math.cos(angle) * radius * 0.85, Math.sin(angle) * radius * 0.85, line * 0.7, 0, Math.PI * 2);
      ctx.stroke();
    }
  });
  // Petals: eight large, eight small between them.
  toolStroke(t, line * 1.1, () => {
    for (let i = 0; i < 8; i += 1) {
      ctx.save();
      ctx.rotate((i * Math.PI) / 4);
      petal(ctx, radius * 0.4, radius * 0.72, radius * 0.11);
      ctx.restore();
    }
  });
  toolStroke(t, line * 0.8, () => {
    for (let i = 0; i < 8; i += 1) {
      ctx.save();
      ctx.rotate((i * Math.PI) / 4 + Math.PI / 8);
      petal(ctx, radius * 0.46, radius * 0.66, radius * 0.06);
      ctx.restore();
    }
  });
  // Two squares making an eight-point star, inscribed in the petal ring.
  toolStroke(t, line * 0.9, () => {
    for (const turn of [0, Math.PI / 4]) {
      ctx.save();
      ctx.rotate(turn);
      const half = radius * 0.5;
      ctx.strokeRect(-half, -half, half * 2, half * 2);
      ctx.restore();
    }
  });
  // The heart: an eight-petal rosette with a small ring in the middle.
  toolStroke(t, line * 0.85, () => {
    for (let i = 0; i < 8; i += 1) {
      ctx.save();
      ctx.rotate((i * Math.PI) / 4);
      petal(ctx, radius * 0.045, radius * 0.19, radius * 0.05);
      ctx.restore();
    }
    ctx.beginPath();
    ctx.arc(0, 0, radius * 0.035, 0, Math.PI * 2);
    ctx.stroke();
  });
  ctx.restore();
}

/**
 * A corner fleuron, in the frame's corner and opening into the field: a quarter rosette of four petals, a small
 * ring in the corner, a row of dog-teeth on an arc, and a three-lobed leaf along the diagonal. The four corners are
 * this drawing turned by right angles.
 */
function drawCorner(t: Tooling, x: number, y: number, rotation: number, size: number, line: number): void {
  const { ctx } = t;
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(rotation);
  // The field opens to +x and +y. A petal is drawn along -y; turned by a + 90 degrees it points at angle `a` into the corner.
  toolStroke(t, line, () => {
    for (let k = 0; k < 4; k += 1) {
      const a = (k + 0.5) * (Math.PI / 8);
      ctx.save();
      ctx.rotate(a + Math.PI / 2);
      petal(ctx, size * 0.1, size * 0.52, size * 0.075);
      ctx.restore();
    }
    ctx.beginPath();
    ctx.arc(0, 0, size * 0.075, 0, Math.PI / 2);
    ctx.stroke();
  });
  // Dog-teeth: small triangles on an arc, pointing outward.
  toolStroke(t, line * 0.7, () => {
    const arc = size * 0.66;
    for (let k = 0; k < 9; k += 1) {
      const a = ((k + 0.5) / 9) * (Math.PI / 2);
      const tip = arc + size * 0.07;
      const half = 0.07;
      ctx.beginPath();
      ctx.moveTo(Math.cos(a - half) * arc, Math.sin(a - half) * arc);
      ctx.lineTo(Math.cos(a) * tip, Math.sin(a) * tip);
      ctx.lineTo(Math.cos(a + half) * arc, Math.sin(a + half) * arc);
      ctx.stroke();
    }
    ctx.beginPath();
    ctx.arc(0, 0, arc, 0, Math.PI / 2);
    ctx.stroke();
  });
  // A trefoil along the diagonal: three small round lobes around a short stem.
  toolStroke(t, line * 0.85, () => {
    const d = size * 0.8;
    const cx = d * Math.SQRT1_2;
    const lobe = size * 0.045;
    for (const a of [Math.PI / 4, Math.PI / 4 + 2.2, Math.PI / 4 - 2.2]) {
      ctx.beginPath();
      ctx.arc(cx + Math.cos(a) * lobe * 1.6, cx + Math.sin(a) * lobe * 1.6, lobe, 0, Math.PI * 2);
      ctx.stroke();
    }
  });
  ctx.restore();
}

export function drawTooling(t: Tooling): void {
  const { ctx, w, h } = t;
  const line = w * 0.0042;
  const outer = w * 0.055;
  const inner = w * 0.088;
  toolStroke(t, line * 1.3, () => {
    roundedRectPath(ctx, outer, outer, w - 2 * outer, h - 2 * outer, w * 0.012);
    ctx.stroke();
  });
  toolStroke(t, line * 0.65, () => {
    roundedRectPath(ctx, inner, inner, w - 2 * inner, h - 2 * inner, w * 0.008);
    ctx.stroke();
  });
  for (const [x, y, rotation] of [
    [inner, inner, 0],
    [w - inner, inner, Math.PI / 2],
    [w - inner, h - inner, Math.PI],
    [inner, h - inner, -Math.PI / 2],
  ] as const) {
    drawCorner(t, x, y, rotation, w * 0.16, line * 0.8);
  }
  drawSigil(t, w / 2, h / 2, w * 0.27, line * 0.85);
  // Two short rules above and below the sigil, a quiet echo of the frame.
  for (const sign of [-1, 1]) {
    toolStroke(t, line * 0.6, () => {
      ctx.beginPath();
      ctx.moveTo(w * 0.34, h / 2 + sign * w * 0.4);
      ctx.lineTo(w * 0.66, h / 2 + sign * w * 0.4);
      ctx.stroke();
    });
  }
}
