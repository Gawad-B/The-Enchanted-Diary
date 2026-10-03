import { beforeEach, describe, expect, it } from 'vitest';
import { BookMotion, TURNED_THRESHOLD, Track } from '../../src/scene/book/bookMotion';
import {
  createLeafPlan,
  isAirborne,
  planLeaves,
  slotCountFor,
  turnBoundary,
} from '../../src/scene/book/leafPlan';

function run(motion: BookMotion, seconds: number, fps = 60): void {
  const steps = Math.round(seconds * fps);
  for (let i = 0; i < steps; i += 1) motion.update(1 / fps);
}

function make(options: Partial<ConstructorParameters<typeof BookMotion>[0]> = {}): BookMotion {
  return new BookMotion({ leafCount: 30, reducedMotion: false, maxAirborne: 5, ...options });
}

describe('Track', () => {
  it('tweens from the current value to the target and reports when it is done', () => {
    const track = new Track(0);
    track.go(1, 1, 0, 0);
    expect(track.update(0.5)).toBe(true);
    expect(track.value).toBeCloseTo(0.5, 5); // ease-in-out is symmetric about the middle
    expect(track.update(1)).toBe(false);
    expect(track.value).toBe(1);
  });

  it('waits out its delay without moving', () => {
    const track = new Track(0);
    track.go(1, 1, 2, 0);
    expect(track.update(1.9)).toBe(true);
    expect(track.value).toBe(0);
    expect(track.started(1.9)).toBe(false);
    expect(track.velocitySign(1.9)).toBe(0);
    track.update(2.5);
    expect(track.value).toBeGreaterThan(0);
    expect(track.velocitySign(2.5)).toBe(1);
  });

  it('retargeting mid-flight restarts from the current value (no jump)', () => {
    const track = new Track(0);
    track.go(1, 1, 0, 0);
    track.update(0.4);
    const before = track.value;
    track.go(0, 1, 0, 0.4);
    track.update(0.4);
    expect(track.value).toBeCloseTo(before, 6);
    expect(track.velocitySign(0.5)).toBe(-1);
  });

  it('going to where it already is does nothing', () => {
    const track = new Track(1);
    track.go(1, 1, 0, 0);
    expect(track.active).toBe(false);
  });
});

describe('BookMotion: cover', () => {
  it('opens in about 1.4 s and closes again', () => {
    const motion = make();
    expect(motion.setCoverOpen(true)).toBeCloseTo(1400, 0);
    run(motion, 0.7);
    expect(motion.cover.value).toBeGreaterThan(0.3);
    expect(motion.cover.value).toBeLessThan(0.7);
    run(motion, 0.8);
    expect(motion.cover.value).toBe(1);
    expect(motion.coverOpen).toBe(true);
    expect(motion.moving).toBe(false);
    motion.setCoverOpen(false);
    run(motion, 1.5);
    expect(motion.cover.value).toBe(0);
  });

  it('under reduced motion it takes 250 ms', () => {
    const motion = make({ reducedMotion: true });
    expect(motion.setCoverOpen(true)).toBe(250);
    run(motion, 0.3);
    expect(motion.cover.value).toBe(1);
  });

  it('reversing half way takes proportionally less time', () => {
    const motion = make();
    motion.setCoverOpen(true);
    run(motion, 0.7);
    const reverse = motion.setCoverOpen(false);
    expect(reverse).toBeLessThan(1400);
    expect(reverse).toBeGreaterThan(400);
  });

  it('asking for the pose it is in costs nothing', () => {
    expect(make().setCoverOpen(false)).toBe(0);
  });
});

