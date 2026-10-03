import { MirroredRepeatWrapping, NoColorSpace, RepeatWrapping, SRGBColorSpace } from 'three';
import { describe, expect, it } from 'vitest';
import {
  GRAIN_ALPHA,
  MARBLE_CHUNK_PIXELS,
  drawMarbledPaper,
  drawMarblePlaceholder,
  marbleGreenShare,
  marbleMeanColour,
  marbleMeanLuminance,
  marbleSteps,
} from '../../src/book/marbleTexture';
import {
  NOISE_TILE_MEAN,
  drawParchment,
  makeValueNoise,
  mulberry32,
  noiseTile,
  fbm,
} from '../../src/book/paperTexture';
import {
  COVER_ASPECT,
  createCoverTextures,
  createSpineTextures,
} from '../../src/scene/textures/leatherTexture';
import {
  BOARD_SLOPES,
  MIN_HEART_DEPTH,
  WOOD_TILE_UNITS,
  createWoodTextures,
  makePlanks,
  pithDepthAt,
  ringPhase,
} from '../../src/scene/textures/woodTexture';
import { recordingCanvas } from '../helpers/recordingCanvas';

function context2d(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('the recording canvas always has a context');
  return ctx;
}

describe('procedural paper helpers', () => {
  it('the seeded random generator is deterministic and stays in [0, 1)', () => {
    const a = mulberry32(42);
    const b = mulberry32(42);
    for (let i = 0; i < 100; i += 1) {
      const value = a();
      expect(value).toBe(b());
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
    }
    expect(mulberry32(1)()).not.toBe(mulberry32(2)());
  });

  it('value noise and fractal noise stay in [0, 1] and are smooth', () => {
    const noise = makeValueNoise(mulberry32(7));
    let previous = noise(0, 0.3);
    for (let i = 1; i < 200; i += 1) {
      const value = noise(i * 0.004, 0.3);
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(1);
      expect(Math.abs(value - previous)).toBeLessThan(0.08);
      previous = value;
    }
    for (let i = 0; i < 50; i += 1) {
      const value = fbm(noise, i * 0.37, i * 0.11);
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(1);
    }
  });

  it('parchment and marbled paper draw onto the context they are given, sized to it', () => {
    const recorder = recordingCanvas();
    const canvas = recorder.create(200, 280);
    const ctx = context2d(canvas);
    drawParchment(ctx, 200, 280, recorder.create, { seed: 3 });
    expect(recorder.calls.some((call) => call.name === 'fillRect')).toBe(true);
    const marbled = recordingCanvas();
    const marbleCanvas = marbled.create(300, 420);
    drawMarbledPaper(context2d(marbleCanvas), 300, 420, marbled.create, 5);
    // The pattern is computed at the canvas's own resolution and put in place directly: nothing is upscaled.
    expect(marbled.calls.some((call) => call.name === 'putImageData')).toBe(true);
    expect(marbled.calls.some((call) => call.name === 'drawImage')).toBe(false);
  });
});

describe('the grain of the table wood', () => {
  it('has a heart that grows steadily deeper (or steadily shallower) along a board: open arches, never closed loops', () => {
    for (const [start, end] of [
      [0.2, 3],
      [3, 0.2],
    ] as const) {
      let previous = pithDepthAt(start, end, 0, 8);
      const direction = Math.sign(end - start);
      for (let along = 0.1; along <= 8; along += 0.1) {
        const depth = pithDepthAt(start, end, along, 8);
        expect(Math.sign(depth - previous) * direction).toBeGreaterThanOrEqual(0);
        previous = depth;
      }
      expect(pithDepthAt(start, end, 0, 8)).toBeCloseTo(start, 6);
      expect(pithDepthAt(start, end, 8, 8)).toBeCloseTo(end, 6);
    }
  });
});

