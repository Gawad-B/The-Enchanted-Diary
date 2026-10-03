import { TURNED_THRESHOLD } from './bookMotion';

/*
 * Which leaves are real meshes. Only the leaves around the current spread (plus any in the air) get a slot;
 * every other leaf is represented by the two page-block stacks, whose thickness is the number of leaves they
 * stand for. A leaf keeps the slot `index % slotCount`, so while it stays in the plan its mesh and material
 * never change hands.
 */

export interface LeafPlan {
  readonly slotCount: number;
  /** Leaf index shown by each slot, or -1 for an empty slot. */
  readonly slotLeaf: Int16Array;
  /** Leaves with no slot that are turned (they sit in the turned stack). */
  turnedStack: number;
  /** Leaves with no slot that are not turned (the unturned stack, before the filler leaves). */
  unturnedStack: number;
}

/** Slots needed for `animatedLeaves` at rest plus `maxAirborne` leaves in a riffle, all within one window. */
export function slotCountFor(animatedLeaves: number, maxAirborne: number): number {
  return Math.max(animatedLeaves, 2 * maxAirborne);
}

export function createLeafPlan(slotCount: number): LeafPlan {
  return { slotCount, slotLeaf: new Int16Array(slotCount).fill(-1), turnedStack: 0, unturnedStack: 0 };
}

const AIRBORNE_EPSILON = 1e-4;

export function isAirborne(theta: number): boolean {
  return theta > AIRBORNE_EPSILON && theta < 1 - AIRBORNE_EPSILON;
}

/** Index of the first leaf that is not turned: the boundary between the two stacks. */
export function turnBoundary(thetas: ArrayLike<number>, leafCount: number): number {
  for (let index = 0; index < leafCount; index += 1) {
    if ((thetas[index] ?? 0) < TURNED_THRESHOLD) return index;
  }
  return leafCount;
}

/** Fills `plan` for the current leaf angles. Allocation-free. */
export function planLeaves(
  thetas: ArrayLike<number>,
  leafCount: number,
  animatedLeaves: number,
  plan: LeafPlan,
): void {
  const { slotLeaf, slotCount } = plan;
  slotLeaf.fill(-1);
  const place = (index: number): void => {
    if (index < 0 || index >= leafCount) return;
    const slot = index % slotCount;
    if (slotLeaf[slot] === -1) slotLeaf[slot] = index;
  };

  const boundary = turnBoundary(thetas, leafCount);
  // Leaves in the air first: they must be drawn.
  for (let index = 0; index < leafCount; index += 1) {
    if (isAirborne(thetas[index] ?? 0)) place(index);
  }
  // Then the window around the boundary, nearest leaves first (the tops of the two stacks are what is visible).
  const half = Math.floor(animatedLeaves / 2);
  for (let distance = 0; distance < half; distance += 1) {
    place(boundary + distance);
    place(boundary - 1 - distance);
  }

  let turned = 0;
  let unturned = 0;
  for (let index = 0; index < leafCount; index += 1) {
    if (slotLeaf[index % slotCount] === index) continue;
    if ((thetas[index] ?? 0) >= TURNED_THRESHOLD) turned += 1;
    else unturned += 1;
  }
  plan.turnedStack = turned;
  plan.unturnedStack = unturned;
}
