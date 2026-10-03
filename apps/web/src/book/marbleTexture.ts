import { NOISE_TILE_MEAN, fbm, makeValueNoise, mulberry32, noiseTile, type Ctx2D } from './paperTexture';

/*
 * The marbled endpaper (the pastedown inside the boards), drawn the way marbled paper is made: colours are dropped in
 * bands on a bath, raked and combed into a pattern, and a sheet is laid on it. This is the classic COMBED pattern
 * (a "nonpareil", the marbling of most old bindings): flat bands of colour, each separated by a thin pale line, pulled
 * by two combs (one with narrow teeth, one with wide) into rows of curved feathers. The palette is the traditional one:
 * burgundy, umber, gold, cream, with a trace of dark green. There is no gradient and no glow. The bands come to
 * about a quarter of white (a third of the flyleaf's brightness once lit), so it is the quietest large surface in the open
 * book and the flyleaf stays what the eye goes to. It is drawn at the canvas's own resolution (no upscaling), and a leather turn-in frames it, as in a real
 * binding where the leather is folded over the board's edges and the paper is pasted down inside it.
 */

type RGB = readonly [number, number, number];

const BURGUNDY: RGB = [88, 26, 36];
const OXBLOOD: RGB = [54, 16, 24];
const UMBER: RGB = [108, 70, 40];
const GOLD: RGB = [144, 112, 56];
const CREAM: RGB = [172, 158, 124];
const FOREST: RGB = [48, 66, 50];
/** The thin pale line between two bands of colour. */
const VEIN: RGB = [186, 172, 138];

/**
 * The palette with its weights: the bands come to about a quarter of white; with the veins, the specks and the light on the
 * board the pastedown is about a third of the flyleaf's brightness (it must sit back, not compete with the page). Green is a trace.
 */
const BANDS: readonly { colour: RGB; weight: number }[] = [
  { colour: BURGUNDY, weight: 0.32 },
  { colour: OXBLOOD, weight: 0.28 },
  { colour: UMBER, weight: 0.2 },
  { colour: GOLD, weight: 0.11 },
  { colour: CREAM, weight: 0.05 },
  { colour: FOREST, weight: 0.03 },
];

/** Mean luminance (0..1, Rec. 709 on the sRGB values) of the palette by its weights, thin lines excluded. */
export function marbleMeanLuminance(): number {
  let total = 0;
  let weights = 0;
  for (const { colour, weight } of BANDS) {
    total += weight * (0.2126 * colour[0] + 0.7152 * colour[1] + 0.0722 * colour[2]);
    weights += weight;
  }
  return total / weights / 255;
}

/** How strongly the paper grain is multiplied over the sheet (the grain tile's mean is paperTexture's `NOISE_TILE_MEAN`). */
export const GRAIN_ALPHA = 0.14;
/** The share of the sheet's colour that the pale veins take (about 62% of the boundaries, 0.0028 sheet units wide, half a ramp). */
const VEIN_SHARE = 0.04;

let meanColour: RGB | null = null;

/**
 * The colour the marbling comes to on average: the bands as this very sheet lays them (its seed, its combs, at a size
 * where they are resolved), the veins' share of paler colour, and the grain's darkening. It is what a sheet of it looks
 * like from far enough away, and stands in for the endpaper while the real one is being drawn. Worked out once.
 */
export function marbleMeanColour(): RGB {
  if (meanColour) return meanColour;
  const [width, height] = [96, 134];
  const data = new Uint8ClampedArray(width * height * 4);
  const field = marbleField(data, width, height, mulberry32(31), () => false, 0);
  while (!field.next().done) {
    // every slice, in turn
  }
  const grain = 1 - GRAIN_ALPHA * (1 - NOISE_TILE_MEAN);
  const channel = (index: 0 | 1 | 2): number => {
    let total = 0;
    for (let i = index; i < data.length; i += 4) total += data[i] ?? 0;
    const bands = total / (width * height);
    return Math.round((bands + (VEIN[index] - bands) * VEIN_SHARE) * grain);
  };
  meanColour = [channel(0), channel(1), channel(2)];
  return meanColour;
}

