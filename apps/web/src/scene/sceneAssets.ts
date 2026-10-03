import type { SurfaceTextures } from './textures/woodTexture';
import { createWoodTextures } from './textures/woodTexture';
import { QUALITY_TIERS, type QualityTier } from './quality';
import { buildBookAssets, type BookAssets, type CreateCanvas } from './book/bookAssets';
import type { StudioEnvironment } from './studioEnvironment';

/**
 * The procedural textures and book resources of one scene mount. Created once (the tier is fixed for the
 * session) and disposed with the scene: textures are disposed on unmount, and nothing is created in a frame.
 */
export interface SceneAssets {
  tier: QualityTier;
  wood: SurfaceTextures;
  book: BookAssets;
  /** The small local reflection environment for metals (null where it could not be made, and in tests). */
  env: StudioEnvironment | null;
  dispose(): void;
}

export function domCanvas(width: number, height: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

/** Builds the scene's assets, yielding between the heavy steps (see lib/buildScheduler.ts). */
export function* buildSceneAssets(
  tier: QualityTier,
  anisotropy: number,
  create: CreateCanvas = domCanvas,
  env: StudioEnvironment | null = null,
): Generator<void, SceneAssets> {
  const size = QUALITY_TIERS[tier].proceduralTextureSize;
  const wood = createWoodTextures(size, create, anisotropy);
  yield;
  const book = yield* buildBookAssets(tier, create, anisotropy, env?.texture ?? null);
  return {
    tier,
    wood,
    book,
    env,
    dispose: () => {
      wood.albedo.dispose();
      wood.data.dispose();
      book.dispose();
      env?.dispose();
    },
  };
}

/** The same, all at once. */
export function createSceneAssets(
  tier: QualityTier,
  anisotropy: number,
  create: CreateCanvas = domCanvas,
  env: StudioEnvironment | null = null,
): SceneAssets {
  const build = buildSceneAssets(tier, anisotropy, create, env);
  for (;;) {
    const step = build.next();
    if (step.done) return step.value;
  }
}
