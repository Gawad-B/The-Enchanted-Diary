import { beforeEach, describe, expect, it } from 'vitest';
import {
  MAX_REVEAL_ZOOM,
  MAX_REVEAL_ZOOM_RATE,
  resetRevealZoom,
  revealZoom,
  setRevealZoom,
  zoomedFov,
} from '../../src/scene/revealZoom';

beforeEach(resetRevealZoom);

describe('the reveal camera zoom (one clamp)', () => {
  it('never exceeds the maximum, however hard it is asked', () => {
    for (let frame = 0; frame < 600; frame += 1) setRevealZoom(5, 16);
    expect(revealZoom.value).toBeCloseTo(MAX_REVEAL_ZOOM);
    expect(zoomedFov(38, revealZoom.value)).toBeCloseTo(38 * (1 - MAX_REVEAL_ZOOM));
  });

  it('never moves faster than the rate limit, in or out', () => {
    const step = setRevealZoom(1, 100);
    expect(step).toBeCloseTo(MAX_REVEAL_ZOOM_RATE * 0.1);
    for (let frame = 0; frame < 100; frame += 1) setRevealZoom(1, 16);
    const before = revealZoom.value;
    setRevealZoom(0, 50);
    expect(before - revealZoom.value).toBeCloseTo(MAX_REVEAL_ZOOM_RATE * 0.05);
  });

  it('ignores a nonsense target and a negative step', () => {
    setRevealZoom(Number.NaN, 16);
    setRevealZoom(1, -50);
    expect(revealZoom.value).toBe(0);
  });
});
