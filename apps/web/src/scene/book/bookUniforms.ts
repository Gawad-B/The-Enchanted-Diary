import { Color, type IUniform } from 'three';
import type { EffectValues } from '../../state/pageEffectsStore';

/**
 * Uniform values shared by every material of the book. They are plain objects that the materials' shaders
 * reference (`shader.uniforms.uOpen = shared.uOpen`), so writing `.value` once per frame updates all of them,
 * and no React render is involved.
 */
export interface BookUniforms {
  /** Cover openness 0 (closed) .. 1 (open): pages sink into the gutter only when it is open. */
  uOpen: IUniform<number>;
  /** +1 for LTR layout, -1 for RTL: the side unturned leaves extend to. */
  uSide: IUniform<number>;
  /** 0..1: how much of the page's colour is its unlit albedo ("reading light", global section G). */
  uReading: IUniform<number>;
  uReadingTint: IUniform<Color>;
  uTime: IUniform<number>;
  // pageEffectsStore values
  uInkSpread: IUniform<number>;
  uGlow: IUniform<number>;
  uTremble: IUniform<number>;
  uEdgeGlow: IUniform<number>;
  uMemoryPull: IUniform<number>;
  /** The most prominent leaf in the air: its angle (0 unturned .. 1 turned) and how much of a shadow it throws (0..1). */
  uTurnAng: IUniform<number>;
  uTurnAmount: IUniform<number>;
}

export function createBookUniforms(): BookUniforms {
  return {
    uOpen: { value: 0 },
    uSide: { value: 1 },
    uReading: { value: 0 },
    uReadingTint: { value: new Color(0.9, 0.84, 0.72) },
    uTime: { value: 0 },
    uInkSpread: { value: 0 },
    uGlow: { value: 0 },
    uTremble: { value: 0 },
    uEdgeGlow: { value: 0 },
    uMemoryPull: { value: 0 },
    uTurnAng: { value: 0 },
    uTurnAmount: { value: 0 },
  };
}

/** Copies the combined page effects into the shared uniforms (called once per frame). */
export function writeEffectUniforms(uniforms: BookUniforms, values: Readonly<EffectValues>): void {
  uniforms.uInkSpread.value = values.inkSpread;
  uniforms.uGlow.value = values.glow;
  uniforms.uTremble.value = values.tremble;
  uniforms.uEdgeGlow.value = values.edgeGlow;
  uniforms.uMemoryPull.value = values.memoryPull;
}
