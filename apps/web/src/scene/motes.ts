/** At most this many motes are visible at once, whatever the tier's count: a few fine sparks, not a swarm. */
export const MAX_VISIBLE_MOTES = 20;

/** A mote is 0.6 to 1.5 mm across (the unit is 10 cm). */
export const MOTE_SIZE = { min: 0.006, max: 0.015 } as const;

/** Motes visible with no glow at all: the book is never perfectly still. */
const RESTING_MOTES = 2;

/**
 * The fraction of the motes that are visible for a glow (0..1): two at rest, rising to twenty at full glow, in
 * absolute numbers, so a tier with more motes does not show more of them.
 */
export function visibleFraction(count: number, glow: number): number {
  if (count <= 0) return 0;
  const g = Math.min(Math.max(glow, 0), 1);
  const visible = RESTING_MOTES + (MAX_VISIBLE_MOTES - RESTING_MOTES) * g;
  return Math.min(1, visible / count);
}