describe('the boards of the table', () => {
  const boards = (seed: number) => makePlanks(mulberry32(seed), WOOD_TILE_UNITS.x);

  it('are cut at a slight angle to the heart: it sinks 0.004 to 0.075 per unit of length, so the arches are long (20 to 60 cm), not ripples', () => {
    for (const seed of [1, 2, 2024, 99]) {
      const slopes = boards(seed)
        .map((board) => Math.abs(board.pithEnd - board.pithStart) / WOOD_TILE_UNITS.x)
        .sort((a, b) => a - b);
      expect(slopes).toHaveLength(BOARD_SLOPES.length);
      slopes.forEach((slope, index) => {
        expect(slope).toBeCloseTo([...BOARD_SLOPES][index] ?? 0, 6);
      });
    }
  });

  it('differ from one another: one is nearly straight-grained, one is cut steeply, and the heart is not always under the middle', () => {
    const slopes = boards(2024).map((board) => Math.abs(board.pithEnd - board.pithStart) / WOOD_TILE_UNITS.x);
    expect(Math.min(...slopes)).toBeLessThan(0.01);
    expect(Math.max(...slopes)).toBeGreaterThan(0.06);
    const aside = boards(2024).map((board) => board.pithAside);
    expect(new Set(aside.map((value) => value.toFixed(3))).size).toBe(aside.length);
    expect(aside.every((value) => Math.abs(value) <= 0.35)).toBe(true);
    // They are not cut the same way round either, over several tiles' worth of seeds.
    const sinking = [1, 2, 3, 4, 5, 6].map(
      (seed) => boards(seed).filter((b) => b.pithEnd > b.pithStart).length,
    );
    expect(Math.min(...sinking)).toBeLessThan(4);
    expect(Math.max(...sinking)).toBeGreaterThan(0);
  });

  it("keep the heart deep under the face (never shallower than 0.55: a shallow heart closes the arches into bull's-eyes)", () => {
    for (const seed of [1, 2, 2024, 99, 7]) {
      for (const board of boards(seed)) {
        expect(Math.min(board.pithStart, board.pithEnd)).toBeGreaterThanOrEqual(MIN_HEART_DEPTH);
        expect(Math.max(board.pithStart, board.pithEnd)).toBeLessThan(1.6);
      }
    }
  });

  it('the ring phase always rises with the distance from the heart (the wandering spacing never folds a ring back on itself)', () => {
    for (const warm of [0, 0.3, 0.77, 1]) {
      let previous = ringPhase(0, warm);
      for (let distance = 0.01; distance <= 40; distance += 0.01) {
        const phase = ringPhase(distance, warm);
        expect(phase).toBeGreaterThan(previous);
        previous = phase;
      }
    }
  });
});

function measureNoiseTileMean(): number {
  const recorder = recordingCanvas();
  noiseTile(256, mulberry32(11), recorder.create);
  const tile = recorder.calls.find((call) => call.name === 'putImageData')?.args[0] as {
    data: Uint8ClampedArray;
  };
  let total = 0;
  for (let i = 0; i < tile.data.length; i += 4) total += tile.data[i] ?? 0;
  return total / (256 * 256) / 255;
}

