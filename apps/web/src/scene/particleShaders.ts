import { NOISE_GLSL } from './book/shaderChunks';

/*
 * Dust and magic motes: points drawn from one buffer with all the motion in the vertex shader (slow brownian
 * drift from sums of sines, no per-frame CPU work), soft round sprites, additive blending. Dust is only seen
 * where the candle lights it; the motes near the book glow brighter with `uGlow`.
 */

export const DUST_VERTEX = `
uniform float uTime;
uniform float uPixelScale;
uniform vec3 uCandle;
uniform float uSlow;
attribute float aSeed;
attribute float aSize;
varying float vBrightness;
${NOISE_GLSL}
void main() {
  float t = uTime * uSlow;
  vec3 p = position;
  // Brownian-like drift: three incommensurate sines per axis, each with its own phase from the seed.
  float s1 = aSeed * 6.2831;
  p.x += sin(t * 0.11 + s1) * 0.55 + sin(t * 0.23 + s1 * 2.3) * 0.28 + sin(t * 0.47 + s1 * 4.1) * 0.1;
  // The dust sinks slowly and starts again at the top: it fades out before it wraps and fades in after, so it never pops.
  float sink = fract(aSeed * 3.7 + t * 0.0045 * (0.4 + aSeed));
  p.y += sin(t * 0.09 + s1 * 1.7) * 0.4 + sin(t * 0.19 + s1 * 3.1) * 0.2 - sink * 1.75;
  p.z += sin(t * 0.13 + s1 * 3.3) * 0.5 + sin(t * 0.29 + s1 * 1.1) * 0.22 + sin(t * 0.53 + s1 * 5.0) * 0.09;
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * mv;
  float dist = -mv.z;
  gl_PointSize = aSize * uPixelScale / max(dist, 0.5);
  // Lit by the candle: bright near the flame, a faint trace far away; fades with depth and near the lens.
  float d = distance(p, uCandle);
  float lit = 1.4 / (1.0 + d * d * 0.5);
  float twinkle = 0.65 + 0.35 * sin(uTime * (0.6 + aSeed * 1.3) + s1 * 3.0);
  float depthFade = smoothstep(0.8, 2.6, dist) * (1.0 - smoothstep(9.0, 15.0, dist));
  float wrapFade = smoothstep(0.0, 0.1, sink) * (1.0 - smoothstep(0.9, 1.0, sink));
  vBrightness = lit * twinkle * depthFade * wrapFade;
}
`;

export const DUST_FRAGMENT = `
uniform vec3 uColor;
uniform float uOpacity;
varying float vBrightness;
void main() {
  vec2 c = gl_PointCoord - 0.5;
  float d = length(c) * 2.0;
  float alpha = pow(max(0.0, 1.0 - d), 2.0);
  gl_FragColor = vec4(uColor * vBrightness, alpha * vBrightness * uOpacity);
}
`;

/**
 * Motes: a few fine sparks that lift off the edges of the page block and fade within a hand's breadth. Each starts
 * on the perimeter of the book (the buffer's x is its place along it, y its phase in its life), rises about 16 cm
 * while it brightens and fades, and wobbles a little. Only a fraction are visible (`uVisible`, from the glow), the
 * rest are collapsed. Brightness is faint at rest and grows with the glow.
 */
