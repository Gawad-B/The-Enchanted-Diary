import { useFrame } from '@react-three/fiber';
import { useEffect, useMemo, useRef } from 'react';
import { Color, Object3D, type PointLight, type SpotLight } from 'three';
import { flickerIntensity } from './flicker';
import { QUALITY_TIERS, type QualityTier } from './quality';
import type { CandleMotion } from './candleLayout';
import { CANDLE_COLOR } from './sceneConstants';

/*
 * Light, and almost nothing else: a very low warm ambient, the candle as the key light, and a dim cool-neutral
 * rim (desaturated, never neon). The candle is a point light (it lights its own surroundings, the table and the
 * book) plus, on the tiers that have shadows, one spot light at the same place that casts the book's shadows.
 * Both flicker together by a few percent from smoothed noise.
 */

/** Intensities in candela (three's physical units) for the distances of this scene. */
const POINT_INTENSITY = 7;
const SPOT_INTENSITY = 26;
const SPOT_INTENSITY_NO_SHADOW = 0;

export interface LightingProps {
  tier: QualityTier;
  /** Where the candle (and so the key light) is. */
  motion: CandleMotion;
  /** Where the spot light points: the middle of the book. */
  aim?: readonly [number, number, number];
}

export function Lighting({ tier, motion, aim = [0.1, 0.1, 0.1] }: LightingProps) {
  const spec = QUALITY_TIERS[tier];
  const point = useRef<PointLight>(null);
  const spot = useRef<SpotLight>(null);
  const target = useMemo(() => new Object3D(), []);
  const candleColor = useMemo(() => new Color(CANDLE_COLOR), []);
  const shadows = spec.shadowMapSize !== null;

  useEffect(() => {
    target.position.set(aim[0], aim[1], aim[2]);
    target.updateMatrixWorld();
    if (spot.current) spot.current.target = target;
  }, [aim, target]);

  useFrame((state) => {
    const t = state.clock.elapsedTime;
    const flame = motion.flame;
    if (point.current) {
      point.current.position.set(flame.x, flame.y, flame.z);
      point.current.intensity = flickerIntensity(shadows ? POINT_INTENSITY : POINT_INTENSITY + 12, t);
    }
    if (spot.current) {
      spot.current.position.set(flame.x, flame.y, flame.z);
      spot.current.intensity = flickerIntensity(shadows ? SPOT_INTENSITY : SPOT_INTENSITY_NO_SHADOW, t);
    }
  });

  const position: [number, number, number] = [motion.flame.x, motion.flame.y, motion.flame.z];
  return (
    <>
      <hemisphereLight args={['#4a3524', '#2f1d10', 1.2]} />
      <pointLight
        ref={point}
        color={candleColor}
        position={position}
        intensity={POINT_INTENSITY}
        distance={0}
        decay={2}
      />
      <primitive object={target} />
      {shadows && (
        <spotLight
          ref={spot}
          color={candleColor}
          position={position}
          intensity={SPOT_INTENSITY}
          angle={0.62}
          penumbra={1}
          decay={2}
          castShadow
          shadow-mapSize-width={spec.shadowMapSize ?? 1024}
          shadow-mapSize-height={spec.shadowMapSize ?? 1024}
          shadow-bias={-0.00035}
          shadow-normalBias={0.012}
          shadow-radius={5}
          shadow-camera-near={0.6}
          shadow-camera-far={7}
        />
      )}
      {/* The room behind the camera bounces a little warm light back: it keeps the near edges of the book readable. */}
      <directionalLight color="#7a5535" position={[1.2, 1.6, 6]} intensity={0.2} />
      {/* A dim cool-neutral rim from behind and to the right: it outlines the book's edge, nothing more. */}
      <directionalLight color="#9ba3b0" position={[4.5, 5.5, -5]} intensity={0.34} />
    </>
  );
}
