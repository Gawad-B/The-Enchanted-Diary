import type { Direction } from '@enchanted/shared';
import { beforeEach, describe, expect, it } from 'vitest';
import { doneEventFor, type ExperienceEvent, type Phase } from '../../src/state/experience';
import { BookMotion } from '../../src/scene/book/bookMotion';
import {
  INITIAL_SETTLE_SECONDS,
  initialPoseFor,
  PhaseRunner,
  midSpread,
  stepsFor,
  type PresenterEnv,
} from '../../src/scene/book/phaseRunner';

interface Harness {
  motion: BookMotion;
  env: PresenterEnv;
  emitted: ExperienceEvent[];
  state: { layout: Direction; desired: Direction; readerSpread: number; texturesReady: boolean };
}

function harness(reducedMotion = false): Harness {
  const motion = new BookMotion({ leafCount: 30, reducedMotion, maxAirborne: 5 });
  const emitted: ExperienceEvent[] = [];
  const state = {
    layout: 'ltr' as Direction,
    desired: 'ltr' as Direction,
    readerSpread: 0,
    texturesReady: true,
  };
  const env: PresenterEnv = {
    motion,
    layoutDirection: () => state.layout,
    setLayoutDirection: (direction) => {
      state.layout = direction;
    },
    desiredDirection: () => state.desired,
    readerSpread: () => state.readerSpread,
    pageTexturesReady: () => state.texturesReady,
    emit: (event) => {
      emitted.push(event);
    },
  };
  return { motion, env, emitted, state };
}

/** Runs a runner for `seconds` at 60 fps. */
function play(h: Harness, runner: PhaseRunner, seconds: number): void {
  for (let i = 0; i < Math.round(seconds * 60); i += 1) {
    runner.tick();
    h.motion.update(1 / 60);
  }
}

/** Lets the motion clock run past the initial settle window, so layout changes animate. */
function age(target: Harness, seconds = INITIAL_SETTLE_SECONDS + 0.5): void {
  for (let elapsed = 0; elapsed < seconds; elapsed += 0.25) target.motion.update(0.25);
}

let h: Harness;
beforeEach(() => {
  h = harness();
});

describe('the closed book phases', () => {
  it('discovery (the welcome) lies open and leafs through the book slowly, for ever, one leaf at a time, and emits nothing', () => {
    h.motion.snap({ open: false, spread: 0 });
    const runner = new PhaseRunner('discovery', 1, h.env);
    const seen = new Set<number>();
    for (let i = 0; i < 60 * 20; i += 1) {
      runner.tick();
      h.motion.update(1 / 60);
      seen.add(h.motion.spreadTarget);
    }
    expect(h.motion.cover.value).toBe(1);
    expect(Math.max(...seen)).toBeGreaterThanOrEqual(4); // it goes up through the first leaves...
    expect(seen.has(0)).toBe(true); // ...and comes back
    expect(runner.finished).toBe(false);
    expect(h.emitted).toEqual([]);
  });

  it('reading keeps the cover OPEN (no close after the upload) on the middle page, and emits nothing', () => {
    h.motion.snap({ open: true, spread: midSpread(h.motion.leafCount) });
    const runner = new PhaseRunner('reading', 4, h.env);
    for (let i = 0; i < 60 * 3; i += 1) {
      runner.tick();
      h.motion.update(1 / 60);
      expect(h.motion.cover.value, `frame ${String(i)}`).toBe(1);
    }
    expect(h.motion.spreadTarget).toBe(midSpread(h.motion.leafCount));
    expect(h.emitted).toEqual([]);
  });
});

describe('opening', () => {
  it('opens the cover and emits OPEN_DONE once, with the epoch it started in', () => {
    const runner = new PhaseRunner('opening', 7, h.env);
    play(h, runner, 0.5);
    expect(h.emitted).toEqual([]);
    play(h, runner, 9);
    expect(h.emitted).toEqual([{ type: 'OPEN_DONE', epoch: 7 }]);
    play(h, runner, 2);
    expect(h.emitted).toHaveLength(1);
    expect(h.motion.cover.value).toBe(1);
  });

  it('plays the long riffle of the welcome (about 6 s, "like the movie") and stops on a page in the MIDDLE of the book (never the first), inside the 9 s watchdog', () => {
    const runner = new PhaseRunner('opening', 1, h.env);
    let frames = 0;
    while (h.emitted.length === 0 && frames < 600) {
      runner.tick();
      h.motion.update(1 / 60);
      frames += 1;
    }
    expect(frames / 60).toBeGreaterThan(3.5);
    expect(frames / 60).toBeLessThan(8);
    expect(h.motion.spreadTarget).toBe(midSpread(h.motion.leafCount));
  });

  it('under reduced motion the riffle is short and it finishes well inside the reduced watchdog', () => {
    const reduced = harness(true);
    const runner = new PhaseRunner('opening', 1, reduced.env);
    play(reduced, runner, 1.4);
    expect(reduced.emitted).toEqual([{ type: 'OPEN_DONE', epoch: 1 }]);
  });
});