export const MOTE_VERTEX = `
uniform float uTime;
uniform float uPixelScale;
uniform float uGlow;
uniform float uSlow;
uniform float uVisible;
uniform float uOpen;
attribute float aSeed;
attribute float aSize;
varying float vBrightness;
void main() {
  float t = uTime * uSlow;
  float s1 = aSeed * 6.2831;
  // A point on the perimeter of the page block: the closed book's, widening as the book opens.
  float hx = mix(0.82, 1.62, uOpen);
  float hz = 1.1;
  float w = 2.0 * hx;
  float d = 2.0 * hz;
  float s = position.x * 2.0 * (w + d);
  vec2 p;
  if (s < w) p = vec2(-hx + s, hz);
  else if (s < w + d) p = vec2(hx, hz - (s - w));
  else if (s < 2.0 * w + d) p = vec2(hx - (s - w - d), -hz);
  else p = vec2(-hx, -hz + (s - 2.0 * w - d));
  float life = fract(position.y + t * (0.05 + aSeed * 0.04));
  float baseY = 0.1 + fract(aSeed * 7.13) * 0.2;
  vec3 pos = vec3(p.x + sin(t * 0.7 + s1) * 0.025, baseY + life * 0.16, p.y + cos(t * 0.6 + s1) * 0.025);
  vec4 mv = modelViewMatrix * vec4(pos, 1.0);
  gl_Position = projectionMatrix * mv;
  float dist = -mv.z;
  float visible = step(aSeed, uVisible);
  gl_PointSize = visible * aSize * uPixelScale / max(dist, 0.5) * (0.9 + uGlow * 0.5);
  float fade = sin(3.14159 * life);
  float twinkle = 0.7 + 0.3 * sin(uTime * (1.3 + aSeed * 1.7) + s1);
  vBrightness = visible * fade * twinkle * (0.15 + uGlow * 0.8);
}
`;

export const MOTE_FRAGMENT = `
uniform vec3 uColor;
varying float vBrightness;
void main() {
  vec2 c = gl_PointCoord - 0.5;
  float d = length(c) * 2.0;
  float core = pow(max(0.0, 1.0 - d), 3.0);
  float halo = pow(max(0.0, 1.0 - d), 1.4) * 0.3;
  float a = (core + halo) * vBrightness;
  gl_FragColor = vec4(uColor * a * 1.5, a);
}
`;

export const SHAFT_VERTEX = `
varying vec3 vNormalView;
varying float vAlong;
varying vec3 vWorld;
void main() {
  // uv.y runs 1 at the apex (the flame) to 0 at the base (over the book).
  vAlong = 1.0 - clamp(uv.y, 0.0, 1.0);
  vNormalView = normalize(normalMatrix * normal);
  vec4 world = modelMatrix * vec4(position, 1.0);
  vWorld = world.xyz;
  gl_Position = projectionMatrix * viewMatrix * world;
}
`;

/**
 * A soft shaft of haze: brightest where the cone faces the eye, fading at its silhouette, to nothing at the flame
 * and at its far end (so it never ends in a hard edge), and to nothing near the table (so it never cuts into
 * the table or the book). Every `pow` has a non-negative base: with multisampling the interpolated values can
 * stray a hair outside their range, and a NaN in an HDR buffer turns the whole frame black through the bloom.
 */
export const SHAFT_FRAGMENT = `
uniform float uTime;
uniform float uOpacity;
varying vec3 vNormalView;
varying float vAlong;
varying vec3 vWorld;
${NOISE_GLSL}
void main() {
  float along = clamp(vAlong, 0.0, 1.0);
  float facing = abs(dot(normalize(vNormalView), vec3(0.0, 0.0, 1.0)));
  float edge = pow(clamp(facing, 0.0, 1.0), 1.4);
  // Rises from the flame, peaks a third of the way, and is gone before the far end.
  float lengthFade = smoothstep(0.0, 0.16, along) * (1.0 - smoothstep(0.55, 1.0, along));
  // Nothing within a hand of the table: the haze thins out toward it instead of being cut by it.
  float heightFade = smoothstep(0.02, 0.7, vWorld.y);
  float shimmer = 0.65 + 0.35 * bookNoise(vec2(along * 5.0 - uTime * 0.08, vWorld.x * 0.8 + vWorld.z * 0.6));
  float a = edge * lengthFade * heightFade * shimmer * uOpacity;
  gl_FragColor = vec4(vec3(1.0, 0.7, 0.36) * a, a);
}
`;
