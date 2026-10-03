/*
 * Procedural paper for the diary's own pages: aged parchment, marbled endpapers and ink. Everything is drawn
 * with the 2D canvas (no downloaded images), seeded so a face looks the same every time it is drawn.
 */

export type Ctx2D = CanvasRenderingContext2D;

/** Small, fast, seedable random numbers. */
export function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Smooth value noise on an integer lattice, in [0, 1]. */
export function makeValueNoise(rng: () => number, size = 256): (x: number, y: number) => number {
  const lattice = new Float32Array(size * size);
  for (let i = 0; i < lattice.length; i += 1) lattice[i] = rng();
  const at = (ix: number, iy: number): number =>
    lattice[((iy & (size - 1)) * size + (ix & (size - 1))) | 0] ?? 0;
  return (x, y) => {
    const ix = Math.floor(x);
    const iy = Math.floor(y);
    const fx = x - ix;
    const fy = y - iy;
    const ux = fx * fx * (3 - 2 * fx);
    const uy = fy * fy * (3 - 2 * fy);
    const top = at(ix, iy) + (at(ix + 1, iy) - at(ix, iy)) * ux;
    const bottom = at(ix, iy + 1) + (at(ix + 1, iy + 1) - at(ix, iy + 1)) * ux;
    return top + (bottom - top) * uy;
  };
}

/** Fractal noise from `octaves` layers of value noise, in [0, 1]. */
export function fbm(noise: (x: number, y: number) => number, x: number, y: number, octaves = 4): number {
  let sum = 0;
  let amplitude = 0.5;
  let frequency = 1;
  let total = 0;
  for (let octave = 0; octave < octaves; octave += 1) {
    sum += amplitude * noise(x * frequency, y * frequency);
    total += amplitude;
    amplitude *= 0.5;
    frequency *= 2;
  }
  return sum / total;
}

/** The grey levels of a noise tile: `NOISE_TILE_MIN` to `NOISE_TILE_MIN + NOISE_TILE_SPAN - 1`, evenly (of 255). */
export const NOISE_TILE_MIN = 90;
export const NOISE_TILE_SPAN = 150;
/** The mean of a noise tile as a share of white: the middle of the two end levels, over 255. */
export const NOISE_TILE_MEAN = (NOISE_TILE_MIN + (NOISE_TILE_MIN + NOISE_TILE_SPAN - 1)) / 2 / 255;

/** A repeating grey noise tile, for the fine grain of paper and leather. */
export function noiseTile(
  size: number,
  rng: () => number,
  create: (w: number, h: number) => HTMLCanvasElement,
): HTMLCanvasElement {
  const tile = create(size, size);
  const ctx = tile.getContext('2d');
  if (!ctx) return tile;
  const image = ctx.createImageData(size, size);
  for (let i = 0; i < size * size; i += 1) {
    const value = NOISE_TILE_MIN + Math.floor(rng() * NOISE_TILE_SPAN);
    image.data[i * 4] = value;
    image.data[i * 4 + 1] = value;
    image.data[i * 4 + 2] = value;
    image.data[i * 4 + 3] = 255;
  }
  ctx.putImageData(image, 0, 0);
  return tile;
}

export interface PaperOptions {
  /** Base colour of the sheet. */
  base?: string;
  /** How strongly the edges are burnt and stained (0..1). */
  edgeBurn?: number;
  seed?: number;
}