describe('awaiting and uploading', () => {
  it('awaiting opens the book at a page in the middle, without any DONE event (a failed upload reopens it there)', () => {
    const runner = new PhaseRunner('awaiting', 9, h.env);
    play(h, runner, 2);
    expect(h.motion.cover.value).toBe(1);
    expect(h.motion.spreadTarget).toBe(midSpread(h.motion.leafCount));
    expect(h.emitted).toEqual([]);
  });

  it('uploading keeps the book open', () => {
    h.motion.snap({ open: true, spread: 0 });
    const runner = new PhaseRunner('uploading', 2, h.env);
    play(h, runner, 1);
    expect(h.motion.cover.value).toBe(1);
  });
});

describe('unveiling', () => {
  // The shared layer (readerSync) puts the reader on spread 1 as unveiling begins; the runner turns to it.
  beforeEach(() => {
    h.state.readerSpread = 1;
  });

  it('opens the cover, waits for page 1 and 2 textures, turns the flyleaf and emits UNVEIL_DONE', () => {
    const runner = new PhaseRunner('unveiling', 11, h.env);
    play(h, runner, 1);
    expect(h.emitted).toEqual([]);
    play(h, runner, 2.5);
    expect(h.emitted).toEqual([{ type: 'UNVEIL_DONE', epoch: 11 }]);
    expect(h.motion.thetas[0]).toBe(1);
    expect(h.motion.spreadTarget).toBe(1);
  });

  it('does not turn the flyleaf before the textures are ready, but never waits longer than 1.5 s', () => {
    h.state.texturesReady = false;
    const runner = new PhaseRunner('unveiling', 11, h.env);
    play(h, runner, 1.4); // cover open
    play(h, runner, 1.0);
    expect(h.motion.thetas[0]).toBe(0);
    expect(h.emitted).toEqual([]);
    play(h, runner, 0.8); // the wait runs out
    expect(h.motion.thetas[0]).toBeGreaterThan(0);
    play(h, runner, 1.2);
    expect(h.emitted).toEqual([{ type: 'UNVEIL_DONE', epoch: 11 }]);
  });

  it('turns as soon as the textures arrive', () => {
    h.state.texturesReady = false;
    const runner = new PhaseRunner('unveiling', 11, h.env);
    play(h, runner, 1.6);
    h.state.texturesReady = true;
    play(h, runner, 0.2);
    expect(h.motion.thetas[0]).toBeGreaterThan(0);
  });

  it('turns to the spread the reader is at, whatever it is (a restored session may not start at page 1)', () => {
    h.state.readerSpread = 4;
    const runner = new PhaseRunner('unveiling', 11, h.env);
    play(h, runner, 6);
    expect(h.motion.spreadTarget).toBe(4);
    expect(h.emitted).toEqual([{ type: 'UNVEIL_DONE', epoch: 11 }]);
  });

  it('a book that is still closing with the wrong layout finishes closing, flips over, and only then opens', () => {
    age(h);
    h.motion.snap({ open: true, spread: 0 });
    h.motion.setCoverOpen(false); // the reading phase was closing it
    h.state.desired = 'rtl';
    let minCover = 1;
    let layoutWhenReopening: Direction | null = null;
    const runner = new PhaseRunner('unveiling', 3, h.env);
    for (let frame = 0; frame < 60 * 12 && h.emitted.length === 0; frame += 1) {
      runner.tick();
      h.motion.update(1 / 60);
      minCover = Math.min(minCover, h.motion.cover.value);
      if (layoutWhenReopening === null && minCover === 0 && h.motion.cover.value > 0.01) {
        layoutWhenReopening = h.state.layout;
      }
    }
    expect(minCover).toBe(0);
    expect(layoutWhenReopening).toBe('rtl');
    expect(h.state.layout).toBe('rtl');
    expect(h.emitted).toEqual([{ type: 'UNVEIL_DONE', epoch: 3 }]);
  });

  it('a fully open book with the wrong layout is closed first, flipped, and opened again', () => {
    age(h);
    h.motion.snap({ open: true, spread: 0 });
    h.state.desired = 'rtl';
    let minCover = 1;
    const runner = new PhaseRunner('unveiling', 3, h.env);
    for (let frame = 0; frame < 60 * 12 && h.emitted.length === 0; frame += 1) {
      runner.tick();
      h.motion.update(1 / 60);
      minCover = Math.min(minCover, h.motion.cover.value);
    }
    expect(minCover).toBe(0);
    expect(h.state.layout).toBe('rtl');
    expect(h.motion.cover.value).toBe(1);
  });

  it('the whole thing fits inside the 9.5 s watchdog, with or without a flip', () => {
    age(h);
    h.state.texturesReady = false;
    h.state.desired = 'rtl';
    const runner = new PhaseRunner('unveiling', 3, h.env);
    let frames = 0;
    while (h.emitted.length === 0 && frames < 60 * 12) {
      runner.tick();
      h.motion.update(1 / 60);
      frames += 1;
    }
    expect(frames / 60).toBeLessThan(9.5);
    expect(h.state.layout).toBe('rtl');
  });
});

