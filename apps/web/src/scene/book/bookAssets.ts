import {
  BoxGeometry,
  CanvasTexture,
  MeshBasicMaterial,
  MeshPhysicalMaterial,
  PlaneGeometry,
  SRGBColorSpace,
  type BufferGeometry,
  type MeshStandardMaterial,
  type Texture,
} from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { drawParchment } from '../../book/paperTexture';
import { QUALITY_TIERS, type QualityTier } from '../quality';
import { createCoverTextures, createSpineTextures, type CoverTextures } from '../textures/leatherTexture';
import type { SurfaceTextures } from '../textures/woodTexture';
import { createBookUniforms, type BookUniforms } from './bookUniforms';
import {
  attachBookEffects,
  createEndpaperMaterial,
  createLeatherMaterials,
  createStackMaterials,
  type LeatherMaterials,
  type StackMaterials,
} from './bookMaterials';
import { BOARD_OVERHANG, BOARD_T, PAGE_H, PAGE_W } from './dimensions';
import { buildLeafGeometry } from './leafGeometry';
import { createLeafSlot, disposeLeafSlot, type LeafSlot } from './leafMaterial';
import { slotCountFor } from './leafPlan';
import { createBindingDetails, type BindingDetails } from './bindingDetails';
import { createSpineGeometry } from './spineGeometry';

/**
 * Everything the 3D book owns that costs GPU or memory, created once per scene mount and disposed with it:
 * procedural textures, materials, the shared geometries and the pool of leaf slots. Nothing in here is
 * created while the book animates.
 */

export type CreateCanvas = (width: number, height: number) => HTMLCanvasElement;

export interface BookAssets {
  uniforms: BookUniforms;
  cover: CoverTextures;
  grain: CoverTextures;
  spine: SurfaceTextures;
  leather: LeatherMaterials;
  endpaper: MeshStandardMaterial;
  stackPositive: StackMaterials;
  stackNegative: StackMaterials;
  slots: LeafSlot[];
  leafGeometryLtr: BufferGeometry;
  leafGeometryRtl: BufferGeometry;
  stackGeometry: BufferGeometry;
  boardGeometry: BufferGeometry;
  spineGeometry: BufferGeometry;
  spineMaterial: MeshPhysicalMaterial;
  /** Plain parchment shown on a leaf's face until its real texture is ready. */
  fallbackPaper: CanvasTexture;
  /** The soft contact shadow under the book (the only shadow on the low tier). */
  shadowGeometry: BufferGeometry;
  shadowMaterial: MeshBasicMaterial;
  shadowOpacity: number;
  slotCount: number;
  /** The silk headbands and the ribbon bookmark. */
  binding: BindingDetails;
  dispose(): void;
}

/** A rounded rectangle blurred by stacking: an alpha mask for a soft contact shadow. */
function softShadowTexture(create: CreateCanvas): CanvasTexture {
  const size = 256;
  const canvas = create(size, size);
  const ctx = canvas.getContext('2d');
  if (ctx) {
    ctx.clearRect(0, 0, size, size);
    const steps = 26;
    for (let i = 0; i < steps; i += 1) {
      const inset = 20 + i * 4.2;
      ctx.fillStyle = `rgba(0, 0, 0, ${0.07 + 0.012 * i})`;
      const radius = Math.max(8, 70 - i * 2.4);
      const x = inset;
      const y = inset;
      const w = size - 2 * inset;
      const h = size - 2 * inset;
      if (w <= 0 || h <= 0) break;
      ctx.beginPath();
      ctx.roundRect(x, y, w, h, radius);
      ctx.fill();
    }
  }
  return new CanvasTexture(canvas);
}

/** Width and depth of a cover board: leaves plus the overhang on three sides and a little over the hinge. */
export const BOARD_WIDTH = PAGE_W + BOARD_OVERHANG + 0.02;
export const BOARD_DEPTH = PAGE_H + 2 * BOARD_OVERHANG;
export const BOARD_HINGE_GAP = 0.02;

/**
 * Builds the book's assets, yielding between the heavy steps (each procedural texture is a per-pixel loop of
 * tens to hundreds of milliseconds) so a caller can spread them over several turns of the event loop.
 */
