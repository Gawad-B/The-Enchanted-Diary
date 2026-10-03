import {
  CanvasTexture,
  LinearFilter,
  LinearMipmapLinearFilter,
  NoColorSpace,
  MirroredRepeatWrapping,
  RepeatWrapping,
  SRGBColorSpace,
} from 'three';
import { fbm, makeValueNoise, mulberry32, type Ctx2D } from '../../book/paperTexture';

/*
 * The old wooden table, drawn procedurally. Two canvases: the albedo (sRGB colour) and a packed data map
 * (R: height for the bump, G: roughness). The tile is repeated over the table top; planks run along x.
 *
 * The grain is flat-sawn: the growth rings of a log cut near its heart meet the plank's face as nested arches
 * ("cathedrals"). Each plank has its own pith line below the surface; the board's face is cut at a very slight angle to
 * it, so the heart's depth GROWS steadily along the board (0.6 to 1.4 units under the face, about 0.05 per unit of
 * length: the arches are 20 to 60 cm long, open, with nearly straight grain where they meet the plank's edges). The ring
 * phase is the distance from that line, bent a little by fractal noise, so the rings are open nested arches, never closed
 * loops or ripples. The boards differ: one is nearly straight-grained, the others are cut at steeper angles, and the
 * heart is not always under the middle of the board. The rings are colour only.
 * The relief is just pores and scratches (a table is not corrugated). Every plank is one board of the tile's length
 * with a butt joint at its own offset, so the tile has no seam of its own and the planks do not line up.
 * Computed at half resolution (grain is smooth) and drawn scaled up; pores and scratches are drawn at full resolution.
 */

export const WOOD_TILE_UNITS = { x: 8, z: 6 };
/** Four planks of 15 cm per tile. */
const PLANKS_PER_TILE = 4;
/** Growth rings per unit of distance from the pith (about 7 mm apart). */
const RING_FREQUENCY = 14;
/** How fast the heart sinks along each of the four boards of a tile (units of depth per unit of length), in a shuffled order. */
export const BOARD_SLOPES = [0.004, 0.02, 0.045, 0.075] as const;
/** The heart is never shallower than this under the face (units): any shallower and the arches close into bull's-eyes. */
export const MIN_HEART_DEPTH = 0.55;

export interface SurfaceTextures {
  albedo: CanvasTexture;
  /** R = height (bump), G = roughness. Linear, not sRGB. */
  data: CanvasTexture;
}

type CreateCanvas = (width: number, height: number) => HTMLCanvasElement;

