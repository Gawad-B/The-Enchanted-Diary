import { CanvasTexture, LinearFilter, LinearMipmapLinearFilter, NoColorSpace, SRGBColorSpace } from 'three';
import { fbm, makeValueNoise, mulberry32, noiseTile, type Ctx2D } from '../../book/paperTexture';
import { drawTooling, roundedRectPath, toolStroke, type Tooling } from './coverOrnaments';
import type { SurfaceTextures } from './woodTexture';

/*
 * The cover: aged burgundy-brown leather with a gold-tooled border and the diary's sigil. Three canvases
 * from the same drawing: albedo (sRGB), a packed data map (R height for the bump, G roughness, B metalness of
 * the gold), and an emissive map holding only the sigil's lines (they glow faintly with `edgeGlow`).
 *
 * The whole cover is invariant under a half turn about its centre (the noise is symmetrised, the scratches
 * are drawn twice, the ornaments come in rotated pairs), so a closed book that turns over and swaps its
 * layout direction looks identical before and after.
 */

/** Board width over height. */
export const COVER_ASPECT = 0.7;

type CreateCanvas = (width: number, height: number) => HTMLCanvasElement;

export interface CoverTextures extends SurfaceTextures {
  emissive: CanvasTexture;
}

/** Calls `draw` as is and again rotated by a half turn about the centre of the canvas. */
function drawTwice(ctx: Ctx2D, w: number, h: number, draw: () => void): void {
  draw();
  ctx.save();
  ctx.translate(w, h);
  ctx.rotate(Math.PI);
  draw();
  ctx.restore();
}