export function* buildBookAssets(
  tier: QualityTier,
  create: CreateCanvas,
  anisotropy: number,
  env: Texture | null = null,
): Generator<void, BookAssets> {
  const spec = QUALITY_TIERS[tier];
  const uniforms = createBookUniforms();
  const cover = createCoverTextures(spec.proceduralTextureSize, create, anisotropy, true);
  yield;
  const grain = createCoverTextures(256, create, 4, false);
  const leather = createLeatherMaterials(uniforms, cover, grain);
  // The gold tooling reflects the small local environment (a hint, so it reads as metal).
  leather.art.envMap = env;
  leather.art.envMapIntensity = 0.3;

  // A small sheet of parchment used wherever a face texture is not ready yet.
  const paperCanvas = create(256, 358);
  const paperCtx = paperCanvas.getContext('2d');
  if (paperCtx) drawParchment(paperCtx, 256, 358, create, { seed: 5 });
  const fallbackPaper = new CanvasTexture(paperCanvas);
  fallbackPaper.colorSpace = SRGBColorSpace;

  const endpaper = createEndpaperMaterial(fallbackPaper, uniforms);
  const slotCount = slotCountFor(spec.animatedLeaves, tier === 'high' ? 5 : tier === 'medium' ? 4 : 3);
  const slots = Array.from({ length: slotCount }, () => createLeafSlot(uniforms, fallbackPaper));

  yield;
  const spine = createSpineTextures(create, anisotropy, spec.proceduralTextureSize);
  yield;
  // The spine is the cover's leather at the cover's density (no tint, a low bump) and polished by hands: a soft
  // clear sheen, and the gilt lines (the data map's blue channel) are metal that reflects the little environment.
  const spineMaterial = new MeshPhysicalMaterial({
    map: spine.albedo,
    bumpMap: spine.data,
    bumpScale: 0.4,
    roughnessMap: spine.data,
    roughness: 0.72,
    metalnessMap: spine.data,
    metalness: 1,
    clearcoat: 0.3,
    clearcoatRoughness: 0.45,
    envMap: env,
    envMapIntensity: 0.3,
  });
  spineMaterial.onBeforeCompile = (shader) => {
    attachBookEffects(shader, uniforms);
  };
  spineMaterial.customProgramCacheKey = () => 'diary-spine-v2';

  const shadowTexture = softShadowTexture(create);
  const shadowOpacity = spec.shadowMapSize === null ? 0.7 : 0.42;
  const shadowMaterial = new MeshBasicMaterial({
    color: 0x000000,
    map: shadowTexture,
    transparent: true,
    opacity: shadowOpacity,
    depthWrite: false,
  });
  const shadowGeometry = new PlaneGeometry(1, 1).rotateX(-Math.PI / 2);

  const boardGeometry = new RoundedBoxGeometry(BOARD_WIDTH, BOARD_T, BOARD_DEPTH, 3, 0.012);
  const stackGeometry = new BoxGeometry(1, 1, 1, 24, 1, 1);
  const leafGeometryLtr = buildLeafGeometry('ltr', spec.leafSegments);
  const leafGeometryRtl = buildLeafGeometry('rtl', spec.leafSegments);
  const spineGeometry = createSpineGeometry();
  const stackPositive = createStackMaterials(uniforms, 1);
  const stackNegative = createStackMaterials(uniforms, -1);
  const binding = createBindingDetails();

  return {
    uniforms,
    cover,
    grain,
    spine,
    leather,
    endpaper,
    stackPositive,
    stackNegative,
    slots,
    leafGeometryLtr,
    leafGeometryRtl,
    stackGeometry,
    boardGeometry,
    spineGeometry,
    spineMaterial,
    fallbackPaper,
    shadowGeometry,
    shadowMaterial,
    shadowOpacity,
    slotCount,
    binding,
    dispose: () => {
      binding.dispose();
      shadowMaterial.map?.dispose();
      shadowMaterial.dispose();
      shadowGeometry.dispose();
      for (const textures of [cover, grain]) {
        textures.albedo.dispose();
        textures.data.dispose();
        textures.emissive.dispose();
      }
      spine.albedo.dispose();
      spine.data.dispose();
      leather.dispose();
      endpaper.dispose();
      spineMaterial.dispose();
      stackPositive.dispose();
      stackNegative.dispose();
      for (const slot of slots) disposeLeafSlot(slot);
      for (const geometry of [leafGeometryLtr, leafGeometryRtl, stackGeometry, boardGeometry, spineGeometry])
        geometry.dispose();
      fallbackPaper.dispose();
    },
  };
}

/** The same, all at once (tests, and anything that does not mind blocking). */
export function createBookAssets(
  tier: QualityTier,
  create: CreateCanvas,
  anisotropy: number,
  env: Texture | null = null,
): BookAssets {
  const build = buildBookAssets(tier, create, anisotropy, env);
  for (;;) {
    const step = build.next();
    if (step.done) return step.value;
  }
}
