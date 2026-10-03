import type { ShaderMaterial } from 'three';

/** Sets a numeric uniform of a shader material, if it has one by that name (no assertions needed at call sites). */
export function setUniform(material: ShaderMaterial, name: string, value: number): void {
  const uniform = material.uniforms[name];
  if (uniform) uniform.value = value;
}
