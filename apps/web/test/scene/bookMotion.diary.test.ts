import { describe, expect, it } from 'vitest';
import { BookMotion } from '../../src/scene/book/bookMotion';

const motion = (leafCount = 5, capacity = 12): BookMotion =>
  new BookMotion({ leafCount, capacity, reducedMotion: false, maxAirborne: 4 });

const thetas = (m: BookMotion): number[] => Array.from(m.thetas.slice(0, m.leafCount));

describe('diary leaves bound into a book that is standing still', () => {
  it('a turned leaf inserted at the front changes nothing that is seen: the others keep their angles, one place along', () => {
    const m = motion(5);
    m.snap({ open: true, spread: 2 }); // leaves 0 and 1 turned
    expect(thetas(m)).toEqual([1, 1, 0, 0, 0]);
    m.insertLeaf(0, true);
    expect(m.leafCount).toBe(6);
    expect(thetas(m)).toEqual([1, 1, 1, 0, 0, 0]);
    expect(m.spreadTarget).toBe(3); // the reader is still at the same page: one more leaf is turned
  });

  it('a leaf inserted unturned after the turned ones lies under the turned stack, ready to be turned', () => {
    const m = motion(5);
    m.snap({ open: true, spread: 2 });
    m.insertLeaf(2, false);
    expect(thetas(m)).toEqual([1, 1, 0, 0, 0, 0]);
    expect(m.spreadTarget).toBe(2);
  });

  it('the shifted leaves are at rest: nothing starts to move', () => {
    const m = motion(5);
    m.snap({ open: true, spread: 3 });
    m.insertLeaf(1, true);
    expect(m.moving).toBe(false);
    m.update(1);
    expect(thetas(m)).toEqual([1, 1, 1, 1, 0, 0]);
  });

  it('is limited by the capacity (the arrays are sized once)', () => {
    const m = motion(5, 6);
    m.insertLeaf(0, true);
    expect(m.leafCount).toBe(6);
    expect(m.insertLeaf(0, true)).toBe(false);
    expect(m.leafCount).toBe(6);
  });

  it('a leaf taken out of the turned stack is let go without a change to what is seen', () => {
    const m = motion(6);
    m.snap({ open: true, spread: 4 });
    expect(m.removeLeaf(0)).toBe(true);
    expect(m.leafCount).toBe(5);
    expect(thetas(m)).toEqual([1, 1, 1, 0, 0]);
    expect(m.spreadTarget).toBe(3);
  });

  it('a leaf in the air is not touched: the change is refused', () => {
    const m = motion(6);
    m.snap({ open: true, spread: 1 });
    m.setSpread(2);
    m.update(0.1);
    expect(m.turning).toBe(true);
    expect(m.insertLeaf(0, true)).toBe(false);
    expect(m.removeLeaf(0)).toBe(false);
  });
});