describe('the direction flip', () => {
  it('a closed book whose desired direction differs turns itself over, then swaps the layout', () => {
    age(h);
    h.state.desired = 'rtl';
    const runner = new PhaseRunner('reading', 5, h.env);
    play(h, runner, 0.3);
    expect(h.state.layout).toBe('ltr');
    expect(h.motion.flipping).toBe(true);
    play(h, runner, 1.6);
    expect(h.state.layout).toBe('rtl');
    expect(h.motion.yaw.value).toBe(0); // committed: the swap is invisible
  });

  it('in reading an open book is not closed to flip it (the unveiling closes it only if the layout is wrong)', () => {
    age(h);
    h.motion.snap({ open: true, spread: midSpread(h.motion.leafCount) });
    const runner = new PhaseRunner('reading', 5, h.env);
    play(h, runner, 2);
    h.state.desired = 'rtl';
    play(h, runner, 2);
    expect(h.state.layout).toBe('ltr');
    expect(h.motion.cover.value).toBe(1);
  });

  it('opening and awaiting wait for a cover that is closing, and flip once it is shut', () => {
    for (const phase of ['opening', 'awaiting', 'uploading'] as const) {
      const local = harness();
      age(local);
      local.motion.snap({ open: true, spread: 0 });
      local.motion.setCoverOpen(false);
      local.state.desired = 'rtl';
      const runner = new PhaseRunner(phase, 1, local.env);
      let minCover = 1;
      for (let frame = 0; frame < 60 * 8; frame += 1) {
        runner.tick();
        local.motion.update(1 / 60);
        minCover = Math.min(minCover, local.motion.cover.value);
      }
      expect(minCover, phase).toBe(0);
      expect(local.state.layout, phase).toBe('rtl');
    }
  });

  it('awaiting with the book open keeps its layout when only the interface direction changes', () => {
    age(h);
    h.motion.snap({ open: true, spread: 0 });
    h.state.desired = 'rtl';
    const runner = new PhaseRunner('awaiting', 1, h.env);
    play(h, runner, 3);
    expect(h.state.layout).toBe('ltr');
    expect(h.motion.cover.value).toBe(1);
  });

  it('an open book never flips: it keeps its layout until it is closed', () => {
    h.motion.snap({ open: true, spread: 0 });
    h.state.desired = 'rtl';
    const runner = new PhaseRunner('manuscript', 1, h.env);
    play(h, runner, 3);
    expect(h.state.layout).toBe('ltr');
    expect(h.motion.flipping).toBe(false);
  });

  it('right after the scene mounts the layout swaps invisibly (a restored session must not visibly turn the book)', () => {
    h.state.desired = 'rtl';
    const runner = new PhaseRunner('discovery', 1, h.env);
    play(h, runner, 0.2);
    expect(h.state.layout).toBe('rtl');
    expect(h.motion.flipping).toBe(false);
  });

  it('under reduced motion the layout swaps at once while closed', () => {
    const reduced = harness(true);
    reduced.state.desired = 'rtl';
    const runner = new PhaseRunner('discovery', 1, reduced.env);
    play(reduced, runner, 0.1);
    expect(reduced.state.layout).toBe('rtl');
    expect(reduced.motion.flipping).toBe(false);
  });

  it('a book that already has the right direction does not flip', () => {
    const runner = new PhaseRunner('discovery', 1, h.env);
    play(h, runner, 2);
    expect(h.motion.flipping).toBe(false);
  });
});

