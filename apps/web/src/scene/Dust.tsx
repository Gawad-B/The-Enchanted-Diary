import { useFrame } from '@react-three/fiber';
import { useEffect, useMemo } from 'react';
import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  Color,
  ShaderMaterial,
  Vector3,
  type PerspectiveCamera,
} from 'three';
import { DUST_FRAGMENT, DUST_VERTEX } from './particleShaders';
import { mulberry32 } from '../book/paperTexture';
import type { CandleMotion } from './candleLayout';
import { CANDLE_COLOR } from './sceneConstants';
import { setUniform } from './uniforms';

/*
 * Dust in the candlelight: a single Points object whose motion lives entirely in the vertex shader. Each
 * particle drifts slowly in all three axes and is only visible where the candle lights it, so most of
 * the room stays dark. The count comes from the quality tier (and shrinks under reduced motion).
 */

const VOLUME = { x: 6, yMin: 0.15, yMax: 5, zMin: -5, zMax: 4 } as const;

/** Writes the per-frame uniforms of the dust (module level: the frame loop mutates no render-scope values). */
function tickDust(
  material: ShaderMaterial,
  time: number,
  reducedMotion: boolean,
  pixelHeight: number,
  fovDegrees: number,
): void {
  setUniform(material, 'uTime', time);
  setUniform(material, 'uSlow', reducedMotion ? 0.25 : 1);
  setUniform(material, 'uPixelScale', pixelHeight / (2 * Math.tan((fovDegrees * Math.PI) / 360)));
}

export interface DustProps {
  count: number;
  reducedMotion: boolean;
  /** The candle the dust is lit by. */
  motion: CandleMotion;
}

export function Dust({ count, reducedMotion, motion }: DustProps) {
  const { geometry, material } = useMemo(() => {
    const rng = mulberry32(99);
    const positions = new Float32Array(count * 3);
    const seeds = new Float32Array(count);
    const sizes = new Float32Array(count);
    for (let i = 0; i < count; i += 1) {
      positions[i * 3] = (rng() * 2 - 1) * VOLUME.x;
      positions[i * 3 + 1] = VOLUME.yMin + rng() * (VOLUME.yMax - VOLUME.yMin);
      positions[i * 3 + 2] = VOLUME.zMin + rng() * (VOLUME.zMax - VOLUME.zMin);
      seeds[i] = rng();
      sizes[i] = 0.01 + Math.pow(rng(), 3) * 0.03;
    }
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new BufferAttribute(positions, 3));
    geometry.setAttribute('aSeed', new BufferAttribute(seeds, 1));
    geometry.setAttribute('aSize', new BufferAttribute(sizes, 1));
    const material = new ShaderMaterial({
      vertexShader: DUST_VERTEX,
      fragmentShader: DUST_FRAGMENT,
      uniforms: {
        uTime: { value: 0 },
        uPixelScale: { value: 1000 },
        uCandle: { value: new Vector3(motion.flame.x, motion.flame.y, motion.flame.z) },
        uColor: { value: new Color(CANDLE_COLOR).multiplyScalar(0.9) },
        uOpacity: { value: 0.9 },
        uSlow: { value: 1 },
      },
      transparent: true,
      depthWrite: false,
      blending: AdditiveBlending,
    });
    return { geometry, material };
  }, [count, motion]);

  useEffect(
    () => () => {
      geometry.dispose();
      material.dispose();
    },
    [geometry, material],
  );

  useFrame((state) => {
    (material.uniforms.uCandle?.value as Vector3 | undefined)?.set(
      motion.flame.x,
      motion.flame.y,
      motion.flame.z,
    );
    tickDust(
      material,
      state.clock.elapsedTime,
      reducedMotion,
      state.size.height * state.viewport.dpr,
      (state.camera as PerspectiveCamera).fov,
    );
  });

  if (count <= 0) return null;
  return <points geometry={geometry} material={material} frustumCulled={false} renderOrder={3} />;
}
