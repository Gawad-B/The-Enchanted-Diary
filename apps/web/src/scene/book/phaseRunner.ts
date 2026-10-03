import type { Direction } from '@enchanted/shared';
import { duration } from '../../motion/durations';
import { doneEventFor, type ExperienceEvent, type Phase } from '../../state/experience';
import { leadLeavesCount } from '../../book/bookLayout';
import type { BookMotion } from './bookMotion';

/*
 * The presenter's script. Each phase has a short list of steps; the runner advances them one at a time, every
 * frame, against a BookMotion. Phases that end with a DONE event (opening, unveiling, closing, and the reveal
 * once it exists) finish with a step that emits it exactly once, stamped with the epoch the phase started in.
 * Because every step starts from the book's CURRENT pose and every tween is interruptible, switching phase in
 * mid-motion (or mounting in a phase) never needs special cases: a new runner simply takes over.
 */

/** What a step may ask of the world. */
export interface PresenterEnv {
  motion: BookMotion;
  /** The direction the book is laid out in right now. */
  layoutDirection(): Direction;
  setLayoutDirection(direction: Direction): void;
  /** The direction the book should have: the document's, or the interface's while there is none. */
  desiredDirection(): Direction;
  /** The spread the reader is at (manuscript phases follow it). */
  readerSpread(): number;
  /** Whether the textures of pages 1 and 2 are ready. */
  pageTexturesReady(): boolean;
  /** Whether the camera has arrived at the pose of the phase (absent: it always has). */
  cameraSettled?(): boolean;
  emit(event: ExperienceEvent): void;
}

export type StepStatus = 'running' | 'done';

/** Right after the scene mounts, a layout change is applied without the flip animation. */
export const INITIAL_SETTLE_SECONDS = 2.2;

export interface Step {
  readonly name: string;
  /** Called once per frame until it returns 'done'. The first call starts it. */
  tick(env: PresenterEnv): StepStatus;
}

function open(): Step {
  let started = false;
  return {
    name: 'open-cover',
    tick: ({ motion }) => {
      if (!started) {
        started = true;
        motion.setCoverOpen(true);
      }
      return motion.cover.active || motion.cover.value < 1 ? 'running' : 'done';
    },
  };
}

function settleLeaves(): Step {
  let started = false;
  return {
    name: 'settle-leaves',
    tick: ({ motion }) => {
      if (!started) {
        started = true;
        if (motion.spreadTarget !== 0 || motion.turning) motion.setSpread(0);
      }
      return motion.turning ? 'running' : 'done';
    },
  };
}

/**
 * Waits for the camera to arrive at the framing the phase holds, but never longer than most of a glide. Closing from "Read
 * closely" starts with the camera closer than any other pose; the leaves that riffle back first must not leave the picture
 * while it is still on its way out to the spread framing.
 */
function waitForCamera(): Step {
  let began: number | null = null;
  return {
    name: 'wait-for-camera',
    tick: (env) => {
      const { motion } = env;
      began ??= motion.clock;
      if (env.cameraSettled?.() ?? true) return 'done';
      const limit = (duration('cameraSettle', motion.reducedMotion) / 1000) * 0.65;
      return motion.clock - began >= limit ? 'done' : 'running';
    },
  };
}

/** The spread the upload page (and the first fresh page of the diary) lies on: the middle of the book, never the first page. */
export function midSpread(leafCount: number): number {
  // Six leaves before the diary's first page (which is after the lead): after the upload the book riffles forward to it.
  return Math.max(1, Math.min(leadLeavesCount() - 6, leafCount - 1));
}

/** One rush of the long riffle. */
const rushOf = (mid: number): number => Math.max(2, Math.ceil(mid / 3));

/**
 * The welcome screen's ambient loop: leaves turn FORWARD only, one after another, continuously (owner direction T.4.2). Never a
 * turn back: when the loop has gone as far as it may, the stack is put back at the start in one cut, between two turns.
 */
/** The spread the welcome's loop starts from: past the flyleaf, on blank pages. */
export const AMBIENT_START = 2;

function ambientRiffle(): Step {
  let next = 0;
  return {
    name: 'ambient-riffle',
    tick: ({ motion }) => {
      if (motion.turning || motion.clock < next) return 'running';
      // It starts over early enough that the long riffle always has at least two rushes of leaves left to turn.
      const mid = midSpread(motion.leafCount);
      const limit = Math.max(AMBIENT_START + 2, mid - 2 * rushOf(mid));
      if (motion.spreadTarget >= limit) motion.snap({ open: true, spread: AMBIENT_START });
      else if (motion.spreadTarget < AMBIENT_START) motion.setSpread(AMBIENT_START);
      motion.setSpread(motion.spreadTarget + 1);
      next = motion.clock + 0.8;
      return 'running';
    },
  };
}

