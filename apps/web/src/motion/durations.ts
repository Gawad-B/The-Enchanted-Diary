/**
 * Duration tokens for the physical book (milliseconds). Later tasks (conversation, reveal) append their own
 * tokens here, so every timing in the product lives in one place. `reduced` is what a presenter uses when the
 * visitor asked for reduced motion: every book motion becomes a short, simple move (global section J).
 */

export interface DurationToken {
  readonly normal: number;
  readonly reduced: number;
}

/** A page turn lasts about 900 ms; under reduced motion 250 ms (global section J / brief). */
export const DURATIONS = {
  /** One leaf crossing the gutter. */
  pageTurn: { normal: 900, reduced: 250 },
  /** The front board swinging open or shut. */
  coverSwing: { normal: 1400, reduced: 250 },
  /** Total time a multi-leaf riffle may take, however far the jump (brief: capped to about 1.2 s). */
  riffleTotal: { normal: 1200, reduced: 250 },
  /** The closed diary turning itself over when the document reads from the other side. */
  directionFlip: { normal: 1500, reduced: 250 },
  /** Hover lift of the closed diary settling. */
  hoverSettle: { normal: 450, reduced: 150 },
  /** Longest the unveiling waits for the textures of pages 1 and 2 before turning the flyleaf anyway. */
  textureWait: { normal: 1500, reduced: 500 },
  /** Camera moving from one framing to the next (damping time constant is derived from this). */
  cameraSettle: { normal: 1100, reduced: 250 },
  /** Cover glow fading in or out. */
  glowFade: { normal: 600, reduced: 200 },

  // --- writing to the diary (experience research section 4, rows 1 to 6) ---
  /** One glyph of the reader's ink landing on the page (row 1). */
  inkGlyphIn: { normal: 60, reduced: 0 },
  /** How long the reader's ink stays wet and glossy before it settles (row 1). */
  inkWetSheen: { normal: 700, reduced: 0 },
  /** The words are left as written for a moment after Enter (row 2). */
  commitHold: { normal: 150, reduced: 0 },
  /** One word of the question sinking into the paper (row 3); reduced motion is one crossfade of the block (the research's rm-fade). */
  sinkWord: { normal: 520, reduced: 250 },
  /** Delay between the sinking of two words (row 3). */
  sinkStagger: { normal: 45, reduced: 0 },
  /** One glyph of the diary's reply developing on the page (row 5). */
  replyGlyph: { normal: 240, reduced: 200 },
  /** The pen's pace: one glyph every this many ms (row 5, about 33 per second). */
  replyStagger: { normal: 30, reduced: 0 },
  /** The reply's ink drying from warm and wet to umber (row 5). */
  replyDry: { normal: 1800, reduced: 0 },
  /** One Arabic word of the reply (row 5a: words, never letters). */
  replyWord: { normal: 320, reduced: 200 },
  /** The pen's pace in Arabic: one word every this many ms (row 5a). */
  replyWordStagger: { normal: 90, reduced: 0 },
  /** The breath between the question's last word sinking and the reply starting (research section 4: sink_end + 250). */
  replyBreath: { normal: 250, reduced: 0 },
  /** How long after the last glyph the citations appear (row 6). */
  citationDelay: { normal: 400, reduced: 0 },
  /** A citation fading in (row 6). */
  citationFade: { normal: 200, reduced: 200 },
  /** The thread of ink from a citation to the page it names. */
  citationThread: { normal: 700, reduced: 0 },

  // --- "Show me the truth" (the reveal scene) ---
  /** The diary writes "Let me show you the truth..."; reduced motion shows the line at once (the global reduced-motion cap of 250 ms). */
  truthLine: { normal: 1500, reduced: 250 },
  /** The book riffles to the cited page (the same cap as any riffle); a cut under reduced motion. */
  truthRiffle: { normal: 1200, reduced: 0 },
  /** The camera zooms in, then out. */
  truthZoomIn: { normal: 600, reduced: 0 },
  truthZoomOut: { normal: 600, reduced: 0 },
  /** The cited page appears; under reduced motion this is the one crossfade. */
  truthPage: { normal: 500, reduced: 250 },
  /** Skip (Esc, a tap, the Skip control) jumps to the cited page in this long. */
  truthSkip: { normal: 200, reduced: 200 },
} as const satisfies Record<string, DurationToken>;

export type DurationName = keyof typeof DURATIONS;

/** The duration of `name` in milliseconds for the visitor's motion preference. */
export function duration(name: DurationName, reducedMotion: boolean): number {
  const token = DURATIONS[name];
  return reducedMotion ? token.reduced : token.normal;
}

/** Delay between the starts of two consecutive leaves of a riffle, before the cap squeezes it. */
export const RIFFLE_STAGGER_MS = 70;
/** A leaf in a riffle flies a little faster than a single, deliberate turn. */
const RIFFLE_FLIGHT_FACTOR = 0.78;

export interface TurnTiming {
  /** How long one leaf is in the air. */
  flightMs: number;
  /** Delay between the starts of consecutive leaves. */
  staggerMs: number;
  /** From the start of the first leaf to the landing of the last one. */
  totalMs: number;
}

/**
 * Timing of turning `leaves` leaves in a row. One leaf takes the page-turn duration. Several riffle: each
 * leaf starts a little after the previous one, flies a bit faster, and the whole sequence never exceeds the
 * riffle cap (about 1.2 s), however far the jump. At most `maxAirborne` leaves are in the air at once, so a
 * long riffle shortens each flight instead of needing more leaf meshes. Under reduced motion only one
 * short flight is used (the presenter sets the other leaves without animation).
 */
export function turnTiming(leaves: number, reducedMotion: boolean, maxAirborne = 5): TurnTiming {
  if (leaves <= 0) return { flightMs: 0, staggerMs: 0, totalMs: 0 };
  const single = duration('pageTurn', reducedMotion);
  if (leaves === 1 || reducedMotion) return { flightMs: single, staggerMs: 0, totalMs: single };
  const cap = duration('riffleTotal', false);
  const nominal = single * RIFFLE_FLIGHT_FACTOR;
  if (leaves <= maxAirborne) {
    const stagger = Math.min(RIFFLE_STAGGER_MS, (cap - nominal) / (leaves - 1));
    return { flightMs: nominal, staggerMs: stagger, totalMs: nominal + (leaves - 1) * stagger };
  }
  const stagger = Math.min(RIFFLE_STAGGER_MS, cap / (leaves - 1 + maxAirborne));
  const flight = Math.min(nominal, maxAirborne * stagger);
  return { flightMs: flight, staggerMs: stagger, totalMs: flight + (leaves - 1) * stagger };
}
