import { BufferAttribute, LatheGeometry, Vector2 } from 'three';
import { CANDLE_HEIGHT, CANDLE_RADIUS, DISH_RADIUS } from './sceneConstants';

/*
 * The candle's solids, all lathed from a profile: the wax body (a slightly flared foot, a straight body, a rim that
 * has melted into a shallow pool round the wick), the brass dish, and the teardrop of a wax drip.
 */

/** The wax body: a profile from the foot up, with the rim at the top and the pool of melted wax inside it. */
export function waxGeometry(): LatheGeometry {
  const r = CANDLE_RADIUS;
  const h = CANDLE_HEIGHT;
  const points = [
    new Vector2(0.0, 0.0),
    new Vector2(r * 1.1, 0.0),
    new Vector2(r * 1.04, 0.04),
    new Vector2(r * 0.99, 0.16),
    new Vector2(r * 0.97, h * 0.5),
    new Vector2(r * 0.96, h * 0.9),
    new Vector2(r * 0.94, h * 0.985),
    new Vector2(r * 0.88, h * 1.0),
    new Vector2(r * 0.72, h * 0.982),
    new Vector2(r * 0.34, h * 0.968),
    new Vector2(0.0, h * 0.966),
  ];
  const geometry = new LatheGeometry(points, 44);
  // The melted pool inside the rim is translucent, amber and darker than the opaque wall (it would otherwise be a
  // blown-out white disc under the flame): painted in as vertex colours.
  const position = geometry.getAttribute('position');
  const colour = new Float32Array(position.count * 3);
  for (let i = 0; i < position.count; i += 1) {
    const radius = Math.hypot(position.getX(i), position.getZ(i));
    const pool = position.getY(i) > h * 0.95 && radius < r * 0.9 ? 1 : 0;
    colour[i * 3] = 1 - pool * 0.12;
    colour[i * 3 + 1] = 1 - pool * 0.42;
    colour[i * 3 + 2] = 1 - pool * 0.68;
  }
  geometry.setAttribute('color', new BufferAttribute(colour, 3));
  return geometry;
}

/** The brass dish: a shallow saucer with a turned rim. */
export function dishGeometry(): LatheGeometry {
  const points = [
    new Vector2(0.0, 0.0),
    new Vector2(0.3, 0.0),
    new Vector2(0.335, 0.014),
    new Vector2(DISH_RADIUS, 0.04),
    new Vector2(0.318, 0.056),
    new Vector2(0.25, 0.064),
    new Vector2(0.17, 0.082),
    new Vector2(0.15, 0.09),
    new Vector2(0.0, 0.09),
  ];
  return new LatheGeometry(points, 40);
}

/**
 * A drip of wax: unit height, unit width. A rounded bulb at the bottom, a neck, and a widening that melts
 * into the candle at the top. The caller flattens it against the wall of the candle (it runs down the side, it is
 * not a bead).
 */
export function dripGeometry(): LatheGeometry {
  const points = [
    new Vector2(0.0, 0.0),
    new Vector2(0.42, 0.015),
    new Vector2(0.82, 0.06),
    new Vector2(1.0, 0.13),
    new Vector2(0.92, 0.22),
    new Vector2(0.68, 0.36),
    new Vector2(0.58, 0.55),
    new Vector2(0.64, 0.74),
    new Vector2(0.84, 0.9),
    new Vector2(1.0, 1.0),
    new Vector2(0.0, 1.0),
  ];
  return new LatheGeometry(points, 14);
}