/** The long, lively riffle that opens the diary ("like the movie"): forward through the pages in three rushes, to the middle. */
function liveRiffle(): Step {
  return {
    name: 'live-riffle',
    tick: ({ motion }) => {
      if (motion.turning) return 'running';
      const mid = midSpread(motion.leafCount);
      const at = motion.spreadTarget;
      if (at >= mid) return 'done';
      motion.setSpread(Math.min(mid, at + rushOf(mid)));
      return 'running';
    },
  };
}

/** Brings the book to the middle (a reopened book, or one that was closed): forward only, with the cover already open. */
function goToMiddle(): Step {
  return {
    name: 'go-to-middle',
    tick: ({ motion }) => {
      const mid = midSpread(motion.leafCount);
      if (motion.spreadTarget !== mid) motion.setSpread(mid);
      return motion.turning ? 'running' : 'done';
    },
  };
}

function close(): Step {
  let started = false;
  return {
    name: 'close-cover',
    tick: ({ motion }) => {
      if (!started) {
        started = true;
        motion.setCoverOpen(false);
      }
      return motion.cover.active || motion.cover.value > 0 ? 'running' : 'done';
    },
  };
}

/** Turns the leaves to the spread the reader is at (the shared layer put the reader on page 1 for unveiling). */
function turnToReader(): Step {
  let started = false;
  return {
    name: 'turn-to-reader',
    tick: (env) => {
      if (!started) {
        started = true;
        // Forward only: the book riffles on to the diary's page, it never turns back to reach it.
        env.motion.setSpread(Math.max(env.readerSpread(), env.motion.spreadTarget));
      }
      return env.motion.turning ? 'running' : 'done';
    },
  };
}

/** Waits until pages 1 and 2 are drawn, but never longer than the texture-wait duration. */
function waitForTextures(): Step {
  let began: number | null = null;
  return {
    name: 'wait-for-textures',
    tick: (env) => {
      const { motion } = env;
      began ??= motion.clock;
      if (env.pageTexturesReady()) return 'done';
      const limit = duration('textureWait', motion.reducedMotion) / 1000;
      return motion.clock - began >= limit ? 'done' : 'running';
    },
  };
}

/** The other direction. */
function opposite(direction: Direction): Direction {
  return direction === 'ltr' ? 'rtl' : 'ltr';
}

/**
 * Finishes a turn-over that was under way when the phase changed. Whoever started it is gone (a new runner replaces
 * the old one on every phase change), and nothing else would ever settle it: the book would stay turned half round, open
 * and upside down. A half turn shows the book in the OPPOSITE layout (the cover is symmetric under it), so when it is
 * done the layout is committed to the opposite of the current one and the rotation is reset, which changes nothing
 * that is seen. The phase's own direction step then flips it back if it has to.
 */
function finishFlip(): Step {
  return {
    name: 'finish-flip',
    tick: (env) => {
      const { motion } = env;
      if (!motion.flipping && motion.yaw.value === 0) return 'done';
      if (!motion.flipDone) return 'running';
      env.setLayoutDirection(opposite(env.layoutDirection()));
      motion.commitFlip();
      return 'done';
    },
  };
}

/**
 * What matchDirection does while the cover is not shut and the layout differs from the desired direction.
 *  - `watch`: the phase keeps the book closed and the step never finishes (reading waits for the direction to be
 *    reported, and flips whenever it changes).
 *  - `keep-open`: a book that is OPEN (or opening) keeps its layout, because a visible re-layout of an open book
 *    is impossible; it will flip when it is next closed. A cover that is closing is waited for.
 *  - `close-first`: the book must have the right layout before it is shown, so an open cover is closed first.
 */
type DirectionPolicy = 'watch' | 'keep-open' | 'close-first';

/**
 * Brings the layout direction in line with the desired one while the book is closed. Animated (the diary
 * turns itself over) unless the visitor prefers reduced motion. It never reports `done` while the layout is
 * wrong and the cover is on its way shut: finishing a close, flipping and only then opening is the order.
 */
