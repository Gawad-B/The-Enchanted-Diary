import { useEffect, useMemo } from 'react';
import { Color, MeshStandardMaterial, PlaneGeometry, RepeatWrapping } from 'three';
import type { SurfaceTextures } from './textures/woodTexture';

/*
 * The room is nearly black: depth comes from exponential fog, from the fall-off of the candle, and from a
 * dark panelled wall far behind the table that only the candle's glow barely reaches. Subtlety over clutter.
 */

const BACKGROUND = '#050403';
const FOG_DENSITY = 0.04;

export function Room({ wood }: { wood: SurfaceTextures }) {
  const { geometry, material } = useMemo(() => {
    const texture = wood.albedo.clone();
    texture.wrapS = RepeatWrapping;
    texture.wrapT = RepeatWrapping;
    texture.repeat.set(7, 1.4);
    texture.needsUpdate = true;
    const material = new MeshStandardMaterial({ map: texture, color: new Color('#3a2a20'), roughness: 1 });
    return { geometry: new PlaneGeometry(40, 12), material };
  }, [wood]);

  useEffect(
    () => () => {
      material.map?.dispose();
      material.dispose();
      geometry.dispose();
    },
    [geometry, material],
  );

  return (
    <>
      <color attach="background" args={[BACKGROUND]} />
      <fogExp2 attach="fog" args={[BACKGROUND, FOG_DENSITY]} />
      {/* The wall stands close enough behind the table for the candle to light it: a warm pool that falls away. */}
      <mesh geometry={geometry} material={material} position={[0, 5, -4.7]} />
    </>
  );
}