function lerp3(
  a: readonly [number, number, number],
  b: readonly [number, number, number],
  t: number,
): [number, number, number] {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

const DARK_WOOD = [20, 11, 7] as const;
const MID_WOOD = [60, 38, 22] as const;
const LIGHT_WOOD = [102, 71, 43] as const;

export interface PlankParams {
  tone: number;
  warm: number;
  /** Where along the tile this board starts (its butt joint), in units. */
  offset: number;
  /** How deep below the surface the pith lies at the start of the board and at its end, in units. */
  pithStart: number;
  pithEnd: number;
  /** How far the heart is off the middle of the board, across it, in units. */
  pithAside: number;
}

/** The boards of a tile: each with its own tone, joint, cut and heart (see the header). */
export function makePlanks(rng: () => number, boardLength: number): PlankParams[] {
  const slopes: number[] = [...BOARD_SLOPES];
  for (let i = slopes.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    [slopes[i], slopes[j]] = [slopes[j] ?? 0, slopes[i] ?? 0];
  }
  return Array.from({ length: PLANKS_PER_TILE }, (_, index) => {
    const shallow = MIN_HEART_DEPTH + rng() * 0.35;
    const deep = shallow + (slopes[index] ?? 0) * boardLength;
    const sinking = rng() < 0.5; // which way round the board was cut
    return {
      tone: 0.82 + rng() * 0.36,
      warm: rng(),
      offset: rng() * WOOD_TILE_UNITS.x,
      pithStart: sinking ? shallow : deep,
      pithEnd: sinking ? deep : shallow,
      pithAside: (rng() - 0.5) * 0.7,
    };
  });
}

/** A deterministic number in [0, 1) from a number: the year-to-year variation of the rings. */
function hash01(n: number): number {
  const v = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return v - Math.floor(v);
}

/**
 * Ring spacing wanders (the growth is uneven), but never folds back: the phase always rises with the distance from the
 * heart (its slope is at least 1 - 0.222 - 0.04), so no ring is drawn twice.
 */
export function ringPhase(distance: number, warm: number): number {
  return distance + 0.6 * Math.sin(distance * 0.37 + warm * 6) + 0.35 * Math.sin(distance * 0.113 + 2);
}

/**
 * How deep below the face the log's heart lies `along` units from the start of a board `length` long: steadily
 * growing (or, for a board cut the other way round, steadily shrinking), never rising and falling. A depth that
 * rose and fell would make the rings closed loops (contour lines); a steady one makes them open arches.
 */
export function pithDepthAt(start: number, end: number, along: number, length: number): number {
  const t = Math.min(Math.max(along / length, 0), 1);
  return start + (end - start) * t;
}

/** Draws the wood into the two canvases. Pure drawing, no textures: usable (and testable) on any canvases. */
export function drawWood(
  albedoCtx: Ctx2D,
  dataCtx: Ctx2D,
  width: number,
  height: number,
  create: CreateCanvas,
): void {
  const rng = mulberry32(2024);
  const noise = makeValueNoise(rng);
  const lowW = Math.max(128, Math.round(width / 2));
  const lowH = Math.max(128, Math.round(height / 2));
  const colour = create(lowW, lowH);
  const data = create(lowW, lowH);
  const colourCtx = colour.getContext('2d');
  const dataLowCtx = data.getContext('2d');
  if (!colourCtx || !dataLowCtx) return;
  const colourImage = colourCtx.createImageData(lowW, lowH);
  const dataImage = dataLowCtx.createImageData(lowW, lowH);

  const planks = makePlanks(rng, WOOD_TILE_UNITS.x);
  const knots = Array.from({ length: 3 }, () => ({ x: rng() * lowW, y: rng() * lowH, r: 7 + rng() * 10 }));
  const plankUnits = WOOD_TILE_UNITS.z / PLANKS_PER_TILE;
  const boardLength = WOOD_TILE_UNITS.x;

  for (let py = 0; py < lowH; py += 1) {
    const v = py / lowH; // 0..1 across the tile depth
    const plankIndex = Math.min(PLANKS_PER_TILE - 1, Math.floor(v * PLANKS_PER_TILE));
    const local = v * PLANKS_PER_TILE - plankIndex; // 0..1 across one plank
    const across = local * plankUnits; // units from the plank's edge
    const centred = across - plankUnits / 2; // units from the plank's middle
    const plank = planks[plankIndex] ?? planks[0];
    if (!plank) continue;
    const edge = Math.min(across, plankUnits - across);
    const seam = 1 - Math.min(1, edge / 0.011);
    const lip = Math.max(0, 1 - Math.abs(edge - 0.02) / 0.012) * 0.5;
    for (let px = 0; px < lowW; px += 1) {
      // Position along this board: it starts at its own butt joint.
      const along =
        ((((px / lowW) * WOOD_TILE_UNITS.x - plank.offset) % boardLength) + boardLength) % boardLength;
      const joint = 1 - Math.min(1, Math.min(along, boardLength - along) / 0.012);
      // The pith's depth under the face grows steadily along the board: tight arches where it is shallow, straightening
      // into long grain where it is deep.
      const pith = pithDepthAt(plank.pithStart, plank.pithEnd, along, boardLength);
      const warp = (fbm(noise, along * 0.32 + plankIndex * 11.3, centred * 1.6 + 4.1, 2) - 0.5) * 0.55;
      const aside = centred - plank.pithAside;
      const distance = RING_FREQUENCY * Math.sqrt(aside * aside + pith * pith) + warp;
      // No two years are alike: the growth is uneven, so ring spacing wanders (the phase is bent by itself) and each ring
      // is darker or paler than its neighbours. An even spacing and an even tone would read as a corrugated grille.
      const phase = ringPhase(distance, plank.warm);
      const year = Math.floor(phase);
      const f = phase - year;
      const yearTone = 0.35 + 0.9 * hash01(year * 7.31 + plankIndex * 3.7);
      // Latewood is a thin dark band in each ring; earlywood is the broad pale part.
      const late = Math.pow(1 - Math.abs(2 * f - 1), 2.6) * yearTone;
      // Broad tonal drift along and across the board (the grain is colour, not stripes).
      const drift = fbm(noise, along * 0.35 + plankIndex * 7.7, centred * 3 + 9, 3);
      let knot = 0;
      for (const k of knots) {
        const dx = px - k.x;
        const dy = (py - k.y) * 1.8;
        const d = Math.sqrt(dx * dx + dy * dy) / k.r;
        if (d < 2.2) knot = Math.max(knot, 1 - d / 2.2);
      }
      let t = 0.46 - late * 0.27 + (drift - 0.5) * 0.46 - knot * 0.2;
      t = Math.min(Math.max(t * plank.tone, 0), 1);
      let [r, g, b] =
        t < 0.5 ? lerp3(DARK_WOOD, MID_WOOD, t * 2) : lerp3(MID_WOOD, LIGHT_WOOD, (t - 0.5) * 2);
      // A little hue variety between planks: some redder, some greyer.
      r *= 0.94 + plank.warm * 0.14;
      b *= 1.06 - plank.warm * 0.16;
      // Plank seams and butt joints: a dark groove with a worn, lighter lip beside the long seam.
      const groove = Math.max(seam, joint);
      const shade = (1 - groove * 0.92) * (1 + lip * 0.4) * (1 - knot * 0.3);
      r *= shade;
      g *= shade;
      b *= shade;
      const i = (py * lowW + px) * 4;
      colourImage.data[i] = r;
      colourImage.data[i + 1] = g;
      colourImage.data[i + 2] = b;
      colourImage.data[i + 3] = 255;
      // Height: only a trace of the rings, the grooves sunk; roughness: waxed and polished, rougher in the grain's pale parts.
      const heightValue = 128 + (0.5 - late) * 8 - groove * 96 + lip * 10;
      const roughness = 176 + late * 24 + groove * 40 - (drift - 0.5) * 30;
      dataImage.data[i] = Math.min(255, Math.max(0, heightValue));
      dataImage.data[i + 1] = Math.min(255, Math.max(0, roughness));
      dataImage.data[i + 2] = 0;
      dataImage.data[i + 3] = 255;
    }
  }
  colourCtx.putImageData(colourImage, 0, 0);
  dataLowCtx.putImageData(dataImage, 0, 0);

  for (const [target, source] of [
    [albedoCtx, colour],
    [dataCtx, data],
  ] as const) {
    target.save();
    target.imageSmoothingEnabled = true;
    target.imageSmoothingQuality = 'high';
    target.drawImage(source, 0, 0, width, height);
    target.restore();
  }

  // A little fine grain at full resolution: a few hundred faint, long, thin streaks along x. Each wanders with a whole number of
  // periods across the tile, so the tile repeats without a seam.
  const plankHeight = height / PLANKS_PER_TILE;
  const streaks = Math.round(width * 0.45);
  albedoCtx.save();
  albedoCtx.lineCap = 'round';
  for (let i = 0; i < streaks; i += 1) {
    const plankIndex = Math.floor(rng() * PLANKS_PER_TILE);
    const y0 = plankIndex * plankHeight + (0.03 + rng() * 0.94) * plankHeight;
    const amplitude = 0.4 + rng() * 2.2;
    const periods = 1 + Math.floor(rng() * 3);
    const phase = rng() * Math.PI * 2;
    const dark = rng() < 0.62;
    albedoCtx.strokeStyle = dark
      ? `rgba(12, 6, 3, ${0.025 + rng() * 0.06})`
      : `rgba(140, 100, 62, ${0.02 + rng() * 0.04})`;
    albedoCtx.lineWidth = 0.5 + rng() * (dark ? 1.3 : 1.0);
    albedoCtx.beginPath();
    const start = rng() * width * 0.4;
    const length = width * (0.2 + rng() * 0.7);
    for (let step = 0; step <= 24; step += 1) {
      const x = start + (step / 24) * length;
      const y = y0 + Math.sin((x / width) * Math.PI * 2 * periods + phase) * amplitude;
      if (step === 0) albedoCtx.moveTo(x, y);
      else albedoCtx.lineTo(x, y);
    }
    albedoCtx.stroke();
  }
  albedoCtx.restore();

  // Pores: tiny dark dashes along the grain, in the albedo and (deeper) in the height map.
  const pores = Math.round((width * height) / 900);
  for (let i = 0; i < pores; i += 1) {
    const x = rng() * width;
    const y = rng() * height;
    const length = 2 + rng() * 9;
    albedoCtx.strokeStyle = `rgba(8, 4, 2, ${0.14 + rng() * 0.3})`;
    albedoCtx.lineWidth = 0.6 + rng() * 0.9;
    albedoCtx.beginPath();
    albedoCtx.moveTo(x, y);
    albedoCtx.lineTo(x + length, y + (rng() - 0.5) * 0.8);
    albedoCtx.stroke();
    dataCtx.strokeStyle = 'rgba(40, 215, 0, 0.55)';
    dataCtx.lineWidth = 0.9;
    dataCtx.beginPath();
    dataCtx.moveTo(x, y);
    dataCtx.lineTo(x + length, y);
    dataCtx.stroke();
  }
  // Scratches, cup rings and dents: pale hairlines, a few long ones, and a couple of dark water rings.
  for (let i = 0; i < 90; i += 1) {
    const x = rng() * width;
    const y = rng() * height;
    const length = (0.04 + rng() * (i < 8 ? 0.4 : 0.1)) * width;
    const angle = (rng() - 0.5) * 1.1 + (rng() < 0.22 ? Math.PI / 2 : 0);
    const bend = (rng() - 0.5) * 10;
    albedoCtx.strokeStyle = `rgba(176, 138, 96, ${0.04 + rng() * 0.12})`;
    albedoCtx.lineWidth = 0.6 + rng() * 1.0;
    albedoCtx.beginPath();
    albedoCtx.moveTo(x, y);
    albedoCtx.quadraticCurveTo(
      x + Math.cos(angle) * length * 0.5,
      y + Math.sin(angle) * length * 0.5 + bend,
      x + Math.cos(angle) * length,
      y + Math.sin(angle) * length,
    );
    albedoCtx.stroke();
    // The same scratch is cut into the height map (a fine pale line there reads as a groove).
    dataCtx.strokeStyle = 'rgba(30, 200, 0, 0.35)';
    dataCtx.lineWidth = 0.7;
    dataCtx.beginPath();
    dataCtx.moveTo(x, y);
    dataCtx.lineTo(x + Math.cos(angle) * length, y + Math.sin(angle) * length);
    dataCtx.stroke();
  }
  for (let i = 0; i < 3; i += 1) {
    const x = (0.15 + rng() * 0.7) * width;
    const y = (0.15 + rng() * 0.7) * height;
    const radius = width * (0.022 + rng() * 0.018);
    albedoCtx.strokeStyle = 'rgba(8, 4, 2, 0.14)';
    albedoCtx.lineWidth = Math.max(1.5, width * 0.003);
    albedoCtx.beginPath();
    albedoCtx.arc(x, y, radius, 0.2, Math.PI * 1.75);
    albedoCtx.stroke();
  }
}

function configure(texture: CanvasTexture, srgb: boolean, anisotropy: number): CanvasTexture {
  // Along the boards the tile repeats as it is (every board ends at a butt joint, so it is seamless); across them it is
  // mirrored, so the boards of the second row of tiles are the first row's the other way round, not a copy.
  texture.wrapS = RepeatWrapping;
  texture.wrapT = MirroredRepeatWrapping;
  texture.colorSpace = srgb ? SRGBColorSpace : NoColorSpace;
  texture.anisotropy = anisotropy;
  texture.minFilter = LinearMipmapLinearFilter;
  texture.magFilter = LinearFilter;
  return texture;
}

/** The wood textures at `size` pixels square (a tile repeated over the table). */
export function createWoodTextures(size: number, create: CreateCanvas, anisotropy = 8): SurfaceTextures {
  const albedoCanvas = create(size, size);
  const dataCanvas = create(size, size);
  const albedoCtx = albedoCanvas.getContext('2d');
  const dataCtx = dataCanvas.getContext('2d');
  if (albedoCtx && dataCtx) drawWood(albedoCtx, dataCtx, size, size, create);
  return {
    albedo: configure(new CanvasTexture(albedoCanvas), true, anisotropy),
    data: configure(new CanvasTexture(dataCanvas), false, anisotropy),
  };
}