function matchDirection(policy: DirectionPolicy): Step {
  const forever = policy === 'watch';
  const rest = (): StepStatus => (forever ? 'running' : 'done');
  let flipping = false;
  return {
    name: forever ? 'watch-direction' : 'match-direction',
    tick: (env) => {
      const { motion } = env;
      if (flipping) {
        if (motion.flipDone) {
          // The half turn showed the opposite layout: commit exactly that (what the book looks like does not change).
          // If the desired direction changed again meanwhile, the next tick flips back.
          env.setLayoutDirection(opposite(env.layoutDirection()));
          motion.commitFlip();
          flipping = false;
          return rest();
        }
        return 'running';
      }
      if (env.desiredDirection() === env.layoutDirection()) return rest();
      const closed = motion.cover.value === 0 && !motion.cover.active;
      if (!closed) {
        if (!motion.coverOpen) return 'running'; // on its way shut: wait for the cover, then flip
        if (policy === 'close-first') {
          motion.setCoverOpen(false);
          return 'running';
        }
        return rest(); // an open book keeps its layout; it will flip when closed
      }
      // No flip under reduced motion, and none while the scene is still settling in (a restored session whose
      // document turns out to read from the other side must not visibly turn the book at the very start).
      if (motion.reducedMotion || motion.clock < INITIAL_SETTLE_SECONDS) {
        env.setLayoutDirection(env.desiredDirection());
        return rest();
      }
      motion.startFlip();
      flipping = true;
      return 'running';
    },
  };
}

/** Keeps the turned leaves at the reader's spread, for as long as the phase lasts. */
function followReader(): Step {
  return {
    name: 'follow-reader',
    tick: (env) => {
      const spread = env.readerSpread();
      if (env.motion.coverOpen && spread !== env.motion.spreadTarget) env.motion.setSpread(spread);
      return 'running';
    },
  };
}

function emitDone(phase: Phase, epoch: number): Step {
  let emitted = false;
  return {
    name: 'done',
    tick: (env) => {
      if (!emitted) {
        emitted = true;
        const event = doneEventFor(phase, epoch);
        if (event) env.emit(event);
      }
      return 'done';
    },
  };
}

/** The steps of a phase; `inheritedFlip` when a turn-over is already in flight as the phase begins. */
export function stepsFor(phase: Phase, epoch: number, inheritedFlip = false): Step[] {
  const steps = phaseSteps(phase, epoch);
  return inheritedFlip ? [finishFlip(), ...steps] : steps;
}

function phaseSteps(phase: Phase, epoch: number): Step[] {
  switch (phase) {
    case 'discovery':
      // The welcome screen: the book lies open behind the title and leafs through itself, slowly, for ever.
      return [matchDirection('close-first'), open(), ambientRiffle()];
    case 'opening':
      return [matchDirection('keep-open'), open(), liveRiffle(), emitDone(phase, epoch)];
    case 'awaiting':
    case 'uploading':
      // The upload page is a page in the MIDDLE of the book, not the first one (owner direction T.4.3).
      return [matchDirection('keep-open'), open(), goToMiddle()];
    case 'reading':
      // The cover stays open: the book lies where the upload page was while the diary reads (no close, no reopen).
      return [matchDirection('close-first'), open(), goToMiddle()];
    case 'unveiling':
      // (an open book is closed first only when its layout is the wrong way round for the manuscript)
      return [
        matchDirection('close-first'),
        open(),
        waitForTextures(),
        turnToReader(),
        emitDone(phase, epoch),
      ];
    case 'manuscript':
    case 'memory':
      return [open(), followReader()];
    case 'revealing':
      // The reveal sequence (a later task) drives the book; until then the book holds its pose and the
      // watchdog ends the phase.
      return [open(), followReader()];
    case 'closing':
      return [waitForCamera(), settleLeaves(), close(), emitDone(phase, epoch)];
  }
}

/** Runs the steps of one phase. Create a new one on every phase change. */
export class PhaseRunner {
  private index = 0;
  private readonly steps: Step[];

  constructor(
    readonly phase: Phase,
    readonly epoch: number,
    private readonly env: PresenterEnv,
    options: { inheritedFlip?: boolean } = {},
  ) {
    this.steps = stepsFor(phase, epoch, options.inheritedFlip ?? false);
  }

  get finished(): boolean {
    return this.index >= this.steps.length;
  }

  /** Name of the step in progress, for debugging. */
  get current(): string {
    return this.steps[this.index]?.name ?? 'finished';
  }

  /** Advances through every step that completes this frame (several short ones may finish together). */
  tick(): void {
    for (let guard = 0; guard < this.steps.length && this.index < this.steps.length; guard += 1) {
      const step = this.steps[this.index];
      if (!step || step.tick(this.env) === 'running') return;
      this.index += 1;
    }
  }
}

/** The pose a presenter starts in when it mounts in `phase`: the pose the phase's steps begin from. */
export function initialPoseFor(phase: Phase, readerSpread: number): { open: boolean; spread: number } {
  switch (phase) {
    case 'discovery':
    case 'opening':
      return { open: true, spread: 0 };
    case 'awaiting':
    case 'uploading':
    case 'reading':
    case 'unveiling':
      return { open: true, spread: 0 }; // (the presenter puts these in the middle: it knows the leaf count)
    case 'manuscript':
    case 'revealing':
    case 'memory':
    case 'closing':
      return { open: true, spread: readerSpread };
  }
}
