import {
  Color,
  MeshPhysicalMaterial,
  MeshStandardMaterial,
  type IUniform,
  type Texture,
  type WebGLProgramParametersWithUniforms,
} from 'three';
import type { CoverTextures } from '../textures/leatherTexture';
import type { BookUniforms } from './bookUniforms';
import { BOOK_DEFINES, GUTTER_GLSL, NOISE_GLSL, PAGE_OCCLUSION_GLSL } from './shaderChunks';

/*
 * Materials of everything in the book that is not a leaf: the cover leather with its gold tooling, the page
 * block's edges, the stack tops, the spine. Created once; onBeforeCompile adds the page-effect uniforms and
 * the little bits of procedural shading that textures cannot do (the fore-edge lines of a thousand sheets).
 */

type Shader = WebGLProgramParametersWithUniforms;

export interface StackUniforms {
  /** Height of the stack in scene units. */
  uHeight: IUniform<number>;
  /** +1 when the stack extends towards +x from the spine, -1 towards -x. */
  uOutward: IUniform<number>;
  /** How far the top of the stack is above the valley at the spine. */
  uDrop: IUniform<number>;
  /** How far a thin stack's top bows up out of the gutter (scene units). */
  uArch: IUniform<number>;
  /** 1 for the stack of turned leaves, 0 for the unturned one (the turning leaf shadows the one it is over). */
  uStackTurned: IUniform<number>;
}

const STACK_VERTEX = `
#include <common>
${BOOK_DEFINES}
${GUTTER_GLSL}
uniform float uHeight;
uniform float uOutward;
uniform float uDrop;
uniform float uArch;
uniform float uOpen;
varying float vEdgeY;
varying float vEdgeS;
`;

/** The unit box's top vertices follow the gutter sag, exactly like the leaves that rest on them. */
const STACK_BEGIN_VERTEX = `
vec3 transformed = vec3(position);
float edgeS = (uOutward * position.x + 0.5) * PAGE_W;
if (position.y > 0.0) {
  transformed.y -= uOpen * gutterDip(edgeS, uDrop) / max(uHeight, 0.0001);
  transformed.y += uOpen * gutterArch(edgeS, uArch) / max(uHeight, 0.0001);
}
vEdgeY = (position.y + 0.5) * uHeight;
vEdgeS = edgeS;
#ifdef USE_ALPHAHASH
vPosition = vec3(position);
#endif
`;

/**
 * Fore-edge of the page block: thin lines for the sheets (bands of paper with a darker gap, fading to an
 * average where they get finer than a pixel), a slightly different tone per band, a warm age stain, and the
 * edge glow.
 */
const EDGE_FRAGMENT_MAP = `
// Two scales of lines: groups of sheets (gatherings) and the sheets themselves. The fine ones fade out where they
// would be finer than a pixel, so the edge never shimmers.
float broad = vEdgeY / 0.021;
float broadCell = fract(broad);
float broadGap = smoothstep(0.0, 0.12, broadCell) * (1.0 - smoothstep(0.88, 1.0, broadCell));
float broadVisible = 1.0 - smoothstep(0.35, 0.8, fwidth(broad));
float fine = vEdgeY / 0.0058;
float fineCell = fract(fine);
float fineGap = smoothstep(0.0, 0.2, fineCell) * (1.0 - smoothstep(0.8, 1.0, fineCell));
float fineVisible = 1.0 - smoothstep(0.3, 0.7, fwidth(fine));
float randomTone = bookHash(vec2(floor(fine), 3.7));
float lines = mix(0.88, mix(0.6, 1.0, broadGap), broadVisible) * mix(1.0, mix(0.72, 1.0, fineGap) * (0.9 + 0.14 * randomTone), fineVisible);
float edgeShade = lines;
float heightFraction = clamp(vEdgeY / max(uHeight, 0.0001), 0.0, 1.0);
edgeShade *= 0.78 + 0.22 * heightFraction;
float stain = bookNoise(vec2(vEdgeS * 5.0, vEdgeY * 90.0));
diffuseColor.rgb *= edgeShade * (0.86 + 0.18 * stain);
`;

/**
 * The glow of the edges is a thin gilt line along the head, the fore-edge and the tail of the block (a gilt edge, as
 * on old books), never the whole face: restraint, not a power-up.
 */
const EDGE_EMISSIVE = `
#include <emissivemap_fragment>
{
  float lineDistance = min(vEdgeY, max(uHeight - vEdgeY, 0.0));
  float gilt = 1.0 - smoothstep(0.0, 0.006, lineDistance);
  float pulse = 0.7 + 0.3 * sin(uTime * 1.7 + vEdgeS * 3.0);
  totalEmissiveRadiance += uEdgeGlow * gilt * pulse * vec3(1.0, 0.7, 0.3) * 0.5;
}
`;

