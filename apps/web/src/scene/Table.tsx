import { useEffect, useMemo } from 'react';
import {
  Color,
  MeshStandardMaterial,
  MirroredRepeatWrapping,
  RepeatWrapping,
  type WebGLProgramParametersWithUniforms,
} from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { TABLE_SIZE } from './sceneConstants';
import { WOOD_TILE_UNITS, type SurfaceTextures } from './textures/woodTexture';

/*
 * The old wooden table. The wood is two procedural textures (albedo, and one packed map whose R channel is the
 * bump and G the roughness) repeated over the top; planks run along x. The bump is only pores and scratches: the grain
 * is colour. Around the middle (where the book lies) the wax has polished the top to a softer sheen, and the edge of
 * the top is worn: rubbed lighter and smoother within a few millimetres of the rim.
 */

const WEAR_VERTEX = `
varying vec3 vTablePos;
`;

const WEAR_FRAGMENT = `
varying vec3 vTablePos;
uniform vec3 uTableHalf;
`;

function patchWear(shader: WebGLProgramParametersWithUniforms): void {
  shader.uniforms.uTableHalf = {
    value: [TABLE_SIZE.width / 2, TABLE_SIZE.thickness / 2, TABLE_SIZE.depth / 2],
  };
  shader.vertexShader = shader.vertexShader
    .replace('#include <common>', `#include <common>\n${WEAR_VERTEX}`)
    .replace('#include <begin_vertex>', '#include <begin_vertex>\nvTablePos = position;');
  shader.fragmentShader = shader.fragmentShader
    .replace('#include <common>', `#include <common>\n${WEAR_FRAGMENT}`)
    .replace(
      '#include <roughnessmap_fragment>',
      `#include <roughnessmap_fragment>
      {
        // A table that has been waxed and leaned on: a broad soft sheen around the middle, where the book lies.
        float pool = 1.0 - smoothstep(0.5, 3.4, length(vTablePos.xz));
        roughnessFactor = mix(roughnessFactor, roughnessFactor * 0.6, pool);
      }`,
    )
    .replace(
      '#include <map_fragment>',
      `#include <map_fragment>
      {
        // Distance to the rim of the top face, in units: worn, lighter, smoother wood close to it.
        float rim = min(uTableHalf.x - abs(vTablePos.x), uTableHalf.z - abs(vTablePos.z));
        float onTop = smoothstep(uTableHalf.y - 0.06, uTableHalf.y - 0.01, vTablePos.y);
        float wear = (1.0 - smoothstep(0.0, 0.16, rim)) * 0.75 + (1.0 - smoothstep(0.0, 0.05, rim)) * 0.5;
        diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * vec3(1.6, 1.42, 1.2), clamp(wear, 0.0, 1.0) * onTop);
      }`,
    );
}

export function Table({ wood }: { wood: SurfaceTextures }) {
  const { geometry, material } = useMemo(() => {
    const repeatX = TABLE_SIZE.width / WOOD_TILE_UNITS.x;
    const repeatZ = TABLE_SIZE.depth / WOOD_TILE_UNITS.z;
    for (const texture of [wood.albedo, wood.data]) {
      texture.wrapS = RepeatWrapping;
      texture.wrapT = MirroredRepeatWrapping;
      texture.repeat.set(repeatX, repeatZ);
    }
    const material = new MeshStandardMaterial({
      map: wood.albedo,
      roughnessMap: wood.data,
      roughness: 1,
      bumpMap: wood.data,
      bumpScale: 0.32,
      color: new Color('#ffffff'),
    });
    material.onBeforeCompile = patchWear;
    material.customProgramCacheKey = () => 'diary-table-v2';
    const geometry = new RoundedBoxGeometry(
      TABLE_SIZE.width,
      TABLE_SIZE.thickness,
      TABLE_SIZE.depth,
      4,
      0.05,
    );
    return { geometry, material };
  }, [wood]);

  useEffect(
    () => () => {
      geometry.dispose();
      material.dispose();
    },
    [geometry, material],
  );

  // The top face is at y = 0 so the book can rest on it.
  return (
    <mesh
      geometry={geometry}
      material={material}
      position={[0, -TABLE_SIZE.thickness / 2, 0]}
      receiveShadow
      castShadow={false}
    />
  );
}
