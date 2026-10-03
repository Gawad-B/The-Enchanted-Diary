import { NOISE_GLSL } from './book/shaderChunks';

/*
 * The flame: a camera-facing quad (a billboard) whose fragment shader draws a teardrop of fire from noise: a small
 * desaturated base on the wick, a yellow-white core, a thin amber envelope and an orange-red tip. Only the core is
 * brighter than white (HDR, so it alone catches the bloom). The material is tone mapped like everything else,
 * so the flame looks the same with and without the composer (three tone maps the material when it draws to the
 * screen; the composer's own tone mapping does it when it draws to a render target).
 */

export const FLAME_VERTEX = `
uniform float uTime;
uniform vec2 uSize;
uniform vec3 uLean;
varying vec2 vUv;
${NOISE_GLSL}
void main() {
  vUv = uv;
  float h = uv.y;
  // Billboard about the vertical axis: use the camera's right vector, keep up vertical.
  vec3 right = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
  vec3 up = vec3(0.0, 1.0, 0.0);
  vec3 offset = right * (uv.x - 0.5) * uSize.x + up * h * uSize.y;
  // The tip leans and flutters; the base stays on the wick.
  float sway = (bookNoise(vec2(uTime * 3.1, h * 2.0)) - 0.5) * 0.09 * h * h;
  offset += right * sway * uSize.x * 3.0;
  offset += uLean * h * h * uSize.y;
  vec4 world = modelMatrix * vec4(0.0, 0.0, 0.0, 1.0);
  gl_Position = projectionMatrix * viewMatrix * vec4(world.xyz + offset, 1.0);
}
`;

export const FLAME_FRAGMENT = `
uniform float uTime;
uniform float uIntensity;
varying vec2 vUv;
${NOISE_GLSL}
void main() {
  // Interpolated values can stray a hair outside 0..1 under multisampling: a pow of a negative number is a NaN,
  // and a NaN in the HDR buffer turns the frame black through the bloom.
  float h = clamp(vUv.y, 0.0, 1.0);
  float x = (vUv.x - 0.5) * 2.0;
  // The flame wobbles sideways and breathes in width as it climbs.
  float wobble = (bookNoise(vec2(h * 3.2 - uTime * 5.5, uTime * 0.7)) - 0.5) * 0.36 * h;
  float breathe = 0.93 + 0.07 * sin(uTime * 11.0 + h * 4.0);
  x += wobble;
  // Teardrop: widest low down, closing to a point at the top.
  float width = (0.1 + 0.9 * pow(max(sin(clamp(h * 1.08, 0.0, 1.0) * 3.14159 * 0.92), 0.0), 0.8)) * (1.0 - pow(h, 2.4) * 0.55) * breathe;
  float dist = abs(x) / max(width, 0.001);
  float body = (1.0 - smoothstep(0.55, 1.0, dist)) * smoothstep(0.0, 0.04, h) * (1.0 - smoothstep(0.86, 1.0, h));
  // Layers from the middle out: a yellow-white core, a thin amber envelope, an orange-red tip.
  float core = (1.0 - smoothstep(0.0, 0.5, dist)) * (1.0 - smoothstep(0.08, 0.62, h));
  float envelope = body * (1.0 - core);
  float tongue = bookNoise(vec2(x * 4.0, h * 6.0 - uTime * 6.0));
  vec3 coreColor = vec3(1.0, 0.82, 0.46);
  vec3 amberColor = vec3(1.0, 0.42, 0.06);
  vec3 tipColor = vec3(0.92, 0.26, 0.05);
  vec3 color = mix(amberColor, tipColor, smoothstep(0.45, 0.95, h));
  color = mix(color, coreColor, core);
  // A little desaturated blue where the flame meets the wick (under 20% of its height).
  float foot = (1.0 - smoothstep(0.0, 0.18, h)) * body;
  color = mix(color, vec3(0.55, 0.62, 0.8), foot * 0.32);
  // HDR only in the core (1.2 to 1.8); the envelope stays at or below white.
  float strength = mix(0.72, 1.2 + 0.55 * core, core) * uIntensity;
  float alpha = clamp(body * (0.8 + 0.2 * mix(tongue, 1.0, core)), 0.0, 1.0);
  gl_FragColor = vec4(color * strength, alpha);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

/** A soft round glow behind the flame, brighter at its centre, drawn additively. */
export const HALO_FRAGMENT = `
uniform float uIntensity;
varying vec2 vUv;
void main() {
  vec2 p = (vUv - 0.5) * 2.0;
  float d = length(p);
  float glow = pow(max(0.0, 1.0 - d), 2.6);
  gl_FragColor = vec4(vec3(1.0, 0.62, 0.26) * glow * uIntensity, glow);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

export const HALO_VERTEX = `
varying vec2 vUv;
uniform vec2 uSize;
void main() {
  vUv = uv;
  vec3 right = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
  vec3 up = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);
  vec4 world = modelMatrix * vec4(0.0, 0.0, 0.0, 1.0);
  vec3 offset = right * (uv.x - 0.5) * uSize.x + up * (uv.y - 0.5) * uSize.y;
  gl_Position = projectionMatrix * viewMatrix * vec4(world.xyz + offset, 1.0);
}
`;

/** The wax's warm glow from within, near the top, fading with the height below it (a stand-in for subsurface light). */
export const WAX_FRAGMENT_EMISSIVE = `
#include <emissivemap_fragment>
{
  float below = max(uWaxTopY - vWaxY, 0.0);
  // Strong within a hand of the flame, still a warm ivory glow all the way down (the light inside the wax).
  float within = mix(0.03, 1.0, exp(-below / 0.24));
  totalEmissiveRadiance += vec3(1.0, 0.68, 0.36) * within * 0.5 * uWaxFlicker;
}
`;
