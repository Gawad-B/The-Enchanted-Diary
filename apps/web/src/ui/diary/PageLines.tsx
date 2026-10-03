import type { Direction } from '@enchanted/shared';
import { Fragment, type CSSProperties } from 'react';
import type { SinkPlan } from '../../motion/ink';
import type { LayoutChunk, LayoutUnit, PageLine } from '../../diarypage/layout';
import { PAGE_HEIGHT, baselineOf, columnOf, fontOf, rowTop } from '../../diarypage/typography';

/** How the exchange being written is drawn: its question sinking, its reply as far as the pen has got. */
export interface FreshInk {
  exchange: string;
  /** The pen has written this many pieces of the reply. */
  revealed: number;
  /** Fresh ink lands with an animation; ink that is only being shown again is simply there. */
  animate: boolean;
  /** The question is held as written, then sinks (null: it is a dried trace already). `gone`: it leaves no trace (the flyleaf keeps nothing). */
  sink: { plan: SinkPlan; holdMs: number; gone?: boolean } | null;
}

interface PageLinesProps {
  lines: readonly PageLine[];
  book: Direction;
  fresh: FreshInk | null;
}

/**
 * The lines of a diary page as ink on the page: each on its own row of the ruled grid, absolutely placed in the page's design
 * px, so the whole page can be laid onto the 3D leaf as one piece. Earlier exchanges are dried ink (a faint question, settled
 * answers). The exchange being written lands: its question words sink one after another, its reply is drawn from the pieces
 * of ink the pen has written (every glyph, and every WORD in Arabic, is a plain inline span: it never holds part of a joined
 * word). Everything is a React text node; nothing here can turn model output into markup. Hidden from assistive technology:
 * the same words are in the conversation's accessible record.
 */
export function PageLines({ lines, book, fresh }: PageLinesProps) {
  const column = columnOf(book);
  return (
    <div className="pg-lines" aria-hidden="true">
      {lines.map((line) => {
        const live = fresh !== null && line.exchange === fresh.exchange;
        const style: CSSProperties = {
          left: column.left,
          width: column.width,
          paddingInlineStart: line.indent,
          // Where the row is, and how far its baseline is from the foot of the page: browsers that can trim a line to its
          // baseline sit the ink exactly on it (diary.css).
          '--row-top': `${String(rowTop(line.row))}px`,
          '--from-foot': `${String(PAGE_HEIGHT - baselineOf(line.row))}px`,
        } as CSSProperties;
        if (live && line.role === 'question' && fresh.sink) {
          Object.assign(style, {
            '--sink-hold': `${String(fresh.sink.holdMs)}ms`,
            '--sink-word': `${String(fresh.sink.plan.perWordMs)}ms`,
            '--sink-stagger': `${String(fresh.sink.plan.staggerMs)}ms`,
          });
        }
        const state = line.role === 'question' ? (live && fresh.sink ? 'sinking' : 'dried') : undefined;
        return (
          <div
            key={line.key}
            className="pg-line"
            data-role={line.role}
            data-state={state}
            data-crossfade={(live && fresh.sink?.plan.crossfade === true) || undefined}
            data-gone={(live && fresh.sink?.gone === true) || undefined}
            data-live={live || undefined}
            dir={line.dir}
            style={style}
          >
            {line.chunks.map((chunk, index) => (
              <Chunk
                key={index}
                chunk={chunk}
                role={line.role}
                units={live}
                revealed={live ? fresh.revealed : Number.POSITIVE_INFINITY}
                animate={live && fresh.animate}
              />
            ))}
          </div>
        );
      })}
    </div>
  );
}

function Chunk({
  chunk,
  role,
  units,
  revealed,
  animate,
}: {
  chunk: LayoutChunk;
  role: PageLine['role'];
  /** Draw the chunk unit by unit (it is being written or sunk), not as one piece of text. */
  units: boolean;
  revealed: number;
  animate: boolean;
}) {
  // The `font` shorthand resets the line height: it is put back (the rows are 34 px).
  const style: CSSProperties = { font: fontOf(chunk.hand, chunk.faces, chunk.bold), lineHeight: '34px' };
  const body = units ? (
    role === 'question' ? (
      <QuestionWords units={chunk.units} />
    ) : (
      <ReplyUnits units={chunk.units} hand={chunk.hand} revealed={revealed} animate={animate} />
    )
  ) : (
    chunk.text
  );
  const content = (
    <span className={`pg-c pg-c--${chunk.hand}`} style={style}>
      {body}
    </span>
  );
  return chunk.isolate ? <bdi dir={chunk.dir}>{content}</bdi> : content;
}

/** The words of a question, each its own span so that they sink in turn (in the order of the text, which is reading order in Arabic too). */
function QuestionWords({ units }: { units: readonly LayoutUnit[] }) {
  const parts: { word: number; text: string }[] = [];
  for (const unit of units) {
    const last = parts[parts.length - 1];
    if (last?.word === unit.word) last.text += unit.text;
    else parts.push({ word: unit.word, text: unit.text });
  }
  return (
    <>
      {parts.map((part, index) =>
        part.word < 0 ? (
          <Fragment key={index}>{part.text}</Fragment>
        ) : (
          <span key={index} className="ink-q__w" style={{ '--i': part.word } as CSSProperties}>
            {part.text}
          </span>
        ),
      )}
    </>
  );
}

function ReplyUnits({
  units,
  hand,
  revealed,
  animate,
}: {
  units: readonly LayoutUnit[];
  hand: LayoutChunk['hand'];
  revealed: number;
  animate: boolean;
}) {
  return (
    <>
      {units.map((unit, index) => {
        if (unit.at >= revealed) return null;
        if (unit.kind === 'space' || unit.kind === 'break')
          return <Fragment key={index}>{unit.text}</Fragment>;
        const classes = ['ink-u', hand === 'lead' ? 'ink-u--lead' : 'ink-u--fair'];
        if (unit.kind === 'word') classes.push('ink-u--word');
        if (animate) classes.push('ink-u--new');
        return (
          <span key={index} className={classes.join(' ')}>
            {unit.text}
          </span>
        );
      })}
    </>
  );
}
