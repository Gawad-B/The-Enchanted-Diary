import { useFrame } from '@react-three/fiber';
import { useEffect, useMemo, useRef } from 'react';
import {
  AdditiveBlending,
  CylinderGeometry,
  Color,
  MeshStandardMaterial,
  PlaneGeometry,
  ShaderMaterial,
  SphereGeometry,
  Vector2,
  Vector3,
  type Group,
  type Mesh,
  type Texture,
  type WebGLProgramParametersWithUniforms,
} from 'three';
import { dishGeometry, dripGeometry, waxGeometry } from './candleGeometry';
import type { CandleMotion } from './candleLayout';
import {
  FLAME_FRAGMENT,
  FLAME_VERTEX,
  HALO_FRAGMENT,
  HALO_VERTEX,
  WAX_FRAGMENT_EMISSIVE,
} from './candleShaders';
import { damp } from './easing';
import { flickerNoise } from './flicker';
import { pointerState } from './input';
import {
  CANDLE_HEIGHT,
  CANDLE_RADIUS,
  DISH_HEIGHT,
  FLAME_BASE_Y,
  FLAME_SIZE,
  WICK_TOP_Y,
} from './sceneConstants';
import { setUniform } from './uniforms';

/*
 * The candle: ivory wax with a melted pool and tapered drips running down its side, a brass dish, a wick, and the
 * flame. The flame is a shader billboard (see candleShaders.ts) leaning opposite to the pointer's velocity. The lights
 * that make the scene live in Lighting.tsx, at the flame's place (CandleMotion). The brass takes a small local
 * reflection (a studio environment made in memory, never downloaded), so it reads as metal and not as orange plastic.
 */

interface Drip {
  angle: number;
  length: number;
  width: number;
  /** How far below the rim the drip starts. */
  start: number;
}

const DRIPS: readonly Drip[] = [
  { angle: 0.5, length: 0.34, width: 0.034, start: 0.02 },
  { angle: 2.1, length: 0.16, width: 0.026, start: 0.03 },
  { angle: 3.6, length: 0.27, width: 0.03, start: 0.02 },
  { angle: 5.2, length: 0.11, width: 0.022, start: 0.035 },
];

interface CandleAssets {
  wax: MeshStandardMaterial;
  brass: MeshStandardMaterial;
  wick: MeshStandardMaterial;
  ember: MeshStandardMaterial;
  flameMaterial: ShaderMaterial;
  haloMaterial: ShaderMaterial;
  waxUniforms: { uWaxTopY: { value: number }; uWaxFlicker: { value: number } };
  geometries: {
    wax: ReturnType<typeof waxGeometry>;
    dish: ReturnType<typeof dishGeometry>;
    drip: ReturnType<typeof dripGeometry>;
    plane: PlaneGeometry;
    wick: CylinderGeometry;
    ember: SphereGeometry;
  };
}

/** Writes the flame's per-frame state: where the wax's glow starts, flicker, and the lean away from the pointer's motion. */
function tickCandle(
  assets: CandleAssets,
  motion: CandleMotion,
  lean: Vector3,
  t: number,
  delta: number,
): void {
  assets.waxUniforms.uWaxTopY.value = motion.base.y + DISH_HEIGHT + CANDLE_HEIGHT;
  // The flame leans opposite to the pointer's velocity, in the camera's right direction, and settles.
  lean.x = Math.max(-0.22, Math.min(0.22, damp(lean.x, -pointerState.vx * 0.05, 5, delta)));
  lean.z = damp(lean.z, pointerState.vy * 0.03, 5, delta);
  setUniform(assets.flameMaterial, 'uTime', t);
  const leanUniform = assets.flameMaterial.uniforms.uLean;
  if (leanUniform) (leanUniform.value as Vector3).copy(lean);
  setUniform(assets.flameMaterial, 'uIntensity', 1 + flickerNoise(t * 1.3) * 0.07);
  setUniform(assets.haloMaterial, 'uIntensity', 0.4 * (1 + flickerNoise(t) * 0.1));
  assets.waxUniforms.uWaxFlicker.value = 1 + flickerNoise(t) * 0.1;
}

