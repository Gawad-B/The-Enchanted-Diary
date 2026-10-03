import { BOARD_T, GUTTER_LENGTH, LEAF_T, PAGE_H, PAGE_W } from './dimensions';
import { LEAF_BEND_STEPS, LEAF_BOW, LEAF_LAG_EXPONENT, LEAF_LAG_GAIN } from './leafReach';

/*
 * GLSL shared by the book's materials. Everything is injected into three's built-in materials with
 * `onBeforeCompile`, so lighting, shadows and fog come from three and only the geometry and the albedo are
 * ours. The vertex bend and the gutter are the same code in the visible material and in the shadow (depth)
 * material, or a bent page would cast the shadow of a flat one.
 */

const f = (value: number): string => value.toFixed(5);

/** Constants shared with the TypeScript side, so the two cannot drift apart. */
export const BOOK_DEFINES = `
#define PAGE_W ${f(PAGE_W)}
#define PAGE_H ${f(PAGE_H)}
#define BOARD_T ${f(BOARD_T)}
#define LEAF_T ${f(LEAF_T)}
#define GUTTER_L ${f(GUTTER_LENGTH)}
#define BOOK_PI 3.14159265359
`;

export const NOISE_GLSL = `
float bookHash(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}
float bookNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(bookHash(i), bookHash(i + vec2(1.0, 0.0)), u.x),
             mix(bookHash(i + vec2(0.0, 1.0)), bookHash(i + vec2(1.0, 1.0)), u.x), u.y);
}
`;

/**
 * How far a surface sinks into the gutter at distance `s` from the spine, given the total `drop` it makes at the
 * spine (the height of the stack's surface above the valley), and the slope of that sag. Open books only.
 */
export const GUTTER_GLSL = `
// A thin stack (a few leaves on a board) does not lie dead flat: its pages bow up out of the gutter, rising to a peak
// about a quarter of a page from the spine and settling again. A thick stack gets its rise from the dip instead.
float gutterArch(float s, float arch) {
  float x = s / (0.28 * PAGE_W);
  return arch * x * exp(1.0 - x);
}
float gutterArchSlope(float s, float arch) {
  float a = 0.28 * PAGE_W;
  float x = s / a;
  return arch * (1.0 - x) * exp(1.0 - x) / a;
}
float gutterDip(float s, float drop) {
  float x = clamp(s / GUTTER_L, 0.0, 1.0);
  return drop * pow(1.0 - x, 2.4);
}
float gutterDipSlope(float s, float drop) {
  float x = clamp(s / GUTTER_L, 0.0, 1.0);
  return -drop * 2.4 * pow(1.0 - x, 1.4) / GUTTER_L * (x < 0.9999 ? 1.0 : 0.0);
}
`;

/**
 * The bend of a turning leaf, in the leaf's canonical frame (x = distance from the spine, y up).
 *
 * A straight leaf turned by `ang = uTheta * pi` has the tangent angle `ang` everywhere. While it turns the
 * free edge lags behind the hinge (paper has air resistance and bends), so the tangent angle becomes
 *   phi(u) = ang - uTurnV * k * LEAF_LAG_GAIN * u^LEAF_LAG_EXPONENT,   u = s / PAGE_W,   k = uBend * sin(ang),
 * which peaks mid-turn (k = 0 at both rests) and is larger at the free edge. The position is the integral of
 * the tangent, (cos phi, sin phi), along the leaf, evaluated with LEAF_BEND_STEPS midpoint steps (the constants are
 * leafReach.ts's, which also holds this arithmetic in TypeScript: the camera frames what the leaf really does). `uTurnV` is +1 while the
 * leaf turns forward and -1 while it turns back, so the lag always trails the motion. At rest the page is
 * flat and only sags into the gutter. The normal is the perpendicular of the tangent.
 */
