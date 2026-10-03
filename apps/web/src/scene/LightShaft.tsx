import { useFrame } from '@react-three/fiber';
import { useEffect, useMemo, useRef } from 'react';
import { AdditiveBlending, ConeGeometry, DoubleSide, Quaternion, ShaderMaterial, Vector3 } from 'three';
import type { Mesh } from 'three';
import type { CandleMotion } from './candleLayout';
import { SHAFT_FRAGMENT, SHAFT_VERTEX } from './particleShaders';
import { setUniform } from './uniforms';

/*
 * One cheap light shaft: a soft additive cone from the flame toward a point above the book, brightest where it
 * faces the eye and shimmering slowly. It is a hint of haze, not a volumetric render. It fades to nothing at the flame, at
 * its far end and toward the table (see SHAFT_FRAGMENT), so it never ends in a hard edge or cuts into anything.
 */

const DOWN = new Vector3(0, -1, 0);
const SHAFT_OPACITY = 0.3;
/** Half-width of the shaft over its length: how far it opens toward the book. */
const SPREAD = 0.46;

export interface LightShaftProps {
  motion: CandleMotion;
  /** The point above the book the shaft is aimed at. */
  aim?: readonly [number, number, number];
}

export function LightShaft({ motion, aim = [0.1, 0.3, 0.15] }: LightShaftProps) {
  const mesh = useRef<Mesh>(null);
  const scratch = useMemo(
    () => ({ start: new Vector3(), direction: new Vector3(), q: new Quaternion() }),
    [],
  );
  const { geometry, material } = useMemo(() => {
    // A unit cone: apex up, height 1, base radius 1, open ended.
    const geometry = new ConeGeometry(1, 1, 32, 1, true);
    const material = new ShaderMaterial({
      vertexShader: SHAFT_VERTEX,
      fragmentShader: SHAFT_FRAGMENT,
      uniforms: { uTime: { value: 0 }, uOpacity: { value: SHAFT_OPACITY } },
      transparent: true,
      depthWrite: false,
      blending: AdditiveBlending,
      side: DoubleSide,
    });
    return { geometry, material };
  }, []);

  useEffect(
    () => () => {
      geometry.dispose();
      material.dispose();
    },
    [geometry, material],
  );

  useFrame((state) => {
    setUniform(material, 'uTime', state.clock.elapsedTime);
    // When the candle has left the picture (the reading framings) the haze it makes goes with it.
    setUniform(material, 'uOpacity', SHAFT_OPACITY * (1 - motion.reading));
    const target = mesh.current;
    if (!target) return;
    const { start, direction, q } = scratch;
    start.set(motion.flame.x, motion.flame.y, motion.flame.z);
    direction.set(aim[0], aim[1], aim[2]).sub(start);
    const length = direction.length();
    direction.divideScalar(length);
    // The apex points at the flame and the base at the book.
    q.setFromUnitVectors(DOWN, direction);
    target.quaternion.copy(q);
    target.position.copy(start).addScaledVector(direction, length / 2);
    target.scale.set(length * SPREAD, length, length * SPREAD);
  });

  return <mesh ref={mesh} geometry={geometry} material={material} frustumCulled={false} renderOrder={2} />;
}