/** The edges and the stack tops: paper is never black (the room and the pages bounce light), and it gets the page occlusion. */
const STACK_OPAQUE = `
{
  float edgeFill = FILL_AMOUNT + 0.14 * uReading;
  outgoingLight = max(outgoingLight, diffuseColor.rgb * edgeFill);
  outgoingLight *= pageOcclusion(vEdgeS, uStackTurned, 1.0, uOpen);
}
#include <opaque_fragment>
`;

function stackPatch(shader: Shader, shared: BookUniforms, stack: StackUniforms, edge: boolean): void {
  Object.assign(
    shader.uniforms,
    {
      uOpen: shared.uOpen,
      uTime: shared.uTime,
      uEdgeGlow: shared.uEdgeGlow,
      uReading: shared.uReading,
      uTurnAng: shared.uTurnAng,
      uTurnAmount: shared.uTurnAmount,
    },
    stack,
  );
  shader.vertexShader = shader.vertexShader
    .replace('#include <common>', STACK_VERTEX)
    .replace('#include <begin_vertex>', STACK_BEGIN_VERTEX);
  shader.fragmentShader = shader.fragmentShader
    .replace(
      '#include <common>',
      `#include <common>\n${BOOK_DEFINES}\n${NOISE_GLSL}\n${PAGE_OCCLUSION_GLSL}\nuniform float uHeight;\nuniform float uTime;\nuniform float uEdgeGlow;\nuniform float uOpen;\nuniform float uReading;\nuniform float uStackTurned;\nvarying float vEdgeY;\nvarying float vEdgeS;`,
    )
    .replace('#include <opaque_fragment>', STACK_OPAQUE.replace('FILL_AMOUNT', edge ? '0.34' : '0.2'));
  if (!edge) return;
  shader.fragmentShader = shader.fragmentShader
    .replace('#include <map_fragment>', EDGE_FRAGMENT_MAP)
    .replace('#include <emissivemap_fragment>', EDGE_EMISSIVE);
}

export interface StackMaterials {
  uniforms: StackUniforms;
  /** Material order of a BoxGeometry: +x, -x, top, bottom, +z, -z. */
  materials: MeshStandardMaterial[];
  dispose(): void;
}

/** Materials for one page-block stack: aged fore-edge on the sides, plain parchment on the top. */
export function createStackMaterials(shared: BookUniforms, outward: 1 | -1): StackMaterials {
  const uniforms: StackUniforms = {
    uHeight: { value: 0.3 },
    uOutward: { value: outward },
    uDrop: { value: 0 },
    uArch: { value: 0 },
    uStackTurned: { value: 0 },
  };
  // Cream paper edges; the specular is capped like the pages'.
  const edge = new MeshStandardMaterial({ color: new Color(0xd9c9a3), roughness: 0.92, metalness: 0 });
  edge.onBeforeCompile = (shader) => {
    stackPatch(shader, shared, uniforms, true);
  };
  edge.customProgramCacheKey = () => 'diary-stack-edge-v2';
  const top = new MeshStandardMaterial({ color: new Color(0xb5a47c), roughness: 0.95, metalness: 0 });
  top.onBeforeCompile = (shader) => {
    stackPatch(shader, shared, uniforms, false);
  };
  top.customProgramCacheKey = () => 'diary-stack-top-v2';
  return {
    uniforms,
    materials: [edge, edge, top, edge, edge, edge],
    dispose: () => {
      edge.dispose();
      top.dispose();
    },
  };
}

/**
 * The page effects (global section G) reach the cover too: a trembling board, light from within, a memory
 * draining the colour. They are small by design (the book is the stage, the pages are the actors), but the
 * uniforms are the same ones the leaves read, so one write per frame drives every material.
 */
const EFFECT_VERTEX_PARS = `
uniform float uTremble;
uniform float uTime;
`;
const EFFECT_VERTEX_TREMBLE = `
#include <begin_vertex>
transformed.y += uTremble * 0.004 * sin(position.x * 38.0 + uTime * 41.0) * sin(position.z * 23.0 + uTime * 29.0);
`;
const EFFECT_FRAGMENT_PARS = `
uniform float uTime;
uniform float uGlow;
uniform float uMemoryPull;
uniform float uInkSpread;
`;
const EFFECT_OPAQUE = `
{
  outgoingLight += uGlow * vec3(1.0, 0.7, 0.32) * 0.05;
  float effectLuma = dot(outgoingLight, vec3(0.299, 0.587, 0.114));
  outgoingLight = mix(outgoingLight, vec3(effectLuma) * vec3(1.18, 0.96, 0.7), uMemoryPull * 0.75);
}
#include <opaque_fragment>
`;