function createAssets(env: Texture | null): CandleAssets {
  const waxUniforms = { uWaxTopY: { value: 0 }, uWaxFlicker: { value: 1 } };
  const wax = new MeshStandardMaterial({
    color: new Color('#efe3c8'),
    roughness: 0.6,
    metalness: 0,
    vertexColors: true,
  });
  wax.onBeforeCompile = (shader: WebGLProgramParametersWithUniforms) => {
    Object.assign(shader.uniforms, waxUniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying float vWaxY;')
      .replace(
        '#include <begin_vertex>',
        '#include <begin_vertex>\nvWaxY = (modelMatrix * vec4(transformed, 1.0)).y;',
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        '#include <common>\nuniform float uWaxTopY;\nuniform float uWaxFlicker;\nvarying float vWaxY;',
      )
      .replace('#include <emissivemap_fragment>', WAX_FRAGMENT_EMISSIVE);
  };
  wax.customProgramCacheKey = () => 'diary-candle-wax-v1';
  const brass = new MeshStandardMaterial({
    color: new Color('#a07a42'),
    roughness: 0.36,
    metalness: 0.9,
    envMap: env,
    envMapIntensity: 0.55,
  });
  const wick = new MeshStandardMaterial({ color: new Color('#1b130d'), roughness: 0.9 });
  const ember = new MeshStandardMaterial({
    color: new Color('#2a1608'),
    emissive: new Color('#ff7a1c'),
    emissiveIntensity: 1.4,
    roughness: 0.8,
  });
  const flameMaterial = new ShaderMaterial({
    vertexShader: FLAME_VERTEX,
    fragmentShader: FLAME_FRAGMENT,
    uniforms: {
      uTime: { value: 0 },
      uSize: { value: new Vector2(FLAME_SIZE.width, FLAME_SIZE.height) },
      uLean: { value: new Vector3() },
      uIntensity: { value: 1 },
    },
    transparent: true,
    depthWrite: false,
    blending: AdditiveBlending,
  });
  const haloMaterial = new ShaderMaterial({
    vertexShader: HALO_VERTEX,
    fragmentShader: HALO_FRAGMENT,
    uniforms: { uSize: { value: new Vector2(1.7, 1.7) }, uIntensity: { value: 0.4 } },
    transparent: true,
    depthWrite: false,
    blending: AdditiveBlending,
  });
  return {
    wax,
    brass,
    wick,
    ember,
    flameMaterial,
    haloMaterial,
    waxUniforms,
    geometries: {
      wax: waxGeometry(),
      dish: dishGeometry(),
      drip: dripGeometry(),
      plane: new PlaneGeometry(1, 1),
      wick: new CylinderGeometry(0.011, 0.015, WICK_TOP_Y - DISH_HEIGHT - CANDLE_HEIGHT * 0.95, 8),
      ember: new SphereGeometry(0.014, 8, 6),
    },
  };
}

export interface CandleProps {
  motion: CandleMotion;
  /** The small local environment that gives the brass its reflection (null: none). */
  env: Texture | null;
}

export function Candle({ motion, env }: CandleProps) {
  const group = useRef<Group>(null);
  const flame = useRef<Mesh>(null);
  const halo = useRef<Mesh>(null);
  const lean = useRef(new Vector3());
  const assets = useMemo(() => createAssets(env), [env]);

  useEffect(
    () => () => {
      for (const resource of [
        assets.wax,
        assets.brass,
        assets.wick,
        assets.ember,
        assets.flameMaterial,
        assets.haloMaterial,
        ...Object.values(assets.geometries),
      ]) {
        resource.dispose();
      }
    },
    [assets],
  );

  useFrame((state, delta) => {
    group.current?.position.set(motion.base.x, motion.base.y, motion.base.z);
    tickCandle(assets, motion, lean.current, state.clock.elapsedTime, delta);
    if (flame.current) flame.current.position.y = FLAME_BASE_Y;
    if (halo.current) halo.current.position.y = FLAME_BASE_Y + FLAME_SIZE.height * 0.4;
  });

  const rimY = DISH_HEIGHT + CANDLE_HEIGHT;
  const wickLength = WICK_TOP_Y - DISH_HEIGHT - CANDLE_HEIGHT * 0.95;
  return (
    <group ref={group} position={[motion.base.x, motion.base.y, motion.base.z]}>
      <mesh geometry={assets.geometries.dish} material={assets.brass} castShadow receiveShadow />
      <mesh
        geometry={assets.geometries.wax}
        material={assets.wax}
        position={[0, DISH_HEIGHT, 0]}
        castShadow
        receiveShadow
      />
      {DRIPS.map((drip) => (
        <mesh
          key={drip.angle}
          geometry={assets.geometries.drip}
          material={assets.wax}
          // A drip runs down the wall: flat against it (radial scale smaller than the tangent one), its top melting
          // into the rim. Its local z is the candle's outward direction at its angle.
          position={[
            Math.cos(drip.angle) * CANDLE_RADIUS * 0.985,
            rimY - drip.start - drip.length,
            Math.sin(drip.angle) * CANDLE_RADIUS * 0.985,
          ]}
          rotation={[0, Math.PI / 2 - drip.angle, 0]}
          scale={[drip.width, drip.length, drip.width * 0.55]}
          castShadow
        />
      ))}
      <mesh
        geometry={assets.geometries.wick}
        material={assets.wick}
        position={[0, DISH_HEIGHT + CANDLE_HEIGHT * 0.95 + wickLength / 2, 0]}
      />
      <mesh
        geometry={assets.geometries.ember}
        material={assets.ember}
        position={[0, WICK_TOP_Y - 0.004, 0]}
        scale={[1, 0.8, 1]}
      />
      <mesh ref={halo} geometry={assets.geometries.plane} material={assets.haloMaterial} renderOrder={5} />
      <mesh ref={flame} geometry={assets.geometries.plane} material={assets.flameMaterial} renderOrder={6} />
    </group>
  );
}
