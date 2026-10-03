import { useCallback, useEffect, useRef, useState } from 'react';

export interface Speck {
  id: number;
  x: number;
  y: number;
  dx: number;
  dy: number;
}

/** A speck is flicked when this many glyphs land within the window. */
const FAST_GLYPHS = 4;
const FAST_WINDOW_MS = 450;
const MAX_SPECKS = 6;
/** A speck lives about this long (the CSS animation is a little shorter); then it is taken off the page. */
const SPECK_LIFE_MS = 900;

/**
 * Tiny specks of ink flicked off the nib when the reader writes fast: a few small dots that drift and fade. Off when `enabled`
 * is false (reduced motion). Returns the live specks and `flick(x, y)`, to be called for every glyph written at the nib.
 */
export function useInkSpecks(enabled: boolean) {
  const [specks, setSpecks] = useState<Speck[]>([]);
  const times = useRef<number[]>([]);
  const counter = useRef(0);
  const timers = useRef(new Set<ReturnType<typeof setTimeout>>());

  useEffect(() => {
    const live = timers.current;
    return () => {
      for (const timer of live) clearTimeout(timer);
      live.clear();
    };
  }, []);

  const flick = useCallback(
    (x: number, y: number): void => {
      if (!enabled) return;
      const now = Date.now();
      times.current = [...times.current.filter((time) => now - time <= FAST_WINDOW_MS), now];
      if (times.current.length < FAST_GLYPHS) return;
      const made: Speck[] = [0, 1].map(() => {
        counter.current += 1;
        const angle = (counter.current * 2.399) % (Math.PI * 2);
        return {
          id: counter.current,
          x: x + 2,
          y: y + 2,
          dx: Math.round(Math.cos(angle) * (10 + (counter.current % 5) * 3)),
          dy: Math.round(-Math.abs(Math.sin(angle)) * (8 + (counter.current % 4) * 3) - 4),
        };
      });
      setSpecks((current) => [...current, ...made].slice(-MAX_SPECKS));
      const timer = setTimeout(() => {
        timers.current.delete(timer);
        setSpecks((current) => current.filter((speck) => !made.some((m) => m.id === speck.id)));
      }, SPECK_LIFE_MS);
      timers.current.add(timer);
    },
    [enabled],
  );

  const forget = useCallback((): void => {
    times.current = [];
    setSpecks([]);
  }, []);

  return { specks, flick, forget };
}
