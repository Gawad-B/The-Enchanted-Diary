import { useFrame } from '@react-three/fiber';
import { useEffect, useMemo } from 'react';
import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  Color,
  ShaderMaterial,
  type PerspectiveCamera,
} from 'three';
import { mulberry32 } from '../book/paperTexture';
import { pageEffectsStore } from '../state/pageEffectsStore';
import { MOTE_FRAGMENT, MOTE_VERTEX } from './particleShaders';
import { MOTE_SIZE, visibleFraction } from './motes';
import { setUniform } from './uniforms';

/*
 * A few fine warm sparks that lift off the edges of the page block and fade within a hand's breadth: about two at
 * rest and up to twenty with `pageEffectsStore.edgeGlow` (on hover, while the diary reads, during the reveal). Few,
 * tiny and quiet: restraint is the point.
 */

function tickMotes(
  material: ShaderMaterial,
  time: number,
  delta: number,
  reducedMotion: boolean,
  pixelHeight: number,
  fovDegrees: number,
  count: number,
  open: number,
): void {
  setUniform(material, 'uTime', time);
  setUniform(material, 'uSlow', reducedMotion ? 0.25 : 1);
  setUniform(material, 'uPixelScale', pixelHeight / (2 * Math.tan((fovDegrees * Math.PI) / 360)));
  const target = pageEffectsStore.getState().values.edgeGlow;
  const current = (material.uniforms.uGlow?.value as number | undefined) ?? 0;
  const glow = current + (target - current) * (1 - Math.exp(-3 * delta));
  setUniform(material, 'uGlow', glow);
  setUniform(material, 'uVisible', visibleFraction(count, glow));
  setUniform(material, 'uOpen', open);
}

export interface MagicMotesProps {
  count: number;
  reducedMotion: boolean;
  /** The cover's openness (0 closed .. 1 open), so the sparks follow the page block's edges as it widens. */
  cover: { readonly value: number };
}

export function MagicMotes({ count, reducedMotion, cover }: MagicMotesProps) {
  const { geometry, material } = useMemo(() => {
    const rng = mulberry32(7);
    const positions = new Float32Array(count * 3);
    const seeds = new Float32Array(count);
    const sizes = new Float32Array(count);
    for (let i = 0; i < count; i += 1) {
      // x: where along the perimeter of the book, y: its phase in its life (see MOTE_VERTEX).
      positions[i * 3] = rng();
      positions[i * 3 + 1] = rng();
      positions[i * 3 + 2] = 0;
      seeds[i] = rng();
      sizes[i] = MOTE_SIZE.min + rng() * (MOTE_SIZE.max - MOTE_SIZE.min);
    }
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new BufferAttribute(positions, 3));
    geometry.setAttribute('aSeed', new BufferAttribute(seeds, 1));
    geometry.setAttribute('aSize', new BufferAttribute(sizes, 1));
    const material = new ShaderMaterial({
      vertexShader: MOTE_VERTEX,
      fragmentShader: MOTE_FRAGMENT,
      uniforms: {
        uTime: { value: 0 },
        uPixelScale: { value: 1000 },
        uGlow: { value: 0 },
        uSlow: { value: 1 },
        uVisible: { value: 0 },
        uOpen: { value: 0 },
        uColor: { value: new Color('#ffc477') },
      },
      transparent: true,
      depthWrite: false,
      blending: AdditiveBlending,
      toneMapped: true,
    });
    return { geometry, material };
  }, [count]);

  useEffect(
    () => () => {
      geometry.dispose();
      material.dispose();
    },
    [geometry, material],
  );

  useFrame((state, delta) => {
    tickMotes(
      material,
      state.clock.elapsedTime,
      delta,
      reducedMotion,
      state.size.height * state.viewport.dpr,
      (state.camera as PerspectiveCamera).fov,
      count,
      cover.value,
    );
  });

  if (count <= 0) return null;
  return <points geometry={geometry} material={material} frustumCulled={false} renderOrder={4} />;
}
