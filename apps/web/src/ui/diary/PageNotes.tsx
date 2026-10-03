import { useMemo, type CSSProperties } from 'react';
import { TRUTH_KEY, type DiaryExchange } from '../../diarypage/exchanges';
import type { DiaryPageLayout, NotePlace } from '../../diarypage/layout';
import { PITCH, fontOf, rowTop } from '../../diarypage/typography';
import { STRINGS } from '../../i18n/strings';
import { showTruth } from './showTruth';

interface PageNotesProps {
  page: DiaryPageLayout;
  exchanges: readonly DiaryExchange[];
  /** The exchange being written: its link waits until the pen has finished. */
  writingId: string | null;
  written: boolean;
}

/**
 * Under an answer, a small handwritten link, "Show me the truth": a real button. It asks the diary to show where the answer
 * comes from (the sources themselves stay in the conversation's accessible record).
 */
export function PageNotes({ page, exchanges, writingId, written }: PageNotesProps) {
  const byId = useMemo(() => new Map(exchanges.map((exchange) => [exchange.id, exchange])), [exchanges]);
  return (
    <>
      {page.notes.map((note) => {
        const exchange = byId.get(note.exchange);
        if (!exchange || note.key !== TRUTH_KEY || (note.exchange === writingId && !written)) return null;
        return (
          <TruthButton
            key={note.exchange}
            note={note}
            exchange={exchange}
            fresh={note.exchange === writingId}
          />
        );
      })}
    </>
  );
}

function TruthButton({
  note,
  exchange,
  fresh,
}: {
  note: NotePlace;
  exchange: DiaryExchange;
  fresh: boolean;
}) {
  const style: CSSProperties = {
    left: note.x,
    top: rowTop(note.row),
    width: note.width,
    height: PITCH,
    font: fontOf('note', note.faces),
  };
  return (
    <button
      type="button"
      className="pg-note"
      data-kind={note.kind}
      data-fresh={fresh || undefined}
      style={style}
      dir={note.dir}
      lang={exchange.language}
      data-testid="show-truth"
      onClick={() => {
        showTruth(exchange.id);
      }}
    >
      <span className="pg-note__label">{STRINGS[exchange.language].diary.showTruth}</span>
    </button>
  );
}
