import { duration } from './durations';

/*
 * The choreography of writing to the diary, as pure functions (experience research section 4, rows 1 to 6): how the
 * reader's question sinks, when the reply may start, how much of the reply the pen has written, and where the diary's
 * hand ends and the fair copy begins. Components read these; nothing here touches the DOM or a clock of its own.
 */

/** A sink totals about this long for an ordinary question; a long one is squeezed toward it... */
export const SINK_TARGET_MS = 1000;
/** ...and never exceeds this, however many words it has. */
export const SINK_CAP_MS = 1600;
/** The quickest the words may follow one another before the cap squeezes them further. */
const SINK_MIN_STAGGER_MS = 20;

export interface SinkPlan {
  /** One word sinking. */
  perWordMs: number;
  /** Between the starts of two words. */
  staggerMs: number;
  /** From the first word starting to the last one gone. */
  totalMs: number;
  /** Reduced motion: the whole block crossfades at once. */
  crossfade: boolean;
}

/**
 * How the words of a question sink into the paper. 520 ms a word, 45 ms apart, in reading order; a longer question
 * is squeezed toward a total of 1000 ms (not below 20 ms apart) and then toward the 1600 ms cap. Under reduced motion
 * the block crossfades once, with no stagger.
 */
export function sinkPlan(wordCount: number, reducedMotion: boolean): SinkPlan {
  if (reducedMotion) {
    const ms = duration('sinkWord', true);
    return { perWordMs: ms, staggerMs: 0, totalMs: ms, crossfade: true };
  }
  const word = duration('sinkWord', false);
  const base = duration('sinkStagger', false);
  const gaps = Math.max(0, wordCount - 1);
  if (gaps === 0) return { perWordMs: word, staggerMs: base, totalMs: word, crossfade: false };
  let stagger = base;
  if (word + gaps * stagger > SINK_TARGET_MS) {
    stagger = Math.max(SINK_MIN_STAGGER_MS, (SINK_TARGET_MS - word) / gaps);
  }
  if (word + gaps * stagger > SINK_CAP_MS) stagger = (SINK_CAP_MS - word) / gaps;
  return { perWordMs: word, staggerMs: stagger, totalMs: word + gaps * stagger, crossfade: false };
}

export interface Choreography {
  sink: SinkPlan;
  /** The words are held as written until here (ms after Enter), then they sink. */
  sinkStartMs: number;
  sinkEndMs: number;
  /** The reply may not start before here, even if its first token has long arrived. */
  replyEarliestMs: number;
}

export function choreography(wordCount: number, reducedMotion: boolean): Choreography {
  const sink = sinkPlan(wordCount, reducedMotion);
  const sinkStartMs = duration('commitHold', reducedMotion);
  const sinkEndMs = sinkStartMs + sink.totalMs;
  return {
    sink,
    sinkStartMs,
    sinkEndMs,
    replyEarliestMs: sinkEndMs + duration('replyBreath', reducedMotion),
  };
}

/** reply_start = max(sink_end + 250 ms, first_token_time); null until the first token has arrived. */
export function replyStartAt(
  submittedAt: number,
  firstTokenAt: number | null,
  plan: Pick<Choreography, 'replyEarliestMs'>,
): number | null {
  if (firstTokenAt === null) return null;
  return Math.max(submittedAt + plan.replyEarliestMs, firstTokenAt);
}

/** The diary hand writes the first sentence (about this many characters at most); the rest is fair copy. */
export const LEAD_MAX_CHARS = 160;

const SENTENCE_END = /[.!?؟۔。！？…]+(?=\s|$)|\n/u;

/**
 * Length (in UTF-16 units) of the lead of a reply: up to the end of its first sentence, or about 160 characters cut at a
 * word boundary, whichever comes first; the whole text while neither has happened yet. It only ever grows as text streams
 * in, so a glyph written in the diary's hand is not rewritten in the fair copy's.
 */
export function leadLength(text: string): number {
  const match = SENTENCE_END.exec(text);
  if (match && match.index + match[0].length <= LEAD_MAX_CHARS) {
    return match[0] === '\n' ? match.index : match.index + match[0].length;
  }
  if (text.length <= LEAD_MAX_CHARS) return text.length;
  const cut = text.lastIndexOf(' ', LEAD_MAX_CHARS);
  return cut > 0 ? cut : LEAD_MAX_CHARS;
}

// --- the pen: how much of the reply has been written ---------------------------------------------------------------

/** The pen lagging the stream by more than this is sped up. */
export const REVEAL_LAG_MS = 1200;
export const REVEAL_SPEEDUP = 1.5;
/** However much is left, the writing is done this long after the stream ended. */
export const REVEAL_MAX_TAIL_MS = 1200;
/** After this long of writing, whatever is left appears at once (and fades in over 300 ms). */
export const REVEAL_HARD_CAP_MS = 8000;
/** A pen that has caught the stream writes a little slower than the base pace (research: adaptive 20 to 55 per second). */
const CAUGHT_UP_FACTOR = 0.75;
const CAUGHT_UP_UNITS = 3;
/** A gap between two frames longer than this (a hidden tab) is not paid back in one jump. */
const MAX_FRAME_GAP_MS = 250;

export interface RevealParams {
  /** One unit (a glyph, or an Arabic word) every this many ms at the base pace. */
  stepMs: number;
  /** When the reply began to be written, for the 8 s cap. */
  startedAt: number;
}

export interface RevealState {
  /** Units written so far. */
  revealed: number;
  lastNow: number | null;
  /** The fraction of a unit not yet written. */
  carry: number;
}

export function newReveal(): RevealState {
  return { revealed: 0, lastNow: null, carry: 0 };
}

/**
 * One frame of the pen. `available` is how many units of the reply have arrived (and are fit to show), `endedAt` when the
 * stream ended (null while it runs). The pen writes at the base pace; it speeds up 1.5x while it lags the stream by more
 * than 1.2 s; once the stream has ended it writes as fast as it must to be done 1.2 s later; after 8 s of writing it shows
 * the rest at once. Never more than has arrived.
 */
export function revealStep(
  state: RevealState,
  now: number,
  available: number,
  endedAt: number | null,
  params: RevealParams,
): RevealState {
  const remaining = Math.max(available - state.revealed, 0);
  if (remaining === 0) return { revealed: state.revealed, lastNow: now, carry: 0 };
  if (now - params.startedAt > REVEAL_HARD_CAP_MS) return { revealed: available, lastNow: now, carry: 0 };
  if (endedAt !== null && now >= endedAt + REVEAL_MAX_TAIL_MS)
    return { revealed: available, lastNow: now, carry: 0 };
  if (state.lastNow === null) return { revealed: state.revealed, lastNow: now, carry: 0 };
  const dt = Math.min(Math.max(now - state.lastNow, 0), MAX_FRAME_GAP_MS);

  const lagMs = remaining * params.stepMs;
  let factor = 1;
  if (lagMs > REVEAL_LAG_MS) factor = REVEAL_SPEEDUP;
  else if (remaining <= CAUGHT_UP_UNITS) factor = CAUGHT_UP_FACTOR;
  let unitsPerMs = factor / params.stepMs;
  if (endedAt !== null) {
    unitsPerMs = Math.max(unitsPerMs, remaining / (endedAt + REVEAL_MAX_TAIL_MS - now));
  }
  const wanted = state.carry + dt * unitsPerMs;
  const whole = Math.min(Math.floor(wanted), remaining);
  return { revealed: state.revealed + whole, lastNow: now, carry: wanted - whole };
}