describe('BookMotion: page turns', () => {
  let motion: BookMotion;
  beforeEach(() => {
    motion = make();
    motion.snap({ open: true, spread: 0 });
  });

  it('one page turn takes 900 ms and leaves leaf 0 turned', () => {
    expect(motion.setSpread(1)).toBe(900);
    run(motion, 0.45);
    expect(motion.thetas[0]).toBeGreaterThan(0.3);
    expect(motion.thetas[0]).toBeLessThan(0.7);
    expect(motion.turnSigns[0]).toBe(1);
    run(motion, 0.5);
    expect(motion.thetas[0]).toBe(1);
    expect(motion.turnSigns[0]).toBe(0);
    expect(motion.moving).toBe(false);
    expect(motion.spreadTarget).toBe(1);
  });

  it('turning back lifts the leaf off the left stack again', () => {
    motion.snap({ open: true, spread: 3 });
    motion.setSpread(2);
    run(motion, 0.3);
    expect(motion.turnSigns[2]).toBe(-1);
    run(motion, 0.8);
    expect(motion.thetas[2]).toBe(0);
    expect(motion.thetas[1]).toBe(1);
  });

  it('a long jump riffles through the leaves in order and never takes longer than 1.2 s', () => {
    const total = motion.setSpread(20);
    expect(total).toBeLessThanOrEqual(1200 + 1e-6);
    // Leaves start in order: at 30% of the time earlier leaves are further along than later ones.
    run(motion, (total / 1000) * 0.3);
    for (let index = 1; index < 20; index += 1) {
      expect(motion.thetas[index - 1]).toBeGreaterThanOrEqual(motion.thetas[index] ?? 0);
    }
    run(motion, (total / 1000) * 0.9);
    for (let index = 0; index < 20; index += 1) expect(motion.thetas[index], `leaf ${index}`).toBe(1);
    expect(motion.thetas[20]).toBe(0);
    expect(motion.moving).toBe(false);
  });

  it('at most maxAirborne leaves are in the air at once during a riffle', () => {
    const total = motion.setSpread(25);
    let peak = 0;
    for (let i = 0; i < Math.ceil((total / 1000) * 60) + 5; i += 1) {
      motion.update(1 / 60);
      let airborne = 0;
      for (let index = 0; index < motion.leafCount; index += 1)
        if (isAirborne(motion.thetas[index] ?? 0)) airborne += 1;
      peak = Math.max(peak, airborne);
    }
    expect(peak).toBeLessThanOrEqual(5 + 1);
    expect(peak).toBeGreaterThan(1);
  });

  it('a backward riffle turns the highest leaf first', () => {
    motion.snap({ open: true, spread: 12 });
    const total = motion.setSpread(2);
    run(motion, (total / 1000) * 0.3);
    expect(motion.thetas[11]).toBeLessThanOrEqual(motion.thetas[3] ?? 1);
    run(motion, (total / 1000) * 0.9);
    expect(motion.thetas[11]).toBe(0);
    expect(motion.thetas[1]).toBe(1);
    expect(motion.thetas[2]).toBe(0);
  });

  it('a new target in mid-turn continues from the current angles without jumping', () => {
    motion.setSpread(10);
    run(motion, 0.3);
    const snapshot = Array.from(motion.thetas.slice(0, 12));
    motion.setSpread(3);
    for (let index = 0; index < 12; index += 1) {
      // The first update after retargeting may move a leaf slightly, never by more than a frame's worth.
      expect(Math.abs((motion.thetas[index] ?? 0) - (snapshot[index] ?? 0))).toBeLessThan(1e-6);
    }
    motion.update(1 / 60);
    for (let index = 0; index < 12; index += 1) {
      expect(Math.abs((motion.thetas[index] ?? 0) - (snapshot[index] ?? 0))).toBeLessThan(0.2);
    }
    run(motion, 2);
    expect(motion.spreadTarget).toBe(3);
    for (let index = 0; index < 30; index += 1) expect(motion.thetas[index]).toBe(index < 3 ? 1 : 0);
  });

  it('reduced motion: one short flight, the leaves before it are set at once', () => {
    const reduced = make({ reducedMotion: true });
    reduced.snap({ open: true, spread: 0 });
    const total = reduced.setSpread(8);
    expect(total).toBeLessThanOrEqual(250);
    for (let index = 0; index < 7; index += 1) expect(reduced.thetas[index]).toBe(1);
    run(reduced, 0.3);
    expect(reduced.thetas[7]).toBe(1);
    expect(reduced.moving).toBe(false);
  });

  it('clamps the target to the leaves that exist', () => {
    motion.setSpread(999);
    run(motion, 3);
    expect(motion.spreadTarget).toBe(30);
    motion.setSpread(-5);
    run(motion, 3);
    expect(motion.spreadTarget).toBe(0);
  });

  it('snap sets a pose with no animation', () => {
    motion.snap({ open: true, spread: 4 });
    expect(motion.moving).toBe(false);
    expect(Array.from(motion.thetas.slice(0, 6))).toEqual([1, 1, 1, 1, 0, 0]);
    motion.snap({ open: false, spread: 4 });
    expect(motion.cover.value).toBe(0);
    expect(motion.thetas[0]).toBe(0); // a closed book has no turned leaves
  });

  it('a stalled frame cannot skip an animation', () => {
    motion.setSpread(1);
    motion.update(10);
    expect(motion.thetas[0]).toBeLessThan(0.5);
  });
});