/** Draws the cover into the three canvases (pure drawing, usable on any canvases). */
export function drawLeather(
  albedoCtx: Ctx2D,
  dataCtx: Ctx2D,
  emissiveCtx: Ctx2D,
  w: number,
  h: number,
  create: CreateCanvas,
  art = true,
): void {
  const rng = mulberry32(886);
  const noise = makeValueNoise(rng);
  const lowW = Math.max(96, Math.round(w / 2));
  const lowH = Math.max(96, Math.round(h / 2));
  const colour = create(lowW, lowH);
  const data = create(lowW, lowH);
  const colourCtx = colour.getContext('2d');
  const dataLowCtx = data.getContext('2d');
  if (!colourCtx || !dataLowCtx) return;
  const colourImage = colourCtx.createImageData(lowW, lowH);
  const dataImage = dataLowCtx.createImageData(lowW, lowH);

  // Symmetrised low-frequency mottling: the average of the field and its half-turned copy.
  const mottle = (x: number, y: number): number =>
    (fbm(noise, x * 0.012, y * 0.012, 4) + fbm(noise, (lowW - x) * 0.012, (lowH - y) * 0.012, 4)) / 2;
  const pebble = (x: number, y: number): number =>
    noise(x * 0.34, y * 0.34) * 0.6 + noise(x * 0.9 + 31, y * 0.9 + 17) * 0.4;

  for (let py = 0; py < lowH; py += 1) {
    // The lower half is a half-turned copy of the upper half for the fine pebbling (white-ish noise: no seam).
    const mirrored = py >= lowH / 2;
    for (let px = 0; px < lowW; px += 1) {
      const sx = mirrored ? lowW - 1 - px : px;
      const sy = mirrored ? lowH - 1 - py : py;
      const m = mottle(px, py);
      const grain = pebble(sx, sy);
      // Edge darkening: handled leather is darker and greasier toward the edges and corners.
      const ex = Math.min(px, lowW - 1 - px) / lowW;
      const ey = Math.min(py, lowH - 1 - py) / lowH;
      const edge = Math.min(1, Math.min(ex, ey * 0.7) / 0.07);
      const worn = 0.62 + 0.38 * edge;
      const tone = (0.72 + m * 0.5) * worn * (0.9 + grain * 0.22);
      const i = (py * lowW + px) * 4;
      colourImage.data[i] = 86 * tone;
      colourImage.data[i + 1] = 30 * tone;
      colourImage.data[i + 2] = 33 * tone;
      colourImage.data[i + 3] = 255;
      dataImage.data[i] = 128 + (grain - 0.5) * 110 + (m - 0.5) * 24;
      dataImage.data[i + 1] = 168 + (1 - grain) * 62 + (1 - edge) * 24 - m * 30;
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
    target.drawImage(source, 0, 0, w, h);
    target.restore();
  }

  // Fine pebbling at full resolution, half-turn symmetric.
  const tile = noiseTile(256, rng, create);
  for (const target of [albedoCtx, dataCtx]) {
    const pattern = target.createPattern(tile, 'repeat');
    if (!pattern) continue;
    target.save();
    target.globalCompositeOperation = 'multiply';
    target.globalAlpha = target === albedoCtx ? 0.2 : 0.12;
    target.fillStyle = pattern;
    target.fillRect(0, 0, w, h / 2);
    target.translate(w, h);
    target.rotate(Math.PI);
    target.fillRect(0, 0, w, h / 2);
    target.restore();
  }

  // Scratches and scuffs, each drawn twice (once rotated a half turn) to keep the symmetry.
  for (let i = 0; i < 46; i += 1) {
    const x = rng() * w;
    const y = rng() * h;
    const length = (0.03 + rng() * (i < 5 ? 0.35 : 0.1)) * w;
    const angle = rng() * Math.PI;
    const alpha = 0.05 + rng() * 0.16;
    const width = 0.6 + rng() * 1.2;
    const bend = (rng() - 0.5) * length * 0.2;
    drawTwice(albedoCtx, w, h, () => {
      albedoCtx.strokeStyle = `rgba(214, 160, 130, ${alpha})`;
      albedoCtx.lineWidth = width;
      albedoCtx.beginPath();
      albedoCtx.moveTo(x, y);
      albedoCtx.quadraticCurveTo(
        x + Math.cos(angle) * length * 0.5 + bend,
        y + Math.sin(angle) * length * 0.5,
        x + Math.cos(angle) * length,
        y + Math.sin(angle) * length,
      );
      albedoCtx.stroke();
    });
    drawTwice(dataCtx, w, h, () => {
      dataCtx.strokeStyle = 'rgba(40, 235, 0, 0.5)';
      dataCtx.lineWidth = width;
      dataCtx.beginPath();
      dataCtx.moveTo(x, y);
      dataCtx.lineTo(x + Math.cos(angle) * length, y + Math.sin(angle) * length);
      dataCtx.stroke();
    });
  }
  // Rubbed patches: a few soft, lighter, smoother areas where hands rest.
  for (let i = 0; i < 7; i += 1) {
    const x = rng() * w;
    const y = rng() * h;
    const radius = (0.06 + rng() * 0.12) * w;
    drawTwice(albedoCtx, w, h, () => {
      const gradient = albedoCtx.createRadialGradient(x, y, 0, x, y, radius);
      gradient.addColorStop(0, 'rgba(196, 120, 96, 0.13)');
      gradient.addColorStop(1, 'rgba(196, 120, 96, 0)');
      albedoCtx.fillStyle = gradient;
      albedoCtx.fillRect(x - radius, y - radius, radius * 2, radius * 2);
    });
  }
  // Worn corners: darker, with the dye rubbed off at the very tip.
  for (const [cx, cy] of [
    [0, 0],
    [w, 0],
    [w, h],
    [0, h],
  ] as const) {
    const radius = w * 0.2;
    const gradient = albedoCtx.createRadialGradient(cx, cy, 0, cx, cy, radius);
    gradient.addColorStop(0, 'rgba(18, 7, 7, 0.55)');
    gradient.addColorStop(0.55, 'rgba(18, 7, 7, 0.18)');
    gradient.addColorStop(1, 'rgba(18, 7, 7, 0)');
    albedoCtx.fillStyle = gradient;
    albedoCtx.fillRect(cx - radius, cy - radius, radius * 2, radius * 2);
  }

  if (art) {
    // Blind-stamped panel between the frame and the sigil: a darker, pressed line in the height map only.
    dataCtx.save();
    dataCtx.strokeStyle = 'rgba(70, 150, 0, 0.7)';
    dataCtx.lineWidth = w * 0.003;
    roundedRectPath(dataCtx, w * 0.125, w * 0.125, w - 2 * w * 0.125, h - 2 * w * 0.125, w * 0.01);
    dataCtx.stroke();
    dataCtx.restore();
    // Hinge grooves, one near each long edge (the cover has no preferred spine side).
    for (const x of [w * 0.04, w * 0.96]) {
      albedoCtx.fillStyle = 'rgba(12, 4, 4, 0.34)';
      albedoCtx.fillRect(x - w * 0.006, 0, w * 0.012, h);
      dataCtx.fillStyle = 'rgba(70, 150, 0, 0.6)';
      dataCtx.fillRect(x - w * 0.006, 0, w * 0.012, h);
    }

    // Gold tooling into each layer; the emissive canvas is cleared to black first.
    emissiveCtx.fillStyle = '#000';
    emissiveCtx.fillRect(0, 0, w, h);
    drawTooling({ ctx: albedoCtx, layer: 'albedo', w, h });
    drawTooling({ ctx: dataCtx, layer: 'data', w, h });
    drawTooling({ ctx: emissiveCtx, layer: 'emissive', w, h });
  }
}

function configure(texture: CanvasTexture, srgb: boolean, anisotropy: number): CanvasTexture {
  texture.colorSpace = srgb ? SRGBColorSpace : NoColorSpace;
  texture.anisotropy = anisotropy;
  texture.minFilter = LinearMipmapLinearFilter;
  texture.magFilter = LinearFilter;
  return texture;
}

/** The cover textures: `size` is the height in pixels, the width follows the board's proportions. */
export function createCoverTextures(
  size: number,
  create: CreateCanvas,
  anisotropy = 8,
  art = true,
): CoverTextures {
  const w = Math.round(size * COVER_ASPECT);
  const albedoCanvas = create(w, size);
  const dataCanvas = create(w, size);
  const emissiveCanvas = create(w, size);
  const albedoCtx = albedoCanvas.getContext('2d');
  const dataCtx = dataCanvas.getContext('2d');
  const emissiveCtx = emissiveCanvas.getContext('2d');
  if (albedoCtx && dataCtx && emissiveCtx) drawLeather(albedoCtx, dataCtx, emissiveCtx, w, size, create, art);
  return {
    albedo: configure(new CanvasTexture(albedoCanvas), true, anisotropy),
    data: configure(new CanvasTexture(dataCanvas), false, anisotropy),
    emissive: configure(new CanvasTexture(emissiveCanvas), true, anisotropy),
  };
}

/**
 * The fractions along the spine where the raised cords sit (v = 0.5 + fraction / 2; mirrors spineGeometry's
 * BAND_FRACTIONS).
 */
const SPINE_BAND_V = [0.18, 0.34, 0.5, 0.66, 0.82] as const;

/**
 * The spine's leather: the same grain as the cover (at the same texel density: `height` pixels along the spine is the
 * cover's height in pixels, and the arc takes a quarter of it across), with a double gilt fillet on each side of every
 * raised cord, gilt lines at the head and the tail, a small lozenge in each compartment, and the dark lines of the
 * French grooves where the leather meets the boards. Mapped with u along the arc and v along the spine; every line
 * runs across u, so a half turn of the book leaves it unchanged.
 */
export function createSpineTextures(create: CreateCanvas, anisotropy = 4, height = 1024): SurfaceTextures {
  const h = height;
  const w = Math.max(64, Math.round(height / 4));
  const k = h / 1024;
  const albedoCanvas = create(w, h);
  const dataCanvas = create(w, h);
  const emissiveCanvas = create(w, h);
  const albedoCtx = albedoCanvas.getContext('2d');
  const dataCtx = dataCanvas.getContext('2d');
  const emissiveCtx = emissiveCanvas.getContext('2d');
  if (albedoCtx && dataCtx && emissiveCtx) {
    drawLeather(albedoCtx, dataCtx, emissiveCtx, w, h, create, false);
    const lines = (t: Tooling): void => {
      const { ctx } = t;
      const across = (y: number, width: number): void => {
        toolStroke(t, width * k, () => {
          ctx.beginPath();
          ctx.moveTo(w * 0.07, y);
          ctx.lineTo(w * 0.93, y);
          ctx.stroke();
        });
      };
      for (const v of SPINE_BAND_V) {
        for (const side of [-1, 1]) {
          across((v + side * 0.0215) * h, 3);
          across((v + side * 0.0295) * h, 1.4);
        }
      }
      for (const v of [0.02, 0.98]) across(v * h, 3);
      for (const v of [0.034, 0.966]) across(v * h, 1.4);
      // A small lozenge, with a dot on each side of it, in the middle of each compartment.
      toolStroke(t, 2 * k, () => {
        for (const v of [0.26, 0.42, 0.58, 0.74]) {
          const y = v * h;
          const r = w * 0.09;
          ctx.beginPath();
          ctx.moveTo(w / 2, y - r * 1.3);
          ctx.lineTo(w / 2 + r, y);
          ctx.lineTo(w / 2, y + r * 1.3);
          ctx.lineTo(w / 2 - r, y);
          ctx.closePath();
          ctx.stroke();
          for (const dx of [-0.28, 0.28]) {
            ctx.beginPath();
            ctx.arc(w * (0.5 + dx), y, 2.2 * k, 0, Math.PI * 2);
            ctx.stroke();
          }
        }
      });
    };
    lines({ ctx: albedoCtx, layer: 'albedo', w, h });
    lines({ ctx: dataCtx, layer: 'data', w, h });
    // The French grooves: a dark line where the leather turns from the spine to each board.
    for (const u of [0.036, 0.964]) {
      albedoCtx.fillStyle = 'rgba(8, 3, 4, 0.55)';
      albedoCtx.fillRect(u * w - 3.2 * k, 0, 6.4 * k, h);
      dataCtx.fillStyle = 'rgba(60, 150, 0, 0.8)';
      dataCtx.fillRect(u * w - 3.2 * k, 0, 6.4 * k, h);
    }
  }
  return {
    albedo: configure(new CanvasTexture(albedoCanvas), true, anisotropy),
    data: configure(new CanvasTexture(dataCanvas), false, anisotropy),
  };
}
