import { useEffect, useRef, useState } from 'react';
import { newReveal, revealStep } from '../../motion/ink';

interface RevealOptions {
  /** Epoch ms when the reply may start to be written (see replyStartAt); null until it has a start. */
  startAt: number | null;
  /** Pieces of ink that have arrived and may be shown. */
  available: number;
  /** When the stream ended, for the "done 1.2 s later" rule; null while it runs (or for a text that never streamed). */
  endedAt: number | null;
  /** Nothing more will arrive: the pen may stop once it has caught up. */
  settled: boolean;
  /** The pen's pace for this script: one glyph (or one Arabic word) every this many ms. */
  stepMs: number;
  /** False under reduced motion: everything that has arrived is shown at once. */
  enabled: boolean;
}

/**
 * How much of a reply the pen has written: a plain requestAnimationFrame clock (no timers chained into state) that follows
 * the pure `revealStep` rules of motion/ink.ts. It runs only while there is something left to write, and stops on its own.
 */
export function useReveal({ startAt, available, endedAt, settled, stepMs, enabled }: RevealOptions): number {
  const [revealed, setRevealed] = useState(0);
  const clock = useRef(newReveal());

  useEffect(() => {
    if (!enabled || startAt === null) return undefined;
    let frame = 0;
    const tick = (): void => {
      const now = Date.now();
      if (now >= startAt) {
        clock.current = revealStep(clock.current, now, available, endedAt, { stepMs, startedAt: startAt });
        setRevealed(clock.current.revealed);
        if (settled && clock.current.revealed >= available) return;
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(frame);
    };
  }, [enabled, startAt, available, endedAt, settled, stepMs]);

  if (!enabled) return available;
  return startAt === null ? 0 : Math.min(revealed, available);
}
