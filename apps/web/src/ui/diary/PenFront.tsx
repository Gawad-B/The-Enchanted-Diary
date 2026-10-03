import { useLayoutEffect, useRef, useState } from 'react';

export interface FrontBox {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** The pen front lasts about this long (the CSS animation is 400 ms); then it is taken off the page. */
const FRONT_LIFE_MS = 700;
const MAX_FRONTS = 4;

interface Box {
  offsetLeft: number;
  offsetTop: number;
  offsetWidth: number;
  offsetHeight: number;
}

/**
 * Where the pen front goes: over the newest word, in the coordinates of the page the writing lies on. The word's own layout
 * offsets are used (they are in the page's px, unlike client rects, which the page's perspective has moved and scaled).
 */
export function frontOf(word: Box, line: Pick<Box, 'offsetLeft' | 'offsetTop'>): FrontBox {
  return {
    left: line.offsetLeft + word.offsetLeft,
    top: line.offsetTop + word.offsetTop,
    width: word.offsetWidth,
    height: word.offsetHeight,
  };
}

interface PenFrontProps {
  /** How many pieces of ink are on the page: a new count means a new word was written. */
  revealed: number;
  /** Only for right-to-left ink that is still being written, and not under reduced motion. */
  active: boolean;
}

/**
 * The pen's wipe for right-to-left writing: a soft warm band that sweeps leftward across each word as it lands, sized from the
 * word's own place on its line (so it follows every line and every wrap). Arabic is written a word at a time and never a letter
 * at a time, so the stroke of the pen is carried by this overlay and not by splitting the word. It sits over the page it is
 * placed in (the parent) and looks for the words of the exchange being written (`[data-live]`). Decorative.
 */
export function PenFront({ revealed, active }: PenFrontProps) {
  const [fronts, setFronts] = useState<(FrontBox & { id: number })[]>([]);
  const counter = useRef(0);
  const anchor = useRef<HTMLSpanElement>(null);
  const timers = useRef(new Set<ReturnType<typeof setTimeout>>());

  useLayoutEffect(() => {
    const page = anchor.current?.parentElement;
    if (!active || !page || revealed === 0) return;
    const words = page.querySelectorAll<HTMLElement>('[data-live] .ink-u--word');
    const word = words[words.length - 1];
    const line = word?.closest<HTMLElement>('.pg-line');
    if (!word || !line) return;
    const box = frontOf(word, line);
    counter.current += 1;
    const id = counter.current;
    setFronts((current) => [...current.slice(1 - MAX_FRONTS), { ...box, id }]);
    const timer = setTimeout(() => {
      timers.current.delete(timer);
      setFronts((current) => current.filter((front) => front.id !== id));
    }, FRONT_LIFE_MS);
    timers.current.add(timer);
  }, [revealed, active]);

  useLayoutEffect(() => {
    const live = timers.current;
    return () => {
      for (const timer of live) clearTimeout(timer);
      live.clear();
    };
  }, []);

  return (
    <span ref={anchor} className="pen-fronts" aria-hidden="true">
      {fronts.map((front) => (
        <span
          key={front.id}
          className="pen-front"
          aria-hidden="true"
          style={{ left: front.left, top: front.top, width: front.width, height: front.height }}
        />
      ))}
    </span>
  );
}