/** Draws aged parchment: mottling, fibres, foxing, grain and darker edges. */
export function drawParchment(
  ctx: Ctx2D,
  width: number,
  height: number,
  create: (w: number, h: number) => HTMLCanvasElement,
  options: PaperOptions = {},
): void {
  const rng = mulberry32(options.seed ?? 7);
  ctx.save();
  ctx.fillStyle = options.base ?? '#e6d8b6';
  ctx.fillRect(0, 0, width, height);

  // Large soft mottling: some patches lighter, some darker, like uneven sizing and age.
  for (let i = 0; i < 46; i += 1) {
    const radius = (0.08 + rng() * 0.28) * Math.max(width, height);
    const x = rng() * width;
    const y = rng() * height;
    const dark = rng() < 0.62;
    const gradient = ctx.createRadialGradient(x, y, 0, x, y, radius);
    const tone = dark ? '150, 110, 55' : '255, 244, 214';
    gradient.addColorStop(0, `rgba(${tone}, ${dark ? 0.05 + rng() * 0.06 : 0.06 + rng() * 0.07})`);
    gradient.addColorStop(1, `rgba(${tone}, 0)`);
    ctx.fillStyle = gradient;
    ctx.fillRect(x - radius, y - radius, radius * 2, radius * 2);
  }

  // Fine grain: a noise tile multiplied over the sheet.
  const tile = noiseTile(256, rng, create);
  const pattern = ctx.createPattern(tile, 'repeat');
  if (pattern) {
    ctx.globalCompositeOperation = 'multiply';
    ctx.globalAlpha = 0.11;
    ctx.fillStyle = pattern;
    ctx.fillRect(0, 0, width, height);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
  }

  // Fibres: short curved hairs in a slightly darker tan.
  ctx.lineCap = 'round';
  const fibres = Math.round(width * 1.6);
  for (let i = 0; i < fibres; i += 1) {
    const x = rng() * width;
    const y = rng() * height;
    const length = 4 + rng() * 26;
    const angle = rng() * Math.PI * 2;
    ctx.strokeStyle = `rgba(${rng() < 0.7 ? '120, 88, 50' : '255, 248, 226'}, ${0.04 + rng() * 0.09})`;
    ctx.lineWidth = 0.5 + rng() * 0.9;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.quadraticCurveTo(
      x + Math.cos(angle) * length * 0.5 + (rng() - 0.5) * 5,
      y + Math.sin(angle) * length * 0.5 + (rng() - 0.5) * 5,
      x + Math.cos(angle) * length,
      y + Math.sin(angle) * length,
    );
    ctx.stroke();
  }

  // Foxing: a few small brown spots.
  for (let i = 0; i < 26; i += 1) {
    const radius = 2 + rng() * 9;
    const x = rng() * width;
    const y = rng() * height;
    const gradient = ctx.createRadialGradient(x, y, 0, x, y, radius);
    gradient.addColorStop(0, `rgba(118, 78, 36, ${0.1 + rng() * 0.14})`);
    gradient.addColorStop(1, 'rgba(118, 78, 36, 0)');
    ctx.fillStyle = gradient;
    ctx.fillRect(x - radius, y - radius, radius * 2, radius * 2);
  }

  // Burnt, stained edges: a darker rim all around, stronger at the corners.
  const burn = options.edgeBurn ?? 0.55;
  const rim = Math.min(width, height) * 0.16;
  const sides: readonly (readonly [number, number, number, number, number, number, number, number])[] = [
    [0, 0, 0, rim, 0, 0, width, rim],
    [0, height, 0, height - rim, 0, height - rim, width, rim],
    [0, 0, rim, 0, 0, 0, rim, height],
    [width, 0, width - rim, 0, width - rim, 0, rim, height],
  ];
  for (const [x0, y0, x1, y1, rx, ry, rw, rh] of sides) {
    const gradient = ctx.createLinearGradient(x0, y0, x1, y1);
    gradient.addColorStop(0, `rgba(104, 68, 30, ${0.5 * burn})`);
    gradient.addColorStop(0.4, `rgba(124, 86, 42, ${0.14 * burn})`);
    gradient.addColorStop(1, 'rgba(124, 86, 42, 0)');
    ctx.fillStyle = gradient;
    ctx.fillRect(rx, ry, rw, rh);
  }
  const vignette = ctx.createRadialGradient(
    width / 2,
    height / 2,
    Math.min(width, height) * 0.25,
    width / 2,
    height / 2,
    Math.hypot(width, height) * 0.52,
  );
  vignette.addColorStop(0, 'rgba(96, 62, 28, 0)');
  vignette.addColorStop(1, `rgba(96, 62, 28, ${0.38 * burn})`);
  ctx.fillStyle = vignette;
  ctx.fillRect(0, 0, width, height);
  ctx.restore();
}

