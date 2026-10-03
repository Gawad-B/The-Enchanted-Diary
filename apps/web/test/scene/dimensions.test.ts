import { describe, expect, it } from 'vitest';
import {
  BASE_Y,
  LEAF_T,
  MIN_VIRTUAL_LEAVES,
  blockThickness,
  closedCenterX,
  closedFootprint,
  openFootprint,
  spineBulge,
  turnedLeafY,
  unturnedLeafY,
  valleyHeight,
  virtualLeafTotal,
} from '../../src/scene/book/dimensions';

describe('the physical book', () => {
  it('the virtual leaf total is max(120, leaves + 20)', () => {
    expect(virtualLeafTotal(1)).toBe(MIN_VIRTUAL_LEAVES);
    expect(virtualLeafTotal(100)).toBe(120);
    expect(virtualLeafTotal(101)).toBe(121);
    expect(virtualLeafTotal(151)).toBe(171);
  });

  it('consecutive leaves are exactly one leaf thickness apart, in both stacks', () => {
    const total = 120;
    for (let leaf = 0; leaf < 20; leaf += 1) {
      expect(unturnedLeafY(leaf, total) - unturnedLeafY(leaf + 1, total)).toBeCloseTo(LEAF_T);
      expect(turnedLeafY(leaf + 1) - turnedLeafY(leaf)).toBeCloseTo(LEAF_T);
    }
  });

  it('the first unturned leaf lies on top of the whole block, the last on the board', () => {
    expect(unturnedLeafY(0, 120)).toBeCloseTo(BASE_Y + blockThickness(120));
    expect(unturnedLeafY(119, 120)).toBeCloseTo(BASE_Y + LEAF_T);
    expect(turnedLeafY(0)).toBeCloseTo(BASE_Y + LEAF_T);
  });

  it('the closed footprint covers the spine bulge, the boards and the block', () => {
    const footprint = closedFootprint(120);
    expect(footprint.height).toBeGreaterThan(blockThickness(120));
    expect(footprint.width).toBeGreaterThan(1.5);
    expect(openFootprint().width).toBeGreaterThan(2 * 1.5);
    expect(closedCenterX(120)).toBeGreaterThan(0.5);
    expect(spineBulge(120)).toBeGreaterThan(blockThickness(120) / 2);
  });

  it('the valley between two stacks sits just above the board, higher as the thinner stack thickens', () => {
    expect(valleyHeight(0, 0.3)).toBeGreaterThan(BASE_Y);
    expect(valleyHeight(0.1, 0.2)).toBeGreaterThan(valleyHeight(0.05, 0.25));
    expect(valleyHeight(0.2, 0.1)).toBe(valleyHeight(0.1, 0.2));
  });
});
