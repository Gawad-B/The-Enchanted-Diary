import {
  DoubleSide,
  MeshDepthMaterial,
  MeshDistanceMaterial,
  MeshPhysicalMaterial,
  RGBADepthPacking,
  Vector4,
  type IUniform,
  type Texture,
  type WebGLProgramParametersWithUniforms,
} from 'three';
import type { BookUniforms } from './bookUniforms';
import {
  BOOK_DEFINES,
  GUTTER_GLSL,
  LEAF_BEND_GLSL,
  LEAF_VERTEX_NORMAL,
  LEAF_VERTEX_POSITION,
  NOISE_GLSL,
  PAGE_OCCLUSION_GLSL,
} from './shaderChunks';

/*
 * The material of one leaf slot. Slots are created once (their number is fixed by the quality tier) and a
 * leaf takes over a slot by writing the slot's uniforms: no material, geometry or texture is created while
 * the book animates. All slots compile to the same program (`customProgramCacheKey`); each owns its
 * uniform values (angle, bend, front and back texture). The visible material, the depth material and the
 * distance material of a slot share the same uniform objects, so a bent leaf casts the shadow of a bent leaf.
 */

export interface LeafSlotUniforms {
  uTheta: IUniform<number>;
  uBend: IUniform<number>;
  uTurnV: IUniform<number>;
  /** 1 when the leaf lies still on a stack (it sags into the gutter), fading to 0 as it lifts. */
  uRest: IUniform<number>;
  /** How far the leaf's surface is above the valley at the spine (it sinks that far into the gutter). */
  uDrop: IUniform<number>;
  /** How far a thin stack's pages bow up out of the gutter (scene units); 0 for a thick stack. */
  uArch: IUniform<number>;
  /** x offset, z offset, y offset and a brightness tint: each leaf is a little different. */
  uJitter: IUniform<Vector4>;
  uFrontMap: IUniform<Texture | null>;
  uBackMap: IUniform<Texture | null>;
}

export interface LeafSlot {
  uniforms: LeafSlotUniforms;
  material: MeshPhysicalMaterial;
  depthMaterial: MeshDepthMaterial;
  distanceMaterial: MeshDistanceMaterial;
}

const FRAGMENT_PARS = `
${BOOK_DEFINES}
${NOISE_GLSL}
${PAGE_OCCLUSION_GLSL}
uniform sampler2D uFrontMap;
uniform sampler2D uBackMap;
uniform float uReading;
uniform vec3 uReadingTint;
uniform float uOpen;
uniform float uTheta;
uniform float uRest;
uniform float uDrop;
uniform float uArch;
uniform vec4 uJitter;
uniform float uGlow;
uniform float uInkSpread;
uniform float uMemoryPull;
uniform float uTime;
varying vec2 vLeafUv;
varying float vLeafS;
`;

const MAP_FRAGMENT = `
vec2 leafUv = vLeafUv;
// The front face reads u as built; the back face reads u' = 1 - u (global section G): no texture is ever mirrored.
vec4 leafTexel = gl_FrontFacing ? texture2D(uFrontMap, leafUv) : texture2D(uBackMap, vec2(1.0 - leafUv.x, leafUv.y));
diffuseColor *= leafTexel;
diffuseColor.rgb *= uJitter.w;
// Slightly darker, handled edges.
float edgeDistance = min(min(leafUv.x, 1.0 - leafUv.x), min(leafUv.y, 1.0 - leafUv.y));
diffuseColor.rgb *= 0.9 + 0.1 * smoothstep(0.0, 0.02, edgeDistance);
`;

