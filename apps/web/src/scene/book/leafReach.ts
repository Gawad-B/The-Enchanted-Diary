import { PAGE_H, PAGE_W, turnedLeafY, unturnedLeafY } from './dimensions';

/*
 * Where a turning leaf actually goes: the hinge's path round the back of the stack (the rig) and the lagging bend of
 * the leaf (the vertex shader). The constants are read by the rig and written into the shader's source, and the two
 * functions below are the same arithmetic in TypeScript, so the camera can frame what really moves (a leaf stands
 * 1.7 to 1.8 units over the table in a thick book, not the 1.5 of a page's width: the hinge rides at mid-block height
 * and a leaf turned back is carried past the vertical by its bend).
 */

/** How far the hinge bulges outward round the back of the book, as a fraction of the two leaf heights' difference. */
export const HINGE_BULGE = 0.3;
/** How strongly a turning leaf bends (the shader's `uBend`). */
export const LEAF_BEND = 0.55;
/** The lag's gain and exponent along the leaf: phi(u) = ang - uTurnV * k * LEAF_LAG_GAIN * u^LEAF_LAG_EXPONENT. */
export const LEAF_LAG_GAIN = 1.15;
export const LEAF_LAG_EXPONENT = 1.6;
/** Midpoint steps the shader integrates the leaf's tangent with. */
export const LEAF_BEND_STEPS = 8;
/** How much the head and the tail of a moving leaf trail behind its middle. */
export const LEAF_BOW = 0.05;

/**
 * Where the hinge is along its arc round the back of the book: `x` outward from the spine (towards the side the leaf
 * lies on at rest, mirrored by `outward`), `y` above the table. Writes into `out`.
 */
export function hingeOffset(
  unturnedY: number,
  turnedY: number,
  theta: number,
  outward: number,
  out: { x: number; y: number },
): { x: number; y: number } {
  const angle = Math.PI * theta;
  const half = (unturnedY - turnedY) / 2;
  out.x = -outward * HINGE_BULGE * half * Math.sin(angle);
  out.y = (unturnedY + turnedY) / 2 + half * Math.cos(angle);
  return out;
}

/**
 * The point of a leaf `s` from the spine (0 to PAGE_W) and `z` along its height (head to tail), in the leaf's own frame
 * (x away from the spine, y up), for a leaf `theta` of the way round that is turning forward (`turnV` +1) or back (-1).
 * This is the shader's `leafBend` for a leaf in the air (the sag into the gutter is for leaves at rest).
 */
export function leafPoint(
  s: number,
  z: number,
  theta: number,
  turnV: number,
  out: { x: number; y: number },
): { x: number; y: number } {
  const ang = theta * Math.PI;
  const k = LEAF_BEND * Math.sin(ang);
  const lagScale = turnV * k * LEAF_LAG_GAIN;
  const ds = s / LEAF_BEND_STEPS;
  let x = 0;
  let y = 0;
  for (let i = 0; i < LEAF_BEND_STEPS; i += 1) {
    const u = ((i + 0.5) / LEAF_BEND_STEPS) * (s / PAGE_W);
    const phi = ang - lagScale * u ** LEAF_LAG_EXPONENT;
    x += Math.cos(phi) * ds;
    y += Math.sin(phi) * ds;
  }
  const uEnd = s / PAGE_W;
  const phiEnd = ang - lagScale * uEnd ** LEAF_LAG_EXPONENT;
  const across = Math.cos((Math.PI * z) / PAGE_H);
  const bow = -turnV * k * LEAF_BOW * (1 - across) * uEnd;
  out.x = x - Math.sin(phiEnd) * bow;
  out.y = y + Math.cos(phiEnd) * bow;
  return out;
}

/** A point of the outline a turning leaf sweeps, seen end-on (x across the book from the gutter, y above the table). */
export interface ReachPoint {
  x: number;
  y: number;
}

const hinge = { x: 0, y: 0 };
const edge = { x: 0, y: 0 };
const THETA_STEPS = 100;
/** A hand's breadth of margin on what the paper does (the jitter and the tremble are millimetres). */
const REACH_MARGIN = 0.03;

function cross(o: ReachPoint, a: ReachPoint, b: ReachPoint): number {
  return (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
}

/** One half of a monotone chain: the points in order, keeping only the left turns. */
function chain(points: readonly ReachPoint[]): ReachPoint[] {
  const half: ReachPoint[] = [];
  for (const p of points) {
    for (;;) {
      const b = half[half.length - 1];
      const a = half[half.length - 2];
      if (!a || !b || cross(a, b, p) > 0) break;
      half.pop();
    }
    half.push(p);
  }
  half.pop();
  return half;
}

/** The convex hull of some points (Andrew's monotone chain), counter-clockwise, without the repeated end point. */
function convexHull(points: ReachPoint[]): ReachPoint[] {
  const sorted = [...points].sort((a, b) => a.x - b.x || a.y - b.y);
  return [...chain(sorted), ...chain(sorted.reverse())];
}

const memo = new Map<number, readonly ReachPoint[]>();

/**
 * The outline of everything the leaves of a book of `leafCount` leaves sweep through while turning, forward and back,
 * seen end-on: the convex hull of the free edge of every leaf at every angle (the hull's points are the only ones that
 * can reach the edge of a picture, whatever the camera), made symmetric (the layout may be either way round) and with a
 * margin. Worked out from the same hinge path and bend as the rig and the shader, once per leaf count.
 *
 * Only the first and the last leaf are swept. Every leaf's hinge path has the same midpoint, (unturnedY + turnedY) / 2,
 * and its half-difference grows by a constant step with the leaf's index, so at one angle, turn direction and height the
 * free edge of a middle leaf is a convex combination of the two end leaves' edges (the bend does not depend on the
 * leaf: the rig sets the same `uBend = LEAF_BEND` on every slot, and whoever gives a leaf its own curl must re-check this hull). A hull of the end leaves is therefore the hull of all of them, and it costs the same for 300 pages as for 4
 * (a sweep of every leaf was a 25 to 260 ms task on the frame that began the unveiling).
 */
export function leafReachOutline(leafCount: number, total: number): readonly ReachPoint[] {
  const key = leafCount * 100_000 + total;
  const known = memo.get(key);
  if (known) return known;
  const cloud: ReachPoint[] = [];
  const leaves = leafCount > 1 ? [0, leafCount - 1] : [0];
  for (const leaf of leaves) {
    const unturnedY = unturnedLeafY(leaf, total);
    const turnedY = turnedLeafY(leaf);
    for (let step = 0; step <= THETA_STEPS; step += 1) {
      const theta = step / THETA_STEPS;
      hingeOffset(unturnedY, turnedY, theta, 1, hinge);
      for (const turnV of [1, -1]) {
        // The free edge at its head and tail (the bow is greatest there) and at its middle.
        for (const z of [-PAGE_H / 2, 0]) {
          leafPoint(PAGE_W, z, theta, turnV, edge);
          cloud.push({ x: hinge.x + edge.x, y: hinge.y + edge.y });
        }
      }
    }
  }
  const padded: ReachPoint[] = [];
  for (const p of convexHull(cloud)) {
    for (const side of [1, -1]) {
      for (const dx of [-REACH_MARGIN, REACH_MARGIN]) {
        for (const dy of [-REACH_MARGIN, REACH_MARGIN]) padded.push({ x: side * p.x + dx, y: p.y + dy });
      }
    }
  }
  const outline = convexHull(padded);
  memo.set(key, outline);
  return outline;
}