describe('BookMotion: the flip (the diary turns itself over)', () => {
  it('turns a half turn in 1.5 s and returns to yaw 0 when committed', () => {
    const motion = make();
    expect(motion.startFlip()).toBe(1500);
    expect(motion.flipping).toBe(true);
    run(motion, 0.8);
    expect(motion.yaw.value).toBeGreaterThan(0.3);
    run(motion, 0.8);
    expect(motion.flipping).toBe(false);
    expect(motion.flipDone).toBe(true);
    motion.commitFlip();
    expect(motion.yaw.value).toBe(0);
    expect(motion.flipDone).toBe(false);
  });
});

describe('leaf plan', () => {
  it('the slot count covers both the resting window and the airborne leaves', () => {
    expect(slotCountFor(6, 5)).toBe(10);
    expect(slotCountFor(4, 4)).toBe(8);
    expect(slotCountFor(2, 3)).toBe(6);
  });

  function thetasFor(spread: number, leafCount = 40): Float32Array {
    return Float32Array.from({ length: leafCount }, (_, index) => (index < spread ? 1 : 0));
  }

  it('the boundary is the first leaf that is not turned', () => {
    expect(turnBoundary(thetasFor(0), 40)).toBe(0);
    expect(turnBoundary(thetasFor(7), 40)).toBe(7);
    expect(turnBoundary(thetasFor(40), 40)).toBe(40);
    expect(TURNED_THRESHOLD).toBe(0.5);
  });

  it('at rest the K leaves around the spread are real, the rest belong to the stacks', () => {
    const plan = createLeafPlan(10);
    planLeaves(thetasFor(10), 40, 6, plan);
    const shown = Array.from(plan.slotLeaf)
      .filter((leaf) => leaf >= 0)
      .sort((a, b) => a - b);
    expect(shown).toEqual([7, 8, 9, 10, 11, 12]);
    expect(plan.turnedStack).toBe(7);
    expect(plan.unturnedStack).toBe(40 - 6 - 7);
  });

  it('near the front of the book the window is clipped, never negative', () => {
    const plan = createLeafPlan(10);
    planLeaves(thetasFor(0), 40, 6, plan);
    const shown = Array.from(plan.slotLeaf)
      .filter((leaf) => leaf >= 0)
      .sort((a, b) => a - b);
    expect(shown).toEqual([0, 1, 2]);
    expect(plan.turnedStack).toBe(0);
    expect(plan.unturnedStack).toBe(37);
  });

  it('the low tier shows only the top of each stack', () => {
    const plan = createLeafPlan(slotCountFor(2, 3));
    planLeaves(thetasFor(5), 40, 2, plan);
    expect(
      Array.from(plan.slotLeaf)
        .filter((leaf) => leaf >= 0)
        .sort((a, b) => a - b),
    ).toEqual([4, 5]);
  });

  it('a leaf keeps its slot while it stays in the plan (index modulo the slot count)', () => {
    const plan = createLeafPlan(10);
    planLeaves(thetasFor(10), 40, 6, plan);
    expect(plan.slotLeaf[8]).toBe(8);
    planLeaves(thetasFor(11), 40, 6, plan);
    expect(plan.slotLeaf[8]).toBe(8);
    expect(plan.slotLeaf[7]).toBe(-1); // leaf 7 left the window
    expect(plan.slotLeaf[3]).toBe(13);
  });

  it('leaves in the air always get a slot, and the stack counts exclude them', () => {
    const thetas = thetasFor(10);
    thetas[10] = 0.4;
    thetas[11] = 0.1;
    thetas[9] = 0.9;
    const plan = createLeafPlan(10);
    planLeaves(thetas, 40, 2, plan);
    const shown = Array.from(plan.slotLeaf).filter((leaf) => leaf >= 0);
    expect(shown).toEqual(expect.arrayContaining([9, 10, 11]));
    expect(plan.turnedStack + plan.unturnedStack + shown.length).toBe(40);
  });

  it('every leaf is accounted for exactly once during a whole riffle', () => {
    const motion = make({ leafCount: 60 });
    motion.snap({ open: true, spread: 0 });
    motion.setSpread(40);
    const plan = createLeafPlan(slotCountFor(6, 5));
    for (let frame = 0; frame < 120; frame += 1) {
      motion.update(1 / 60);
      planLeaves(motion.thetas, 60, 6, plan);
      const shown = Array.from(plan.slotLeaf).filter((leaf) => leaf >= 0);
      expect(new Set(shown).size).toBe(shown.length);
      expect(shown.length + plan.turnedStack + plan.unturnedStack).toBe(60);
      // Every airborne leaf is drawn.
      for (let index = 0; index < 60; index += 1) {
        if (isAirborne(motion.thetas[index] ?? 0)) expect(shown).toContain(index);
      }
    }
  });
});
