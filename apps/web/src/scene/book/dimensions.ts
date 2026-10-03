/**
 * Physical dimensions of the diary in scene units (1 unit = 10 cm). The table top is y = 0 and the book lies
 * on it. The spine (hinge) axis is at book-local x = 0 and runs along z, the page height.
 */

/** Width of a leaf from the spine to the fore-edge (15 cm). */
export const PAGE_W = 1.5;
/** Height of a leaf, head to tail (21 cm). */
export const PAGE_H = 2.1;
/** Thickness of a cover board (4 mm). */
export const BOARD_T = 0.04;
/** How far the boards stand proud of the leaves at the fore-edge, head and tail. */
export const BOARD_OVERHANG = 0.07;
/** Height of the top plane of the base level, where the leaves rest. */
export const BASE_Y = BOARD_T;
/** Thickness a leaf adds to a stack. */
export const LEAF_T = 0.0025;
/** The page block is always this many leaves thick, or the real leaf count plus the margin if that is more. */
export const MIN_VIRTUAL_LEAVES = 120;
export const VIRTUAL_LEAF_MARGIN = 20;
/**
 * Both stacks of an open book slope down into a common valley at the spine. The slope lasts this far from
 * the spine; the valley's height is a little above the board, plus this fraction of the thinner stack.
 */
export const GUTTER_LENGTH = 0.8;
export const VALLEY_CLEARANCE = 0.004;
export const VALLEY_FRACTION = 0.25;

/** Height of the valley at the spine for stacks of the given heights (scene units above the table). */
export function valleyHeight(turnedHeight: number, unturnedHeight: number): number {
  return BASE_Y + VALLEY_CLEARANCE + VALLEY_FRACTION * Math.min(turnedHeight, unturnedHeight);
}

/** The constant virtual leaf total the stacks' thickness is measured against. */
export function virtualLeafTotal(leafCount: number): number {
  return Math.max(MIN_VIRTUAL_LEAVES, leafCount + VIRTUAL_LEAF_MARGIN);
}

/** y of leaf `index` lying unturned (on the unturned stack) in a block of `total` leaves. */
export function unturnedLeafY(index: number, total: number): number {
  return BASE_Y + (total - index) * LEAF_T;
}

/** y of leaf `index` lying turned (on the turned stack). */
export function turnedLeafY(index: number): number {
  return BASE_Y + (index + 1) * LEAF_T;
}

/** Thickness of the whole page block. */
export function blockThickness(total: number): number {
  return total * LEAF_T;
}

/** How far the rounded spine of a closed book bulges out past the hinge line. */
export function spineBulge(total: number): number {
  return blockThickness(total) / 2 + BOARD_T;
}

/** Footprint of the closed book, centred on its own middle (spine included). */
export function closedFootprint(total: number): { width: number; depth: number; height: number } {
  return {
    width: PAGE_W + BOARD_OVERHANG + spineBulge(total),
    depth: PAGE_H + 2 * BOARD_OVERHANG,
    height: 2 * BOARD_T + blockThickness(total),
  };
}

/** x of the middle of the closed book relative to the spine (towards the fore-edge). */
export function closedCenterX(total: number): number {
  return (PAGE_W + BOARD_OVERHANG - spineBulge(total)) / 2;
}

/** Footprint of the open book (both boards), centred on the gutter. */
export function openFootprint(): { width: number; depth: number; height: number } {
  return { width: 2 * (PAGE_W + BOARD_OVERHANG), depth: PAGE_H + 2 * BOARD_OVERHANG, height: 0.35 };
}