describe('a turn-over that is already under way when the phase changes', () => {
  /** A diary that was turning over (towards RTL) when the old phase's runner went away. */
  function turningOver(): Harness {
    const local = harness();
    age(local);
    local.motion.startFlip();
    for (let i = 0; i < 40; i += 1) local.motion.update(1 / 60);
    expect(local.motion.yaw.active).toBe(true);
    expect(local.motion.yaw.value).toBeGreaterThan(0.1);
    return local;
  }

  const PHASES_WITHOUT_A_DIRECTION_STEP = ['closing', 'manuscript', 'memory', 'revealing'] as const;
  const PHASES_WITH_ONE = ['discovery', 'opening', 'awaiting', 'uploading', 'reading'] as const;

  it('is finished by the new phase: never left half turned, whatever the phase', () => {
    for (const phase of [...PHASES_WITHOUT_A_DIRECTION_STEP, ...PHASES_WITH_ONE, 'unveiling'] as const) {
      const local = turningOver();
      const runner = new PhaseRunner(phase, 9, local.env, { inheritedFlip: true });
      play(local, runner, 8);
      expect(local.motion.yaw.value, phase).toBe(0);
      expect(local.motion.flipping, phase).toBe(false);
    }
  });

  it('commits the OPPOSITE layout, which is what the half turn showed, so nothing pops', () => {
    for (const phase of PHASES_WITHOUT_A_DIRECTION_STEP) {
      const local = turningOver();
      expect(local.state.layout).toBe('ltr');
      const runner = new PhaseRunner(phase, 9, local.env, { inheritedFlip: true });
      play(local, runner, 4);
      expect(local.state.layout, phase).toBe('rtl');
    }
  });

  it('then lets the phase put the layout where it belongs (a closed book flips back; an open one waits)', () => {
    const closed = turningOver();
    const runner = new PhaseRunner('discovery', 9, closed.env, { inheritedFlip: true });
    play(closed, runner, 8);
    expect(closed.state.layout).toBe('ltr'); // desired is ltr: flipped over, committed rtl, flipped back
    expect(closed.motion.yaw.value).toBe(0);
  });

  it('adopts the flip in flight: it carries on at its own speed instead of starting over', () => {
    const local = turningOver();
    const before = local.motion.yaw.value;
    const runner = new PhaseRunner('discovery', 9, local.env, { inheritedFlip: true });
    play(local, runner, 0.1);
    expect(local.motion.yaw.value - before).toBeGreaterThan(0.04);
  });

  it('a book that is not turning over is untouched by the extra step', () => {
    const local = harness();
    const runner = new PhaseRunner('awaiting', 9, local.env);
    play(local, runner, 3);
    expect(local.state.layout).toBe('ltr');
    expect(local.motion.cover.value).toBe(1);
  });
});

describe('manuscript', () => {
  it('opens and follows the reader spread, turning pages when it changes', () => {
    h.state.readerSpread = 2;
    const runner = new PhaseRunner('manuscript', 2, h.env);
    play(h, runner, 3);
    expect(h.motion.spreadTarget).toBe(2);
    expect(h.motion.thetas[0]).toBe(1);
    expect(h.motion.thetas[1]).toBe(1);
    h.state.readerSpread = 8;
    play(h, runner, 2);
    expect(h.motion.spreadTarget).toBe(8);
    expect(h.motion.thetas[7]).toBe(1);
    h.state.readerSpread = 3;
    play(h, runner, 2);
    expect(h.motion.thetas[3]).toBe(0);
    expect(h.motion.thetas[2]).toBe(1);
  });

  it('emits nothing', () => {
    const runner = new PhaseRunner('manuscript', 2, h.env);
    play(h, runner, 3);
    expect(h.emitted).toEqual([]);
  });
});

