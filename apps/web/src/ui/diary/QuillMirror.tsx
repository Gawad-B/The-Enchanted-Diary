import type { Direction } from '@enchanted/shared';
import { Fragment, useMemo, useState, type Ref } from 'react';
import { diffUnits, groupRuns, segmentInk, type InkUnit, type KeyedUnit } from './segment';

/** Keeps the identity of the units of a text across edits, so each glyph's span (and its landing animation) is made once. */
function useKeyedUnits(text: string): KeyedUnit[] {
  const [state, setState] = useState(() => keyed(text, [], 0));
  // The text changed: the units are worked out again during this render (React's way of deriving state from props), keeping
  // the identity of every unit that did not change.
  if (state.text !== text) {
    const next = keyed(text, state.units, state.nextId);
    setState(next);
    return next.units;
  }
  return state.units;
}

function keyed(text: string, previous: readonly KeyedUnit[], nextId: number) {
  let id = nextId;
  const units = diffUnits(previous, segmentInk(text), () => (id += 1));
  return { text, units, nextId: id };
}

interface QuillMirrorProps {
  text: string;
  /** The direction the browser gives the text (the first letter with one): applied explicitly so the mirror lays out like the textarea. */
  direction: Direction;
  innerRef: Ref<HTMLDivElement>;
}

/**
 * The reader's words as ink. The textarea's own glyphs are transparent; this layer, aligned with it exactly, draws the same text
 * in the quill face. Every glyph (every WORD in Arabic and the other joined scripts: a span never holds part of one) is a plain
 * inline <span> that lands with an animation of opacity, colour and blur only (no transform, no inline-block); left-to-right runs
 * inside right-to-left text are isolated in a <bdi>.
 */
export function QuillMirror({ text, direction, innerRef }: QuillMirrorProps) {
  const keyed = useKeyedUnits(text);
  const ids = useMemo(() => new Map<InkUnit, number>(keyed.map((entry) => [entry.unit, entry.id])), [keyed]);
  const runs = useMemo(
    () =>
      groupRuns(
        keyed.map((entry) => entry.unit),
        direction,
      ),
    [keyed, direction],
  );
  const draw = (unit: InkUnit) => {
    const id = ids.get(unit) ?? 0;
    if (unit.kind === 'space' || unit.kind === 'break') return <Fragment key={id}>{unit.text}</Fragment>;
    return (
      <span key={id} className={unit.kind === 'word' ? 'quill__u quill__u--word' : 'quill__u'}>
        {unit.text}
      </span>
    );
  };
  return (
    <div className="quill__mirror" aria-hidden="true" dir={direction}>
      <div className="quill__mirror-inner" ref={innerRef}>
        {runs.map((run) => {
          const first = run.units[0];
          const key = first ? (ids.get(first) ?? 0) : 0;
          return run.isolate ? <bdi key={`b${String(key)}`}>{run.units.map(draw)}</bdi> : run.units.map(draw);
        })}
        {/* Keeps the line after a trailing newline in the layout (and gives the nib somewhere to stand). */}
        <span data-tail="">{'​'}</span>
      </div>
    </div>
  );
}