/** Share of the bands (by weight) that is green: a trace, not a camouflage. */
export function marbleGreenShare(): number {
  return (
    (BANDS.find((band) => band.colour === FOREST)?.weight ?? 0) /
    BANDS.reduce((sum, band) => sum + band.weight, 0)
  );
}

export interface MarbleOptions {
  /** Frame the paper with the leather turn-in of the board (the endpaper of a binding), 7.5 mm wide. */
  turnIn?: boolean;
  /** Board width and depth in scene units (10 cm), for the turn-in's proportions. */
  board?: { width: number; depth: number };
}

/** The tooth of a comb: a triangle wave in [-1, 1] with period 1, rounded a little (the paint is not a solid). */
function tooth(t: number): number {
  const triangle = Math.abs(2 * (t - Math.floor(t)) - 1) * 2 - 1;
  const round = Math.sin(2 * Math.PI * t);
  return 0.55 * triangle + 0.45 * round;
}

function bandColour(pick: number): RGB {
  let sum = 0;
  for (const band of BANDS) {
    sum += band.weight;
    if (pick <= sum) return band.colour;
  }
  return BURGUNDY;
}

/** The bands laid on the bath: irregular widths and a colour each, as boundaries along the sheet's height. */
function laidBands(rng: () => number): { edges: Float32Array; colours: RGB[] } {
  const edges: number[] = [-1.2];
  const colours: RGB[] = [];
  let previous = -1;
  while ((edges[edges.length - 1] ?? 0) < 6) {
    // Fine bands (1 to 5 mm of a 22 cm sheet): the comb pulls them into a close pattern, not into broad waves.
    const width = 0.011 + rng() * 0.04;
    edges.push((edges[edges.length - 1] ?? 0) + width);
    let pick = bandColour(rng());
    // The same colour twice in a row would be one wide band: take another.
    for (
      let tries = 0;
      tries < 4 && BANDS.findIndex((band) => band.colour === pick) === previous;
      tries += 1
    ) {
      pick = bandColour(rng());
    }
    previous = BANDS.findIndex((band) => band.colour === pick);
    colours.push(pick);
  }
  return { edges: Float32Array.from(edges), colours };
}

/** Draws the leather turn-in: a frame of leather with a gilt fillet and mitred corners. */
function drawTurnIn(
  ctx: Ctx2D,
  width: number,
  height: number,
  create: (w: number, h: number) => HTMLCanvasElement,
  rng: () => number,
  board: { width: number; depth: number },
): void {
  const marginX = Math.round((0.075 / board.width) * width);
  const marginY = Math.round((0.075 / board.depth) * height);
  ctx.save();
  // The leather: the cover's dark burgundy, with its grain.
  ctx.fillStyle = '#3a1218';
  ctx.beginPath();
  ctx.rect(0, 0, width, height);
  ctx.rect(marginX, marginY, width - 2 * marginX, height - 2 * marginY);
  ctx.fill('evenodd');
  const tile = noiseTile(128, rng, create);
  const pattern = ctx.createPattern(tile, 'repeat');
  if (pattern) {
    ctx.globalCompositeOperation = 'multiply';
    ctx.globalAlpha = 0.5;
    ctx.fillStyle = pattern;
    ctx.beginPath();
    ctx.rect(0, 0, width, height);
    ctx.rect(marginX, marginY, width - 2 * marginX, height - 2 * marginY);
    ctx.fill('evenodd');
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
  }
  // The mitred corners: the leather is folded over the corner, so a seam runs along each diagonal.
  ctx.strokeStyle = 'rgba(14, 4, 6, 0.55)';
  ctx.lineWidth = Math.max(1, width * 0.0025);
  for (const [cx, cy, dx, dy] of [
    [0, 0, 1, 1],
    [width, 0, -1, 1],
    [width, height, -1, -1],
    [0, height, 1, -1],
  ] as const) {
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(cx + dx * marginX, cy + dy * marginY);
    ctx.stroke();
  }
  // A gilt fillet in the leather, a little outside the paper's edge, and the shadow where the paper meets it.
  const inset = Math.min(marginX, marginY) * 0.42;
  ctx.strokeStyle = 'rgba(190, 150, 76, 0.85)';
  ctx.lineWidth = Math.max(1, width * 0.0028);
  ctx.strokeRect(
    inset,
    inset * (marginY / marginX),
    width - 2 * inset,
    height - 2 * inset * (marginY / marginX),
  );
  ctx.strokeStyle = 'rgba(8, 2, 3, 0.7)';
  ctx.lineWidth = Math.max(1, width * 0.003);
  ctx.strokeRect(marginX, marginY, width - 2 * marginX, height - 2 * marginY);
  ctx.restore();
}