/** Attaches the shared effect uniforms to a built-in material's shader (the tremble, the glow, the memory). */
export function attachBookEffects(shader: Shader, shared: BookUniforms): void {
  Object.assign(shader.uniforms, {
    uTime: shared.uTime,
    uTremble: shared.uTremble,
    uGlow: shared.uGlow,
    uMemoryPull: shared.uMemoryPull,
    uInkSpread: shared.uInkSpread,
    uEdgeGlow: shared.uEdgeGlow,
  });
  shader.vertexShader = shader.vertexShader
    .replace('#include <common>', `#include <common>\n${EFFECT_VERTEX_PARS}`)
    .replace('#include <begin_vertex>', EFFECT_VERTEX_TREMBLE);
  shader.fragmentShader = shader.fragmentShader
    .replace('#include <common>', `#include <common>\n${EFFECT_FRAGMENT_PARS}\nuniform float uEdgeGlow;`)
    .replace('#include <opaque_fragment>', EFFECT_OPAQUE);
}

const COVER_EMISSIVE = `
#include <emissivemap_fragment>
{
  // The sigil's gold lines glow faintly, and more with edgeGlow, glow and the ink spreading from the middle; a thin
  // gilt line along the edge of the board catches the light when the book is attended to (never the whole face).
  float breathe = 0.5 + 0.5 * sin(uTime * 1.6);
  float fromMiddle = length(vCoverUv - 0.5) * 2.0;
  float spread = 1.0 - smoothstep(uInkSpread * 1.1 - 0.25, uInkSpread * 1.1 + 0.0001, fromMiddle);
  totalEmissiveRadiance *= 0.045 + uEdgeGlow * (0.55 + 0.45 * breathe) + uGlow * 1.4 + uInkSpread * spread * 1.6;
  float rim = 1.0 - smoothstep(0.0, 0.012, min(min(vCoverUv.x, 1.0 - vCoverUv.x), min(vCoverUv.y, 1.0 - vCoverUv.y)));
  totalEmissiveRadiance += uEdgeGlow * rim * vec3(1.0, 0.62, 0.24) * 0.22 * (0.7 + 0.3 * breathe);
}
`;

export interface LeatherMaterials {
  /** Outer face of a board: leather with the tooling and the sigil. */
  art: MeshPhysicalMaterial;
  /** Edges of a board and the spine: plain leather. */
  plain: MeshPhysicalMaterial;
  dispose(): void;
}

/**
 * Leather. `cover` carries the art (albedo, packed bump/roughness/metalness, emissive sigil); `grain` is a
 * small art-free tile for the board edges. The packed data map is read by three channel by channel: R as
 * the bump, G as the roughness, B as the metalness of the gold.
 */
export function createLeatherMaterials(
  shared: BookUniforms,
  cover: CoverTextures,
  grain: CoverTextures,
): LeatherMaterials {
  // Leather has a soft sheen at grazing angles (a physical material: `sheen` is its own term).
  const art = new MeshPhysicalMaterial({
    map: cover.albedo,
    bumpMap: cover.data,
    bumpScale: 2.2,
    roughnessMap: cover.data,
    roughness: 1,
    metalnessMap: cover.data,
    metalness: 1,
    emissiveMap: cover.emissive,
    emissive: new Color(0xffc977),
    emissiveIntensity: 1,
    sheen: 0.45,
    sheenColor: new Color(0x7a4030),
    sheenRoughness: 0.55,
  });
  art.onBeforeCompile = (shader) => {
    attachBookEffects(shader, shared);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec2 vCoverUv;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvCoverUv = uv;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec2 vCoverUv;')
      .replace('#include <emissivemap_fragment>', COVER_EMISSIVE);
  };
  art.customProgramCacheKey = () => 'diary-cover-art-v2';

  // The edges and squares of the boards are rubbed smooth by hands: a clear sheen where the light grazes them.
  const plain = new MeshPhysicalMaterial({
    map: grain.albedo,
    bumpMap: grain.data,
    bumpScale: 1.1,
    roughnessMap: grain.data,
    roughness: 0.85,
    color: new Color(0xddc8c0),
    clearcoat: 0.35,
    clearcoatRoughness: 0.42,
  });
  plain.onBeforeCompile = (shader) => {
    attachBookEffects(shader, shared);
  };
  plain.customProgramCacheKey = () => 'diary-cover-plain-v2';
  return {
    art,
    plain,
    dispose: () => {
      art.dispose();
      plain.dispose();
    },
  };
}

/** The inside of a cover: the marbled endpaper (its texture comes from the page source, swapped in when ready). */
export function createEndpaperMaterial(fallback: Texture, shared: BookUniforms): MeshStandardMaterial {
  // The pastedown sits in the shade of the open cover and the pages: a little darker than the paper it is drawn as.
  const material = new MeshStandardMaterial({
    map: fallback,
    roughness: 0.9,
    metalness: 0,
    color: new Color(0xc4c4c4),
  });
  material.onBeforeCompile = (shader) => {
    attachBookEffects(shader, shared);
  };
  material.customProgramCacheKey = () => 'diary-endpaper-v2';
  return material;
}