describe('the marbled endpaper', () => {
  it('uses the traditional palette: its bands about a quarter of white (a third of the flyleaf once lit), and green only as a trace', () => {
    expect(marbleMeanLuminance()).toBeGreaterThan(0.2);
    expect(marbleMeanLuminance()).toBeLessThan(0.28);
    expect(marbleGreenShare()).toBeLessThanOrEqual(0.05);
  });

  it('is drawn at the size of its canvas, whatever the tier makes it (no low-resolution field scaled up)', () => {
    for (const [width, height] of [
      [96, 140],
      [240, 340],
    ] as const) {
      const recorder = recordingCanvas();
      const canvas = recorder.create(width, height);
      drawMarbledPaper(context2d(canvas), width, height, recorder.create, 7);
      // The pattern is one image the size of the canvas (the other put is the small grain tile), put at the origin.
      const fields = recorder.calls.filter(
        (call) =>
          call.name === 'putImageData' &&
          (call.args[0] as { data: Uint8ClampedArray }).data.length === width * height * 4,
      );
      expect(fields).toHaveLength(1);
    }
  });

  it('is worked out in slices: a few rows between yields, nothing put on the canvas until the last slice, and the result is the same as all at once', () => {
    const [width, height] = [300, 420];
    const sliced = recordingCanvas();
    const steps = marbleSteps(context2d(sliced.create(width, height)), width, height, sliced.create, 5, {
      turnIn: true,
    });
    const isField = (call: { name: string; args: unknown[] }): boolean =>
      call.name === 'putImageData' &&
      (call.args[0] as { data: Uint8ClampedArray }).data.length === width * height * 4;
    const fieldsAtYield: number[] = [];
    while (!steps.next().done) fieldsAtYield.push(sliced.calls.filter(isField).length);
    const rows = Math.max(1, Math.floor(MARBLE_CHUNK_PIXELS / width));
    // one yield per slice of rows (but the last), one before the image is put down, one before the turn-in
    const slices = Math.ceil(height / rows) - 1;
    expect(fieldsAtYield).toHaveLength(slices + 2);
    expect(rows * width).toBeLessThanOrEqual(MARBLE_CHUNK_PIXELS);
    expect(fieldsAtYield.slice(0, slices + 1).every((puts) => puts === 0)).toBe(true);
    expect(fieldsAtYield[slices + 1]).toBe(1);
    const all = recordingCanvas();
    drawMarbledPaper(context2d(all.create(width, height)), width, height, all.create, 5, { turnIn: true });
    const field = (calls: { name: string; args: unknown[] }[]) =>
      calls.find(
        (call) =>
          call.name === 'putImageData' &&
          (call.args[0] as { data: Uint8ClampedArray }).data.length === width * height * 4,
      )?.args[0] as { data: Uint8ClampedArray } | undefined;
    expect(field(sliced.calls)?.data).toEqual(field(all.calls)?.data);
  });

  it('is abandoned when it is cancelled between slices: nothing is put on the canvas', () => {
    const recorder = recordingCanvas();
    let asked = 0;
    const steps = marbleSteps(context2d(recorder.create(300, 420)), 300, 420, recorder.create, 5, {}, () => {
      asked += 1;
      return asked > 3;
    });
    let yields = 0;
    while (!steps.next().done) yields += 1;
    expect(yields).toBe(4); // three slices, and the fourth is where it is told to stop
    expect(recorder.calls.filter((call) => call.name === 'putImageData')).toHaveLength(0);
  });

  it("knows the grain tile's mean: the constant is the mean of a noise tile as it is really drawn (it was once off by a misplaced division)", () => {
    const recorder = recordingCanvas();
    noiseTile(256, mulberry32(3), recorder.create);
    const tile = recorder.calls.find((call) => call.name === 'putImageData')?.args[0] as {
      data: Uint8ClampedArray;
    };
    let total = 0;
    for (let i = 0; i < tile.data.length; i += 4) total += tile.data[i] ?? 0;
    expect(Math.abs(total / (256 * 256) / 255 - NOISE_TILE_MEAN)).toBeLessThan(0.004);
    expect(NOISE_TILE_MEAN).toBeCloseTo(0.645, 3);
  });

  it('has a stand-in as bright as the real sheet: the sheet does not pop from pale parchment to a dark one when it arrives', () => {
    // The sheet the endpaper really is (its seed), at the medium tier's size; the field is the pattern before the grain,
    // which multiplies the sheet by about 0.95 (the grain tile's measured mean, at its strength).
    const [width, height] = [900, 1260];
    const recorder = recordingCanvas();
    drawMarbledPaper(context2d(recorder.create(width, height)), width, height, recorder.create, 31);
    const field = recorder.calls.find(
      (call) =>
        call.name === 'putImageData' &&
        (call.args[0] as { data: Uint8ClampedArray }).data.length === width * height * 4,
    )?.args[0] as { data: Uint8ClampedArray };
    let total = 0;
    for (let i = 0; i < field.data.length; i += 4)
      total +=
        0.2126 * (field.data[i] ?? 0) + 0.7152 * (field.data[i + 1] ?? 0) + 0.0722 * (field.data[i + 2] ?? 0);
    const measuredTileMean = measureNoiseTileMean();
    const real = (total / (width * height) / 255) * (1 - GRAIN_ALPHA * (1 - measuredTileMean));
    const [r, g, b] = marbleMeanColour();
    const stand = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
    expect(Math.abs(stand - real) / real).toBeLessThan(0.02);
    // ...and nothing like the pale parchment the page showed meanwhile (about 0.8).
    expect(stand).toBeLessThan(0.4);
  });

  it('draws the stand-in at once, in the same turn-in, with one flat fill and no per-pixel work', () => {
    const framed = recordingCanvas();
    drawMarblePlaceholder(context2d(framed.create(96, 134)), 96, 134, framed.create, { turnIn: true });
    expect(framed.calls.filter((call) => call.name === 'fillRect')).toHaveLength(1);
    expect(
      framed.calls.some(
        (call) =>
          call.name === 'putImageData' &&
          (call.args[0] as { data: Uint8ClampedArray }).data.length === 96 * 134 * 4,
      ),
    ).toBe(false);
    expect(framed.calls.filter((call) => call.name === 'strokeRect').length).toBeGreaterThanOrEqual(2);
    const plain = recordingCanvas();
    drawMarblePlaceholder(context2d(plain.create(96, 134)), 96, 134, plain.create);
    expect(plain.calls.filter((call) => call.name === 'strokeRect')).toHaveLength(0);
  });

  it('puts a leather turn-in round the paper when asked, and not otherwise', () => {
    const plain = recordingCanvas();
    drawMarbledPaper(context2d(plain.create(120, 170)), 120, 170, plain.create, 7);
    const framed = recordingCanvas();
    drawMarbledPaper(context2d(framed.create(120, 170)), 120, 170, framed.create, 7, { turnIn: true });
    const strokes = (calls: { name: string }[]): number =>
      calls.filter((c) => c.name === 'strokeRect').length;
    expect(strokes(plain.calls)).toBe(0);
    expect(strokes(framed.calls)).toBeGreaterThanOrEqual(2); // the gilt fillet and the edge of the paper
  });
});

