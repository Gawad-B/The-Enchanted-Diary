import { duration, type DurationName } from '../motion/durations';

/*
 * The beats of "Show me the truth", pure: which beat a moment of the scene falls in. The clock (clock.ts) feeds it the
 * elapsed time; nothing here knows the DOM, three.js or the stores.
 */

export const BEATS = ['line', 'riffle', 'zoomIn', 'zoomOut', 'page'] as const;
export type Beat = (typeof BEATS)[number];

const BEAT_DURATION: Record<Beat, DurationName> = {
  line: 'truthLine',
  riffle: 'truthRiffle',
  zoomIn: 'truthZoomIn',
  zoomOut: 'truthZoomOut',
  page: 'truthPage',
};

/** Milliseconds of each beat for the motion preference. A beat of 0 ms is passed through without being shown. */
export function beatDurations(reducedMotion: boolean): Record<Beat, number> {
  const result = {} as Record<Beat, number>;
  for (const beat of BEATS) result[beat] = duration(BEAT_DURATION[beat], reducedMotion);
  return result;
}

export function totalMs(reducedMotion: boolean): number {
  const lengths = beatDurations(reducedMotion);
  return BEATS.reduce((sum, beat) => sum + lengths[beat], 0);
}

/** Where `elapsedMs` falls: the beat, progress `t` (0..1) inside it, and `done` once the last beat has ended. */
export interface BeatPosition {
  beat: Beat;
  t: number;
  done: boolean;
}

export function locate(elapsedMs: number, reducedMotion: boolean): BeatPosition {
  const lengths = beatDurations(reducedMotion);
  let start = 0;
  let last: Beat = 'page';
  for (const beat of BEATS) {
    const length = lengths[beat];
    if (length === 0) continue;
    last = beat;
    if (elapsedMs < start + length)
      return { beat, t: Math.max(0, (elapsedMs - start) / length), done: false };
    start += length;
  }
  return { beat: last, t: 1, done: true };
}

/** The beats a scene passes through, in order, with 0 ms beats included (their side effects still happen once). */
export function beatsBetween(from: Beat | null, to: Beat): Beat[] {
  const start = from === null ? 0 : BEATS.indexOf(from) + 1;
  return BEATS.slice(start, BEATS.indexOf(to) + 1);
}