/** Pixels worked out between two yields: a few milliseconds of main-thread time on a desktop, a small slice on a phone. */
export const MARBLE_CHUNK_PIXELS = 12000;

/**
 * The combed pattern itself, worked out into `data` (RGBA, `width` x `height`) a few rows at a time: the bands, the combs,
 * the pale veins. Takes the sheet's random generator in the state `marbleSteps` has it (the rest of the sheet goes on
 * with the same generator). Returns false if it was cancelled (asked at each yield), true when `data` is complete.
 */
function* marbleField(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  rng: () => number,
  cancelled: () => boolean,
  /** How thick, in sheet units, the pale line between bands is (about a pixel and a half at the usual size). */
  veinHalf = Math.max(0.0028, 0.9 / (height / 4.2)),
): Generator<void, boolean> {
  const noise = makeValueNoise(rng);
  const { edges, colours } = laidBands(rng);
  // Every other boundary carries a pale line; the others are a plain change of colour.
  const veined = Array.from({ length: edges.length }, () => rng() < 0.62);
  const rowsPerSlice = Math.max(1, Math.floor(MARBLE_CHUNK_PIXELS / Math.max(width, 1)));
  for (let py = 0; py < height; py += 1) {
    const y = (py / height) * 4.2;
    for (let px = 0; px < width; px += 1) {
      const x = (px / width) * 3;
      // The bath flows a little, then a comb with narrow teeth and one with wide teeth are drawn through it.
      const flow = (fbm(noise, x * 1.3 + 3.1, y * 1.3 + 1.7, 2) - 0.5) * 0.13;
      // The teeth are never quite evenly spaced or pulled with quite the same force: a slow drift in both.
      const drift = fbm(noise, y * 0.8 + 7.3, x * 0.45 + 2.9, 2);
      const force = 0.55 + 0.9 * fbm(noise, y * 0.6 + 12.1, x * 0.7 + 5.5, 2);
      const pulled =
        y +
        0.075 * force * tooth(x / 0.17 + 0.13 + 1.7 * (drift - 0.5)) +
        0.17 * tooth(x / 0.74 + 0.41 + 0.9 * (drift - 0.5)) +
        0.05 * tooth(y / 0.9 + x * 0.35) +
        flow;
      // Which band the (pulled) point falls in: binary search over the boundaries.
      let low = 0;
      let high = edges.length - 1;
      while (high - low > 1) {
        const mid = (low + high) >> 1;
        if ((edges[mid] ?? 0) <= pulled) low = mid;
        else high = mid;
      }
      const base = colours[low] ?? BURGUNDY;
      const nearest = Math.min(pulled - (edges[low] ?? 0), (edges[low + 1] ?? 0) - pulled);
      const boundary = nearest === pulled - (edges[low] ?? 0) ? low : low + 1;
      const vein = (veined[boundary] ?? false) && nearest < veinHalf ? 1 - nearest / veinHalf : 0;
      const alpha = vein * 0.7;
      const i = (py * width + px) * 4;
      data[i] = base[0] * (1 - alpha) + VEIN[0] * alpha;
      data[i + 1] = base[1] * (1 - alpha) + VEIN[1] * alpha;
      data[i + 2] = base[2] * (1 - alpha) + VEIN[2] * alpha;
      data[i + 3] = 255;
    }
    if ((py + 1) % rowsPerSlice === 0 && py + 1 < height) {
      yield;
      if (cancelled()) return false;
    }
  }
  return true;
}