describe('closing', () => {
  it('settles the pages, closes the cover and emits CLOSE_DONE once, inside the 4 s watchdog', () => {
    h.motion.snap({ open: true, spread: 12 });
    const runner = new PhaseRunner('closing', 20, h.env);
    let frames = 0;
    while (h.emitted.length === 0 && frames < 60 * 6) {
      runner.tick();
      h.motion.update(1 / 60);
      frames += 1;
    }
    expect(h.emitted).toEqual([{ type: 'CLOSE_DONE', epoch: 20 }]);
    expect(frames / 60).toBeLessThan(4);
    expect(h.motion.cover.value).toBe(0);
    expect(h.motion.spreadTarget).toBe(0);
    play(h, runner, 2);
    expect(h.emitted).toHaveLength(1);
  });

  it('a book that is already closed finishes at once', () => {
    const runner = new PhaseRunner('closing', 20, h.env);
    play(h, runner, 0.1);
    expect(h.emitted).toEqual([{ type: 'CLOSE_DONE', epoch: 20 }]);
  });
});

describe('interruptions', () => {
  it('a new phase takes over from the current pose without a jump', () => {
    const opening = new PhaseRunner('opening', 1, h.env);
    play(h, opening, 0.7);
    const mid = h.motion.cover.value;
    expect(mid).toBeGreaterThan(0.2);
    expect(mid).toBeLessThan(0.8);
    const closing = new PhaseRunner('closing', 2, h.env);
    closing.tick();
    expect(h.motion.cover.value).toBeCloseTo(mid, 6);
    play(h, closing, 2);
    expect(h.emitted).toEqual([{ type: 'CLOSE_DONE', epoch: 2 }]); // the interrupted opening never emitted
  });

  it('a runner that is dropped emits nothing more', () => {
    const opening = new PhaseRunner('opening', 1, h.env);
    play(h, opening, 0.5);
    const abandoned = h.emitted.length;
    // The presenter forgets the runner: nothing ticks it, so nothing can be emitted for its epoch.
    h.motion.update(5);
    expect(h.emitted.length).toBe(abandoned);
  });
});

describe('helpers', () => {
  it('the transitional phases end with their own DONE event, the others with none', () => {
    expect(doneEventFor('opening', 3)).toEqual({ type: 'OPEN_DONE', epoch: 3 });
    expect(doneEventFor('unveiling', 3)).toEqual({ type: 'UNVEIL_DONE', epoch: 3 });
    expect(doneEventFor('revealing', 3)).toEqual({ type: 'REVEAL_DONE', epoch: 3 });
    expect(doneEventFor('closing', 3)).toEqual({ type: 'CLOSE_DONE', epoch: 3 });
    for (const phase of [
      'discovery',
      'awaiting',
      'uploading',
      'reading',
      'manuscript',
      'memory',
    ] as Phase[]) {
      expect(doneEventFor(phase, 1)).toBeNull();
    }
  });

  it('mounting in a phase starts from the pose that phase begins with', () => {
    expect(initialPoseFor('discovery', 0)).toEqual({ open: true, spread: 0 }); // the welcome book lies open
    expect(initialPoseFor('opening', 0)).toEqual({ open: true, spread: 0 });
    expect(initialPoseFor('unveiling', 0)).toEqual({ open: true, spread: 0 }); // (open: no close after the upload)
    expect(initialPoseFor('awaiting', 0)).toEqual({ open: true, spread: 0 });
    expect(initialPoseFor('manuscript', 4)).toEqual({ open: true, spread: 4 });
    expect(initialPoseFor('closing', 4)).toEqual({ open: true, spread: 4 });
  });

  it('every phase has a script', () => {
    const phases: Phase[] = [
      'discovery',
      'opening',
      'awaiting',
      'uploading',
      'reading',
      'unveiling',
      'manuscript',
      'revealing',
      'memory',
      'closing',
    ];
    for (const phase of phases) expect(stepsFor(phase, 1).length).toBeGreaterThan(0);
  });

  it('mounting in a transitional phase plays it from its starting pose and still emits DONE exactly once', () => {
    for (const [phase, type] of [
      ['opening', 'OPEN_DONE'],
      ['unveiling', 'UNVEIL_DONE'],
      ['closing', 'CLOSE_DONE'],
    ] as const) {
      const fresh = harness();
      const pose = initialPoseFor(phase, 2);
      fresh.motion.snap(pose);
      const runner = new PhaseRunner(phase, 5, fresh.env);
      play(fresh, runner, 8);
      expect(fresh.emitted, phase).toEqual([{ type, epoch: 5 }]);
    }
  });
});
