import { describe, expect, it } from 'vitest';
import { DURATIONS, duration, turnTiming } from '../../src/motion/durations';

describe('duration tokens', () => {
  it('a page turn takes about 900 ms, and 250 ms under reduced motion', () => {
    expect(duration('pageTurn', false)).toBe(900);
    expect(duration('pageTurn', true)).toBe(250);
  });

  it('every reduced duration is at most 250 ms, except the texture wait which only bounds a wait', () => {
    for (const [name, token] of Object.entries(DURATIONS)) {
      if (name === 'textureWait') continue;
      expect(token.reduced, name).toBeLessThanOrEqual(250);
      expect(token.reduced, name).toBeLessThanOrEqual(token.normal);
    }
  });

  it('the texture wait stays inside the unveiling watchdog (1.5 s normal, 1.5 s reduced) with room to spare', () => {
    expect(duration('textureWait', false)).toBeLessThanOrEqual(1500);
    expect(duration('textureWait', true)).toBeLessThan(1500);
  });
});

describe('turnTiming (riffles)', () => {
  it('turning nothing takes no time', () => {
    expect(turnTiming(0, false)).toEqual({ flightMs: 0, staggerMs: 0, totalMs: 0 });
  });

  it('a single leaf takes exactly the page-turn duration', () => {
    expect(turnTiming(1, false)).toEqual({ flightMs: 900, staggerMs: 0, totalMs: 900 });
  });

  it('a few leaves overlap and stay within the 1.2 s cap', () => {
    const timing = turnTiming(3, false);
    expect(timing.staggerMs).toBeGreaterThan(0);
    expect(timing.totalMs).toBeGreaterThan(900 * 0.7);
    expect(timing.totalMs).toBeLessThanOrEqual(1200);
  });

  it('however far the jump, the total never exceeds 1.2 s', () => {
    for (const leaves of [2, 3, 5, 6, 10, 20, 60, 150, 400]) {
      expect(turnTiming(leaves, false).totalMs, `${leaves} leaves`).toBeLessThanOrEqual(1200 + 1e-6);
    }
  });

  it('a long riffle shortens each flight so that no more than five leaves are in the air', () => {
    for (const leaves of [6, 10, 40, 150]) {
      const { flightMs, staggerMs } = turnTiming(leaves, false);
      expect(flightMs / staggerMs, `${leaves} leaves`).toBeLessThanOrEqual(5 + 1e-6);
    }
  });

  it('the airborne limit follows the tier', () => {
    const three = turnTiming(40, false, 3);
    expect(three.flightMs / three.staggerMs).toBeLessThanOrEqual(3 + 1e-6);
  });

  it('under reduced motion any number of leaves takes one short flight of at most 250 ms', () => {
    for (const leaves of [1, 2, 30]) {
      const timing = turnTiming(leaves, true);
      expect(timing.totalMs).toBeLessThanOrEqual(250);
      expect(timing.staggerMs).toBe(0);
    }
  });
});
