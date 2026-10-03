import { duration } from '../motion/durations';
import { BEATS, beatDurations, beatsBetween, locate, type Beat, type BeatPosition } from './timeline';

/*
 * The reveal's clock: a plain requestAnimationFrame loop outside React and three.js (global section F, presenter contract 3), so
 * the 3D scene and the 2D fallback share it. One clock per reveal. `onEnter` fires once for every beat, in order, even for a beat
 * that skip jumps over (its effect - the riffle, the highlight - must still happen); `onFrame` fires every frame with the
 * position; `onDone` fires once, after the last beat or after a skip.
 */

export interface ClockOptions {
  reducedMotion: boolean;
  /** Start at this beat (the beats before it are taken as already played, and not entered). */
  from?: Beat;
  onEnter(beat: Beat): void;
  onFrame(position: BeatPosition, dtMs: number): void;
  onDone(): void;
  now?: () => number;
  requestFrame?: (callback: () => void) => number;
  cancelFrame?: (handle: number) => void;
}

export interface RevealClock {
  /** Jumps to the cited page: it appears in 200 ms and the clock ends. */
  skip(): void;
  /** Stops without calling `onDone` (the phase ended some other way). */
  stop(): void;
  readonly finished: boolean;
}

export function startRevealClock(options: ClockOptions): RevealClock {
  const now = options.now ?? (() => performance.now());
  const request = options.requestFrame ?? ((callback) => requestAnimationFrame(callback));
  const cancel =
    options.cancelFrame ??
    ((handle) => {
      cancelAnimationFrame(handle);
    });
  const lengths = beatDurations(options.reducedMotion);
  const offset = BEATS.slice(0, BEATS.indexOf(options.from ?? 'line')).reduce(
    (sum, beat) => sum + lengths[beat],
    0,
  );
  const startedAt = now() - offset;
  let last = now();
  let handle = 0;
  let entered: Beat | null = options.from ? (BEATS[BEATS.indexOf(options.from) - 1] ?? null) : null;
  let finished = false;
  let skipping: { from: number; fromT: number; length: number } | null = null;

  const enterUpTo = (beat: Beat): void => {
    for (const next of beatsBetween(entered, beat)) {
      entered = next;
      options.onEnter(next);
    }
  };

  const finish = (): void => {
    if (finished) return;
    finished = true;
    cancel(handle);
    options.onDone();
  };

  const tick = (): void => {
    if (finished) return;
    const time = now();
    const dt = time - last;
    last = time;
    if (skipping) {
      const length = Math.max(skipping.length, 1);
      const t = Math.min(skipping.fromT + (1 - skipping.fromT) * ((time - skipping.from) / length), 1);
      options.onFrame({ beat: 'page', t, done: t >= 1 }, dt);
      if (t >= 1) finish();
      else handle = request(tick);
      return;
    }
    const position = locate(time - startedAt, options.reducedMotion);
    enterUpTo(position.beat);
    options.onFrame(position, dt);
    if (position.done) finish();
    else handle = request(tick);
  };

  handle = request(tick);
  return {
    skip: () => {
      if (finished || skipping) return;
      const time = now();
      const position = locate(time - startedAt, options.reducedMotion);
      enterUpTo('page');
      skipping = {
        from: time,
        fromT: position.beat === 'page' && !position.done ? position.t : 0,
        length: duration('truthSkip', options.reducedMotion),
      };
    },
    stop: () => {
      if (finished) return;
      finished = true;
      cancel(handle);
    },
    get finished() {
      return finished;
    },
  };
}