/**
 * Marbled paper: the combed pattern, at the canvas's own resolution, then grained like paper, worked out a few rows at
 * a time. It yields between the slices (and before each of the heavier finishing steps) so a caller can spread the
 * work over many turns of the event loop: the whole sheet is a per-pixel loop of 0.2 to 0.7 s, which as a single task
 * freezes the page. `cancelled` is asked at each yield; when it says so the sheet is abandoned (nothing is left half
 * drawn on the canvas: the image is only put down at the end).
 */
export function* marbleSteps(
  ctx: Ctx2D,
  width: number,
  height: number,
  create: (w: number, h: number) => HTMLCanvasElement,
  seed = 31,
  options: MarbleOptions = {},
  cancelled: () => boolean = () => false,
): Generator<void> {
  const rng = mulberry32(seed);
  const image = ctx.createImageData(width, height);
  if (!(yield* marbleField(image.data, width, height, rng, cancelled))) return;
  yield;
  if (cancelled()) return;
  ctx.putImageData(image, 0, 0);
  ctx.save();
  // A few specks of colour the way a flicked brush leaves them, and a fine paper grain over everything.
  for (let i = 0; i < Math.round((width * height) / 9000); i += 1) {
    ctx.fillStyle = `rgba(214, 198, 160, ${0.18 + rng() * 0.3})`;
    ctx.beginPath();
    ctx.arc(rng() * width, rng() * height, 0.5 + rng() * 0.9, 0, Math.PI * 2);
    ctx.fill();
  }
  const tile = noiseTile(256, rng, create);
  const pattern = ctx.createPattern(tile, 'repeat');
  if (pattern) {
    ctx.globalCompositeOperation = 'multiply';
    ctx.globalAlpha = GRAIN_ALPHA;
    ctx.fillStyle = pattern;
    ctx.fillRect(0, 0, width, height);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
  }
  ctx.restore();
  if (options.turnIn) {
    yield;
    if (cancelled()) return;
    drawTurnIn(ctx, width, height, create, rng, options.board ?? { width: 1.63, depth: 2.24 });
  }
}

/** Marbled paper, all at once (see `marbleSteps` for the same drawn a slice at a time). */
export function drawMarbledPaper(
  ctx: Ctx2D,
  width: number,
  height: number,
  create: (w: number, h: number) => HTMLCanvasElement,
  seed = 31,
  options: MarbleOptions = {},
): void {
  const steps = marbleSteps(ctx, width, height, create, seed, options);
  while (!steps.next().done) {
    // every slice, in turn
  }
}

/**
 * A stand-in for the endpaper while its marbling is worked out: the marbling's mean colour, in the same leather
 * turn-in (when asked), drawn at once at any size. It is as bright as the real sheet will be, so the sheet does not
 * pop from pale parchment to a dark one when it arrives; only its detail comes in.
 */
export function drawMarblePlaceholder(
  ctx: Ctx2D,
  width: number,
  height: number,
  create: (w: number, h: number) => HTMLCanvasElement,
  options: MarbleOptions = {},
): void {
  const [r, g, b] = marbleMeanColour();
  ctx.fillStyle = `rgb(${String(r)}, ${String(g)}, ${String(b)})`;
  ctx.fillRect(0, 0, width, height);
  if (options.turnIn)
    drawTurnIn(ctx, width, height, create, mulberry32(31), options.board ?? { width: 1.63, depth: 2.24 });
}
