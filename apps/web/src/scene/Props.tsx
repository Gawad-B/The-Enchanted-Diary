import { useFrame } from '@react-three/fiber';
import { useEffect, useMemo, useRef } from 'react';
import {
  Color,
  DoubleSide,
  LatheGeometry,
  MeshStandardMaterial,
  Vector2,
  type Group,
  type Texture,
} from 'three';
import type { CandleMotion } from './candleLayout';
import { quillShaftGeometry, quillVaneGeometry } from './quillGeometry';

/*
 * An inkwell with its quill, on the side of the book opposite the candle: a dark glass well with a brass collar and a
 * goose quill leaning in it, away from the light. That is all the table holds besides the candle: restraint over clutter
 * (a stack of closed books was tried and dropped; it was worse than nothing). The pair follows the layout (CandleMotion
 * places it, and it leaves the stage when the camera goes in over the pages).
 */

/** The well: a squat glass body with a rounded shoulder and a neck. */
function wellGeometry(): LatheGeometry {
  return new LatheGeometry(
    [
      new Vector2(0, 0),
      new Vector2(0.17, 0),
      new Vector2(0.188, 0.025),
      new Vector2(0.185, 0.12),
      new Vector2(0.158, 0.2),
      new Vector2(0.096, 0.245),
      new Vector2(0.082, 0.28),
      new Vector2(0.084, 0.292),
      new Vector2(0.066, 0.292),
      new Vector2(0, 0.25),
    ],
    32,
  );
}

/** A brass collar round the neck. */
function collarGeometry(): LatheGeometry {
  return new LatheGeometry(
    [
      new Vector2(0.078, 0.255),
      new Vector2(0.098, 0.262),
      new Vector2(0.104, 0.278),
      new Vector2(0.1, 0.298),
      new Vector2(0.086, 0.302),
      new Vector2(0.072, 0.296),
      new Vector2(0.078, 0.255),
    ],
    32,
  );
}

export interface PropsProps {
  motion: CandleMotion;
  /** The small local environment that gives the glass and the brass their reflection (null: none). */
  env: Texture | null;
}

export function Props({ motion, env }: PropsProps) {
  const group = useRef<Group>(null);
  const assets = useMemo(() => {
    const shaft = quillShaftGeometry();
    const vane = quillVaneGeometry();
    return {
      well: wellGeometry(),
      collar: collarGeometry(),
      shaft: shaft.geometry,
      vane: vane.geometry,
      barbs: vane.texture,
      glass: new MeshStandardMaterial({
        color: new Color('#0c0b0e'),
        roughness: 0.16,
        metalness: 0.2,
        envMap: env,
        envMapIntensity: 0.55,
      }),
      brass: new MeshStandardMaterial({
        color: new Color('#a07a42'),
        roughness: 0.34,
        metalness: 0.9,
        envMap: env,
        envMapIntensity: 0.55,
      }),
      calamus: new MeshStandardMaterial({ color: new Color('#d8cba8'), roughness: 0.45 }),
      feather: new MeshStandardMaterial({
        map: vane.texture,
        alphaTest: 0.32,
        side: DoubleSide,
        roughness: 0.9,
        color: new Color('#ffffff'),
      }),
    };
  }, [env]);

  useEffect(
    () => () => {
      assets.well.dispose();
      assets.collar.dispose();
      assets.shaft.dispose();
      assets.vane.dispose();
      assets.barbs.dispose();
      for (const material of [assets.glass, assets.brass, assets.calamus, assets.feather]) material.dispose();
    },
    [assets],
  );

  useFrame(() => {
    const target = group.current;
    if (!target) return;
    target.position.set(motion.ink.x, motion.ink.y, motion.ink.z);
    // The quill leans away from the candle, which is on the other side of the book, so it turns with the layout. The
    // layout the props are laid out for changes only while they are out of the picture, so it simply follows it.
    target.rotation.y = motion.shown === 'ltr' ? 0 : Math.PI;
  });

  return (
    <group ref={group} position={[motion.ink.x, motion.ink.y, motion.ink.z]}>
      <mesh geometry={assets.well} material={assets.glass} />
      <mesh geometry={assets.collar} material={assets.brass} />
      <mesh geometry={assets.shaft} material={assets.calamus} />
      <mesh geometry={assets.vane} material={assets.feather} />
    </group>
  );
}
