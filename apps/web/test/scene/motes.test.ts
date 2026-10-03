import { describe, expect, it } from 'vitest';
import { MAX_VISIBLE_MOTES, MOTE_SIZE, visibleFraction } from '../../src/scene/motes';

describe('the motes that rise from the page edges', () => {
  it("a handful at rest and never more than about twenty even at full glow, whatever the tier's count", () => {
    for (const count of [30, 60, 120]) {
      const resting = visibleFraction(count, 0) * count;
      const glowing = visibleFraction(count, 1) * count;
      expect(resting).toBeGreaterThanOrEqual(1.5);
      expect(resting).toBeLessThan(4);
      expect(glowing).toBeLessThanOrEqual(MAX_VISIBLE_MOTES + 1e-9);
      expect(glowing).toBeGreaterThan(resting);
    }
  });

  it('grows monotonically with the glow and stays a fraction', () => {
    let previous = 0;
    for (let glow = 0; glow <= 1.0001; glow += 0.1) {
      const fraction = visibleFraction(60, glow);
      expect(fraction).toBeGreaterThanOrEqual(previous);
      expect(fraction).toBeLessThanOrEqual(1);
      previous = fraction;
    }
    expect(visibleFraction(0, 1)).toBe(0);
  });

  it('are tiny: 0.6 to 1.5 mm across (units of 10 cm), not orbs', () => {
    expect(MOTE_SIZE.min).toBeGreaterThanOrEqual(0.006);
    expect(MOTE_SIZE.max).toBeLessThanOrEqual(0.015);
  });
});
