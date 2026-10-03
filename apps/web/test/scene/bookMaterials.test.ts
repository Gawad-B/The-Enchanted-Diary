import { CanvasTexture, type WebGLProgramParametersWithUniforms, type WebGLRenderer } from 'three';
import { describe, expect, it } from 'vitest';
import {
  createEndpaperMaterial,
  createLeatherMaterials,
  createStackMaterials,
} from '../../src/scene/book/bookMaterials';
import { createBookUniforms } from '../../src/scene/book/bookUniforms';
import { createLeafSlot } from '../../src/scene/book/leafMaterial';
import type { CoverTextures } from '../../src/scene/textures/leatherTexture';

/*
 * The page effects (ink spreading, light from within, a trembling page, a memory draining the colour) are one set of
 * uniform objects shared by every material of the book: the cover as well as the leaves. These check that each
 * material is wired to them, by compiling its patch against a stand-in shader.
 */

function texture(): CanvasTexture {
  return new CanvasTexture(document.createElement('canvas'));
}

function coverTextures(): CoverTextures {
  return { albedo: texture(), data: texture(), emissive: texture() };
}

/** A shader with the chunks three's built-in materials expose, which our patches replace. */
function fakeShader(): WebGLProgramParametersWithUniforms {
  return {
    uniforms: {},
    vertexShader: '#include <common>\n#include <beginnormal_vertex>\n#include <begin_vertex>\nvoid main(){}',
    fragmentShader:
      '#include <common>\n#include <map_fragment>\n#include <roughnessmap_fragment>\n#include <emissivemap_fragment>\n#include <opaque_fragment>\nvoid main(){}',
  } as unknown as WebGLProgramParametersWithUniforms;
}

function compile(material: { onBeforeCompile: (shader: never, renderer: never) => void }) {
  const shader = fakeShader();
  material.onBeforeCompile(shader as never, {} as WebGLRenderer as never);
  return shader;
}

const EFFECT_UNIFORMS = ['uInkSpread', 'uGlow', 'uTremble', 'uMemoryPull', 'uEdgeGlow', 'uTime'] as const;

describe('the cover answers the page effects, like the leaves do', () => {
  const shared = createBookUniforms();
  const leather = createLeatherMaterials(shared, coverTextures(), coverTextures());

  it('the board with the art reads inkSpread, glow, tremble, memoryPull and edgeGlow from the shared uniforms', () => {
    const shader = compile(leather.art);
    for (const name of EFFECT_UNIFORMS) expect(shader.uniforms[name], name).toBe(shared[name]);
    // The tremble moves the board, the glow and the ink feed the sigil, the memory drains the colour.
    expect(shader.vertexShader).toContain('uTremble');
    expect(shader.fragmentShader).toContain('uInkSpread');
    expect(shader.fragmentShader).toContain('uGlow');
    expect(shader.fragmentShader).toContain('uMemoryPull');
  });

  it('the plain leather of the edges and the spine and the pastedown are wired the same way', () => {
    for (const material of [leather.plain, createEndpaperMaterial(texture(), shared)]) {
      const shader = compile(material);
      for (const name of EFFECT_UNIFORMS) expect(shader.uniforms[name], name).toBe(shared[name]);
    }
  });

  it('has a real physical finish: a soft sheen on the art leather and a clear sheen on the edges', () => {
    expect(leather.art.sheen).toBeGreaterThan(0.2);
    expect(leather.plain.clearcoat).toBeGreaterThan(0.2);
  });
});

describe("the leaves and the stacks share the turning leaf's shadow and the gutter shape", () => {
  const shared = createBookUniforms();

  it('a leaf reads the shared turn shadow, its own gutter arch and drop, and caps its specular', () => {
    const slot = createLeafSlot(shared, texture());
    const shader = compile(slot.material);
    expect(shader.uniforms.uTurnAng).toBe(shared.uTurnAng);
    expect(shader.uniforms.uTurnAmount).toBe(shared.uTurnAmount);
    expect(shader.uniforms.uArch).toBe(slot.uniforms.uArch);
    expect(slot.material.specularIntensity).toBeLessThan(0.3);
    // The occlusion and the clamp come after the reading light, so the book keeps its volume on every tier.
    expect(shader.fragmentShader.indexOf('pageOcclusion(vLeafS')).toBeGreaterThan(
      shader.fragmentShader.indexOf('uReadingTint * pageShade'),
    );
    expect(shader.fragmentShader).toContain('min(outgoingLight');
  });

  it('the depth material bends the leaf (and sags and arches it) exactly like the visible one', () => {
    const slot = createLeafSlot(shared, texture());
    const shader = compile(slot.depthMaterial);
    expect(shader.uniforms.uArch).toBe(slot.uniforms.uArch);
    expect(shader.vertexShader).toContain('gutterArch');
  });

  it('the stack edges and tops know which stack they are and share the occlusion; the edges are never black', () => {
    const stack = createStackMaterials(shared, 1);
    const shader = compile(stack.materials[0] as never);
    expect(shader.uniforms.uStackTurned).toBe(stack.uniforms.uStackTurned);
    expect(shader.uniforms.uArch).toBe(stack.uniforms.uArch);
    expect(shader.uniforms.uTurnAmount).toBe(shared.uTurnAmount);
    expect(shader.fragmentShader).toContain('edgeFill');
    expect(shader.fragmentShader).toContain('pageOcclusion(vEdgeS');
    const top = compile(stack.materials[2] as never);
    expect(top.fragmentShader).toContain('pageOcclusion(vEdgeS');
  });

  it('the glow of the edges is a thin gilt line at the head, the fore-edge and the tail, not the whole face', () => {
    const stack = createStackMaterials(shared, 1);
    const shader = compile(stack.materials[0] as never);
    expect(shader.fragmentShader).toContain('gilt');
    expect(shader.fragmentShader).toContain('lineDistance');
  });
});