export interface InkTextOptions {
  font: string;
  color: string;
  direction: 'ltr' | 'rtl';
  /** Blur radius of the bleed around the strokes, in pixels. */
  bleed: number;
}

/** Ink on parchment: a soft bleed under a crisp stroke, slightly lighter where the pen ran dry. */
export function drawInkText(ctx: Ctx2D, text: string, x: number, y: number, options: InkTextOptions): void {
  ctx.save();
  ctx.font = options.font;
  ctx.direction = options.direction;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = options.color;
  ctx.shadowColor = 'rgba(52, 28, 14, 0.5)';
  ctx.shadowBlur = options.bleed;
  ctx.globalAlpha = 0.5;
  ctx.fillText(text, x, y);
  ctx.shadowBlur = 0;
  ctx.globalAlpha = 0.92;
  ctx.fillText(text, x, y);
  ctx.restore();
}

/** A calligraphic line: a gentle wave whose pen pressure swells and thins, for the quill line and flourishes. */
export function drawFlourishLine(
  ctx: Ctx2D,
  x0: number,
  x1: number,
  y: number,
  amplitude: number,
  maxWidth: number,
  color: string,
  seed = 3,
): void {
  const rng = mulberry32(seed);
  const waves = 1.5 + rng() * 0.8;
  const steps = 140;
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineCap = 'round';
  let previous: [number, number] | null = null;
  for (let i = 0; i <= steps; i += 1) {
    const t = i / steps;
    const px = x0 + (x1 - x0) * t;
    const envelope = Math.sin(Math.PI * t);
    const py = y + Math.sin(t * Math.PI * 2 * waves) * amplitude * envelope;
    if (previous) {
      // Pressure swells in the middle and thins to a hair at both ends.
      ctx.lineWidth = Math.max(
        0.6,
        maxWidth * (0.25 + 0.75 * Math.pow(envelope, 0.7)) * (0.7 + 0.3 * Math.cos(t * Math.PI * 4)),
      );
      ctx.beginPath();
      ctx.moveTo(previous[0], previous[1]);
      ctx.lineTo(px, py);
      ctx.stroke();
    }
    previous = [px, py];
  }
  ctx.restore();
}

/** A rotationally symmetric medallion (the diary's sigil in miniature): rings, an eight-point star, petals. */
export function drawMedallion(
  ctx: Ctx2D,
  cx: number,
  cy: number,
  radius: number,
  color: string,
  lineWidth: number,
): void {
  ctx.save();
  ctx.translate(cx, cy);
  ctx.strokeStyle = color;
  ctx.lineWidth = lineWidth;
  ctx.lineJoin = 'round';
  for (const factor of [1, 0.88, 0.34]) {
    ctx.beginPath();
    ctx.arc(0, 0, radius * factor, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.beginPath();
  for (let i = 0; i < 16; i += 1) {
    const angle = (i * Math.PI) / 8 - Math.PI / 2;
    const r = i % 2 === 0 ? radius * 0.8 : radius * 0.4;
    ctx.lineTo(Math.cos(angle) * r, Math.sin(angle) * r);
  }
  ctx.closePath();
  ctx.stroke();
  for (let i = 0; i < 8; i += 1) {
    ctx.save();
    ctx.rotate((i * Math.PI) / 4);
    ctx.beginPath();
    ctx.moveTo(0, -radius * 0.34);
    ctx.quadraticCurveTo(radius * 0.12, -radius * 0.6, 0, -radius * 0.86);
    ctx.quadraticCurveTo(-radius * 0.12, -radius * 0.6, 0, -radius * 0.34);
    ctx.stroke();
    ctx.restore();
  }
  ctx.restore();
}
