/**
 * Smoothed noise for the candle: a sum of sines with incommensurate frequencies, so it never visibly loops,
 * plus a slow gust. Returns roughly -1..1. Pure and allocation-free.
 */
export function flickerNoise(time: number): number {
  const fast =
    Math.sin(time * 9.1) * 0.35 + Math.sin(time * 14.7 + 1.3) * 0.25 + Math.sin(time * 23.9 + 4.1) * 0.12;
  const slow = Math.sin(time * 2.3 + 0.7) * 0.2 + Math.sin(time * 0.93 + 2.2) * 0.08;
  const gust = Math.max(0, Math.sin(time * 0.61 + 1.9)) ** 6 * -0.35;
  return Math.max(-1, Math.min(1, fast + slow + gust));
}

/** Flicker amplitude of the candle's light: about +-3% (global brief). */
export const FLICKER_AMPLITUDE = 0.03;

export function flickerIntensity(base: number, time: number): number {
  return base * (1 + FLICKER_AMPLITUDE * flickerNoise(time));
}