describe('the table wood', () => {
  it('is an albedo (sRGB) and a packed data map (linear), both repeating', () => {
    const recorder = recordingCanvas();
    const wood = createWoodTextures(256, recorder.create, 4);
    expect(wood.albedo.colorSpace).toBe(SRGBColorSpace);
    expect(wood.data.colorSpace).toBe(NoColorSpace);
    expect(wood.albedo.wrapS).toBe(RepeatWrapping); // along the boards: they end at butt joints, so it is seamless
    expect(wood.data.wrapT).toBe(MirroredRepeatWrapping); // across them: the second row of tiles is the first one's reverse
    expect(wood.albedo.anisotropy).toBe(4);
    expect(wood.albedo.image).toMatchObject({ width: 256, height: 256 });
    expect(WOOD_TILE_UNITS.x).toBeGreaterThan(WOOD_TILE_UNITS.z);
  });

  it('draws pores and scratches and only a few faint streaks (a corduroy of streaks reads as stripes)', () => {
    const recorder = recordingCanvas();
    createWoodTextures(128, recorder.create);
    const strokes = recorder.calls.filter((call) => call.name === 'stroke').length;
    expect(strokes).toBeGreaterThan(150);
    expect(strokes).toBeLessThan(500);
  });

  it('survives a canvas without a 2D context', () => {
    const wood = createWoodTextures(
      64,
      () => ({ width: 64, height: 64, getContext: () => null }) as unknown as HTMLCanvasElement,
    );
    expect(wood.albedo).toBeDefined();
  });
});

describe('the cover leather', () => {
  it('has the proportions of a board, with albedo, packed data and the sigil as its own emissive map', () => {
    const recorder = recordingCanvas();
    const cover = createCoverTextures(300, recorder.create, 4, true);
    expect(cover.albedo.image).toMatchObject({ width: Math.round(300 * COVER_ASPECT), height: 300 });
    expect(cover.albedo.colorSpace).toBe(SRGBColorSpace);
    expect(cover.emissive.colorSpace).toBe(SRGBColorSpace);
    expect(cover.data.colorSpace).toBe(NoColorSpace);
  });

  it('draws the gold tooling into all three layers, and none of it for the art-free grain tile', () => {
    const withArt = recordingCanvas();
    createCoverTextures(300, withArt.create, 4, true);
    const without = recordingCanvas();
    createCoverTextures(300, without.create, 4, false);
    const arcs = (calls: typeof withArt.calls) => calls.filter((call) => call.name === 'arc').length;
    expect(arcs(withArt.calls)).toBeGreaterThan(100);
    expect(arcs(without.calls)).toBe(0);
  });

  it('is symmetric under a half turn: every scratch is drawn twice, once rotated by pi about the centre', () => {
    const recorder = recordingCanvas();
    createCoverTextures(200, recorder.create, 4, false);
    const rotations = recorder.calls.filter(
      (call) => call.name === 'rotate' && call.args[0] === Math.PI,
    ).length;
    expect(rotations).toBeGreaterThan(40);
  });

  it('the spine texture carries tooling lines and is one texture set', () => {
    const recorder = recordingCanvas();
    const spine = createSpineTextures(recorder.create, 4);
    expect(spine.albedo.image).toMatchObject({ width: 256, height: 1024 });
    expect(recorder.calls.filter((call) => call.name === 'lineTo').length).toBeGreaterThan(20);
  });

  it("the spine has the cover leather's texel density (a quarter as wide as it is long, at the same height as the cover)", () => {
    for (const height of [512, 1024, 2048]) {
      const recorder = recordingCanvas();
      const spine = createSpineTextures(recorder.create, 4, height);
      const cover = createCoverTextures(height, recorder.create, 4);
      // The cover is `height` pixels tall for 2.24 units of board; the spine is `height` pixels long for 2.24 units.
      expect(spine.albedo.image).toMatchObject({ height });
      expect((cover.albedo.image as { height: number }).height).toBe(height);
      expect((spine.albedo.image as { width: number }).width).toBe(height / 4);
    }
  });
});