const OPAQUE_FRAGMENT = `
// Reading light: in the reading framings most of the page is its unlit colour, so text stays legible whatever the
// candle does (global section G: at least 70%). A faint shading by the page's slope keeps it from looking printed flat.
{
  vec3 keyView = normalize((viewMatrix * vec4(-0.45, 0.8, -0.4, 0.0)).xyz);
  float pageShade = 0.87 + 0.2 * clamp(dot(normal, keyView), 0.0, 1.0);
  outgoingLight = mix(outgoingLight, diffuseColor.rgb * uReadingTint * pageShade, uReading);
}
// Paper is never brighter than paper: no white hotspot, whatever the light does close to the flame.
outgoingLight = min(outgoingLight, diffuseColor.rgb * 1.1);
// Occlusion toward the gutter and the shadow of the turning leaf come last, so they survive the reading light.
outgoingLight *= pageOcclusion(vLeafS, uTheta < 0.5 ? 0.0 : 1.0, uRest, uOpen);
{
  vec2 q = (leafUv - 0.5) * vec2(1.0, 1.4);
  float radius = length(q);
  // Ink spreading through the paper from the middle outward, in blotchy rings.
  float reach = uInkSpread * 1.15;
  float blotch = bookNoise(leafUv * 9.0 + 3.0) * 0.5 + bookNoise(leafUv * 23.0) * 0.25;
  float ink = (1.0 - smoothstep(reach - 0.22, reach, radius + (blotch - 0.4) * 0.34)) * step(0.001, uInkSpread);
  outgoingLight = mix(outgoingLight, outgoingLight * vec3(0.5, 0.36, 0.28), ink * 0.55);
  // Light from within: warm, brightest where the ink spread.
  float within = 1.0 - smoothstep(0.0, 0.72, radius);
  outgoingLight += uGlow * vec3(1.0, 0.7, 0.32) * (0.18 + 0.82 * within) * 0.6;
  // A memory: the colour drains to warm sepia.
  float luma = dot(outgoingLight, vec3(0.299, 0.587, 0.114));
  outgoingLight = mix(outgoingLight, vec3(luma) * vec3(1.18, 0.96, 0.7), uMemoryPull * 0.75);
}
#include <opaque_fragment>
`;

type Shader = WebGLProgramParametersWithUniforms;

function attach(shader: Shader, shared: BookUniforms, slot: LeafSlotUniforms): void {
  Object.assign(shader.uniforms, shared, slot);
}

const VERTEX_COMMON = `
#include <common>
${BOOK_DEFINES}
${GUTTER_GLSL}
${LEAF_BEND_GLSL}
`;

function patchMain(shader: Shader, shared: BookUniforms, slot: LeafSlotUniforms): void {
  attach(shader, shared, slot);
  shader.vertexShader = shader.vertexShader
    .replace('#include <common>', `${VERTEX_COMMON}\nvarying vec2 vLeafUv;\nvarying float vLeafS;\n`)
    .replace('#include <beginnormal_vertex>', LEAF_VERTEX_NORMAL)
    .replace('#include <begin_vertex>', `${LEAF_VERTEX_POSITION}\nvLeafUv = uv;\nvLeafS = position.x;`);
  shader.fragmentShader = shader.fragmentShader
    .replace('#include <common>', `#include <common>\n${FRAGMENT_PARS}`)
    .replace('#include <map_fragment>', MAP_FRAGMENT)
    .replace('#include <opaque_fragment>', OPAQUE_FRAGMENT);
}

function patchDepth(shader: Shader, shared: BookUniforms, slot: LeafSlotUniforms): void {
  attach(shader, shared, slot);
  shader.vertexShader = shader.vertexShader
    .replace('#include <common>', VERTEX_COMMON)
    .replace('#include <begin_vertex>', LEAF_VERTEX_POSITION);
}

export function createLeafSlot(shared: BookUniforms, fallback: Texture): LeafSlot {
  const uniforms: LeafSlotUniforms = {
    uTheta: { value: 0 },
    uBend: { value: 0.55 },
    uTurnV: { value: 0 },
    uRest: { value: 1 },
    uDrop: { value: 0 },
    uArch: { value: 0 },
    uJitter: { value: new Vector4(0, 0, 0, 1) },
    uFrontMap: { value: fallback },
    uBackMap: { value: fallback },
  };

  // Paper is matte: a physical material only so its specular can be capped (the standard one has a fixed 4%).
  const material = new MeshPhysicalMaterial({
    color: 0xffffff,
    roughness: 0.92,
    metalness: 0,
    specularIntensity: 0.2,
    side: DoubleSide,
  });
  material.onBeforeCompile = (shader) => {
    patchMain(shader, shared, uniforms);
  };
  material.customProgramCacheKey = () => 'diary-leaf-v2';

  const depthMaterial = new MeshDepthMaterial({ depthPacking: RGBADepthPacking, side: DoubleSide });
  depthMaterial.onBeforeCompile = (shader) => {
    patchDepth(shader, shared, uniforms);
  };
  depthMaterial.customProgramCacheKey = () => 'diary-leaf-depth-v1';

  const distanceMaterial = new MeshDistanceMaterial({ side: DoubleSide });
  distanceMaterial.onBeforeCompile = (shader) => {
    patchDepth(shader, shared, uniforms);
  };
  distanceMaterial.customProgramCacheKey = () => 'diary-leaf-distance-v1';

  return { uniforms, material, depthMaterial, distanceMaterial };
}

export function disposeLeafSlot(slot: LeafSlot): void {
  slot.material.dispose();
  slot.depthMaterial.dispose();
  slot.distanceMaterial.dispose();
}