export const LEAF_BEND_GLSL = `
uniform float uTheta;
uniform float uBend;
uniform float uTurnV;
uniform float uRest;
uniform float uDrop;
uniform float uArch;
uniform vec4 uJitter;
uniform float uOpen;
uniform float uSide;
uniform float uTremble;
uniform float uTime;

void leafBend(float s, float z, out vec2 p, out vec2 n) {
  float ang = uTheta * BOOK_PI;
  float k = uBend * sin(ang);
  float lagScale = uTurnV * k * ${f(LEAF_LAG_GAIN)};
  vec2 acc = vec2(0.0);
  float ds = s / ${f(LEAF_BEND_STEPS)};
  for (int i = 0; i < ${String(LEAF_BEND_STEPS)}; i++) {
    float u = ((float(i) + 0.5) / ${f(LEAF_BEND_STEPS)}) * (s / PAGE_W);
    float phi = ang - lagScale * pow(u, ${f(LEAF_LAG_EXPONENT)});
    acc += vec2(cos(phi), sin(phi)) * ds;
  }
  float uEnd = s / PAGE_W;
  float phiEnd = ang - lagScale * pow(uEnd, ${f(LEAF_LAG_EXPONENT)});
  // An open book's stacks slope into a common valley at the spine; a leaf in the air has left its stack.
  float sag = uRest * uOpen;
  p = acc;
  p.y -= sag * gutterDip(s, uDrop);
  p.y += sag * gutterArch(s, uArch);
  // The leaf also bows a little across its height while it moves: the head and tail trail the middle.
  float across = cos(BOOK_PI * z / PAGE_H);
  vec2 along = vec2(cos(phiEnd), sin(phiEnd));
  vec2 perp = vec2(-along.y, along.x);
  p += perp * (-uTurnV * k * ${f(LEAF_BOW)} * (1.0 - across) * uEnd);
  vec2 t = vec2(cos(phiEnd), sin(phiEnd) - sag * gutterDipSlope(s, uDrop) + sag * gutterArchSlope(s, uArch));
  n = normalize(vec2(-t.y, t.x));
}
`;

/** Vertex code of a leaf: the bent position and normal, the jitter, the tremble. */
export const LEAF_VERTEX_NORMAL = `
vec2 leafP;
vec2 leafN;
leafBend(position.x, position.z, leafP, leafN);
vec3 objectNormal = vec3(uSide * leafN.x, leafN.y, 0.0);
#ifdef USE_TANGENT
vec3 objectTangent = vec3(tangent.xyz);
#endif
`;

export const LEAF_VERTEX_POSITION = `
vec2 lbP;
vec2 lbN;
leafBend(position.x, position.z, lbP, lbN);
// Each sheet's fore-edge is a little uneven, but the spine edge is bound: the sideways jitter grows from zero at the spine.
vec3 transformed = vec3(uSide * lbP.x + uJitter.x * (position.x / PAGE_W), lbP.y + uJitter.z, position.z + uJitter.y);
transformed.y += uTremble * 0.006 * sin(position.x * 38.0 + uTime * 41.0) * sin(position.z * 23.0 + uTime * 29.0);
#ifdef USE_ALPHAHASH
vPosition = vec3(position);
#endif
`;

/**
 * What darkens a page that lies in an open book, applied AFTER the reading light (so it works on every tier, and
 * the book keeps its volume even when the page is mostly its unlit colour): ambient occlusion deepening toward the
 * gutter, a 2 mm crease in it, and the soft shadow of the leaf that is turning, which falls on the pages under it.
 * `turnedSide` is 0 for the unturned stack and 1 for the turned one; `rest` is 1 for a page lying still.
 */
export const PAGE_OCCLUSION_GLSL = `
uniform float uTurnAng;
uniform float uTurnAmount;
float pageOcclusion(float s, float turnedSide, float rest, float open) {
  float x = s / PAGE_W;
  float ao = mix(0.3, 1.0, smoothstep(0.0, 0.22, x));
  float crease = 1.0 - 0.45 * (1.0 - smoothstep(0.0, 0.018, s));
  float shadow = 1.0;
  if (uTurnAmount > 0.001) {
    float angle = uTurnAng * BOOK_PI;
    float sinA = sin(angle);
    float cosA = cos(angle);
    if (turnedSide < 0.5) {
      // The candle stands on the turned side, so a standing leaf throws its shadow across the unturned page: it covers
      // the page from the spine out to the leaf's foot and a good way beyond, however far over the leaf has leaned.
      float reach = PAGE_W * (0.25 + 0.55 * sinA + 0.4 * max(cosA, 0.0));
      shadow = 1.0 - 0.55 * uTurnAmount * (1.0 - smoothstep(reach - 0.26 * PAGE_W, reach + 0.08 * PAGE_W, s));
    } else if (uTurnAng > 0.5) {
      // Over the turned page: a weaker shadow, only once the leaf has leaned over it.
      float reach = PAGE_W * (0.2 + 0.8 * abs(cosA));
      shadow = 1.0 - 0.3 * uTurnAmount * (1.0 - smoothstep(reach - 0.24 * PAGE_W, reach + 0.06 * PAGE_W, s));
    }
  }
  return mix(1.0, ao * crease, open * rest) * mix(1.0, shadow, rest);
}
`;
