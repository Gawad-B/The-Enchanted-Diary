import { useEffect, useRef } from 'react';
import { STRINGS } from '../../i18n/strings';
import { useStrings } from '../../i18n/useStrings';
import type { DiaryExchange } from '../../diarypage/exchanges';
import type { DiaryLayout, DiaryPageLayout } from '../../diarypage/layout';
import { useDiaryLayout } from '../../diarypage/service';
import { PAGE_HEIGHT, PAGE_WIDTH, ROWS, columnOf, rowTop } from '../../diarypage/typography';
import { useAnchorStore } from '../../state/anchorStore';
import { isAsking, useChatStore } from '../../state/chatStore';
import type { Turn } from '../../state/chatTurn';
import { diaryBookStore, useDiaryBook } from '../../state/diaryBook';
import { useSettingsStore } from '../../state/settingsStore';
import { AccessibleHistory } from './AccessibleHistory';
import { AccessibleLog } from './AccessibleLog';
import { AskFailure } from './AskFailure';
import { ListeningLine } from './ListeningLine';
import { PageLines } from './PageLines';
import { PageNotes } from './PageNotes';
import { PenFront } from './PenFront';
import { QuillInput, type QuillInputHandle } from './QuillInput';
import { getDraft, setDraft } from './quillDraft';
import { submitText } from './submit';
import { SurfaceControls } from './SurfaceControls';
import { useCurrentInk } from './useCurrentInk';
import { useKeyboardInset, useLivePage, useSurfacePlacement, useSurfaceReady } from './useSurface';

const NO_PAGE: DiaryPageLayout = { index: 0, lines: [], notes: [] };

/** The rows a page keeps after the last of its lines for the quill (its own row, and the Write button's). */
const QUILL_ROWS_MAX = 4;

/**
 * The page the reader writes on (global section T): the diary's own leaf, bound at the front of the book, with the camera
 * dived onto it. The surface is the page itself, 520 by 728 px, laid onto the 3D leaf with the page's own perspective, so the
 * quill, the ink and the notes are on the paper. It shows the lines of the diary page the book is turned to (earlier exchanges
 * as dried ink), the exchange being written as it lands, the real textarea where the next question goes, and the page's
 * controls. It is shown only while the book is still, and the page's texture is drawn without ink under it meanwhile.
 */
export function WritingSurface() {
  const { t } = useStrings();
  const page = useDiaryBook((state) => state.page);
  const layoutState = useDiaryLayout((state) => state.layout);
  const exchanges = useDiaryLayout((state) => state.exchanges);
  const turn = useChatStore((state) => state.turn);
  const ready = useSurfaceReady();
  const element = useRef<HTMLElement>(null);
  useSurfacePlacement(element);
  useLivePage(ready, page);
  useKeyboardInset(true);

  const last = exchanges.at(-1);
  const current = last?.current === true && turn !== null && last.id === turn.id ? last : null;
  return (
    <section
      ref={element}
      className="diary-surface"
      aria-label={t.diary.leafLabel}
      data-ready={ready}
      data-placed="false"
      data-testid="diary-surface"
      inert={!ready}
      style={{ width: PAGE_WIDTH, height: PAGE_HEIGHT }}
    >
      {current && turn ? (
        <CurrentPage
          key={`${turn.id}:${String(turn.attempt)}`}
          layout={layoutState}
          page={page}
          exchange={current}
          exchanges={exchanges}
          turn={turn}
          ready={ready}
        />
      ) : (
        <PageBody
          layout={layoutState}
          page={page}
          exchanges={exchanges}
          turn={turn}
          current={null}
          ink={null}
          ready={ready}
        />
      )}
      <AccessibleLog turn={turn} />
      <AccessibleHistory />
    </section>
  );
}

type Ink = ReturnType<typeof useCurrentInk>;

interface PageBodyProps {
  layout: DiaryLayout;
  page: number;
  exchanges: readonly DiaryExchange[];
  turn: Turn | null;
  current: DiaryExchange | null;
  ink: Ink | null;
  ready: boolean;
}

/** The page of an exchange being written: it works out how far the pen has got, and keeps the book turned to where the pen is. */
function CurrentPage(
  props: Omit<PageBodyProps, 'current' | 'ink'> & { exchange: DiaryExchange; turn: Turn },
) {
  const { exchange, turn, layout, page } = props;
  const ink = useCurrentInk(exchange, turn);
  const target = pageOfPen(layout, exchange, ink);
  // The reply has run onto the next page, or the question has been answered and the next one is on a fresh page: turn to it.
  useEffect(() => {
    if (target > page) diaryBookStore.getState().turnTo(target);
    // Only when the pen gets there (the target changes), never against the reader who turned back to read.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target]);
  return <PageBody {...props} turn={turn} current={exchange} ink={ink} />;
}

/** The page the pen is on: the page of the piece of ink it has written last, and the page of the quill once the answer is written. */
export function pageOfPen(layout: DiaryLayout, exchange: DiaryExchange, ink: Ink): number {
  const span = layout.spans[exchange.id];
  if (!span) return 0;
  // Once written, the answer stays in view: the next question is written on a fresh page, reached when the reader begins to write.
  if (ink.written) return span.lastPage;
  let target = span.questionFrom.page;
  for (const page of layout.pages) {
    for (const line of page.lines) {
      if (line.exchange === exchange.id && line.role === 'answer' && line.pieceFrom < ink.fresh.revealed) {
        target = Math.max(target, page.index);
      }
    }
  }
  return target;
}

function PageBody({ layout, page, exchanges, turn, current, ink, ready }: PageBodyProps) {
  const book = useAnchorStore((state) => state.layoutDirection);
  const reduced = useSettingsStore((state) => state.reducedMotionResolved);
  const busy = useChatStore((state) => isAsking(state.askStatus));
  const pageLayout = layout.pages[page] ?? NO_PAGE;
  const column = columnOf(book);
  const span = current ? layout.spans[current.id] : undefined;
  const quill = useRef<QuillInputHandle>(null);
  const writing = ink?.fresh.exchange ?? null;
  // The quill is where the next question goes: after the last exchange, once the diary has finished writing it.
  const quillHere = layout.next.page === page && (turn === null || ink === null || ink.written);
  const rowsLeft = Math.min(Math.max(ROWS - layout.next.row, 1), QUILL_ROWS_MAX);

  // The reader writes as soon as the page is theirs: the textarea has the focus when the surface is up and when the diary has finished.
  useEffect(() => {
    if (ready && quillHere) quill.current?.focus();
  }, [ready, quillHere, turn?.id]);

  // Beginning to write beside an answer turns the book one leaf to the fresh page, and the first letter goes with the reader.
  useEffect(() => {
    if (!ready || layout.next.page <= page || (turn !== null && !(ink?.written ?? true))) return undefined;
    const onKey = (event: KeyboardEvent): void => {
      if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey || event.key.length !== 1)
        return;
      const target = event.target;
      if (
        target instanceof HTMLElement &&
        target.closest('button, a, input, textarea, [role="menu"], [role="dialog"]')
      )
        return;
      event.preventDefault();
      setDraft(getDraft() + event.key);
      diaryBookStore.getState().turnTo(layout.next.page);
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
    };
  }, [ready, layout.next.page, page, turn, ink?.written]);

  // Under the last answer, once it is written: what to do next (typing goes on to the next page).
  const lastExchange = exchanges.at(-1);
  const lastSpan = lastExchange ? layout.spans[lastExchange.id] : undefined;
  const hintRow =
    lastExchange &&
    lastSpan?.end.page === page &&
    lastSpan.end.row < ROWS &&
    layout.next.page > page &&
    !lastExchange.failed &&
    lastExchange.answer !== null &&
    (ink?.written ?? true)
      ? lastSpan.end.row
      : null;
  const hintLanguage = lastExchange?.language ?? 'en';
  const hintDir = hintLanguage === 'ar' ? 'rtl' : 'ltr';
  const language = current?.language ?? 'en';
  return (
    <>
      <PageLines lines={pageLayout.lines} book={book} fresh={ink?.fresh ?? null} />
      {ink && <PenFront revealed={ink.fresh.revealed} active={ink.penFront} />}
      <PageNotes page={pageLayout} exchanges={exchanges} writingId={writing} written={ink?.written ?? true} />
      {turn &&
        current &&
        span?.afterQuestion.page === page &&
        turn.status !== 'failed' &&
        ink &&
        !ink.writing && (
          <div
            className="pg-aside"
            style={{ top: rowTop(span.afterQuestion.row), left: column.left, width: column.width }}
          >
            <ListeningLine turn={turn} waiting language={language} />
          </div>
        )}
      {turn && current && span?.tailFrom.page === page && turn.status === 'failed' && (
        <div
          className="pg-aside"
          style={{ top: rowTop(span.tailFrom.row), left: column.left, width: column.width }}
        >
          <AskFailure turn={turn} language={language} />
        </div>
      )}
      {hintRow !== null && (
        <div
          className="pg-hint"
          dir={hintDir}
          lang={hintLanguage}
          style={{ top: rowTop(hintRow), left: column.left, width: column.width }}
        >
          <span>{STRINGS[hintLanguage].diary.nextQuestion}</span>
          <i className="pg-caret" aria-hidden="true" />
        </div>
      )}
      {quillHere && (
        <div
          className="pg-quill"
          data-reduced={reduced || undefined}
          style={
            {
              top: rowTop(layout.next.row),
              left: column.left,
              width: column.width,
              '--quill-rows': rowsLeft,
            } as React.CSSProperties
          }
        >
          <QuillInput
            handle={quill}
            busy={busy}
            initialValue={getDraft()}
            onValueChange={setDraft}
            onSubmit={(text) => submitText(text) === 'sent'}
          />
        </div>
      )}
      <SurfaceControls pages={layout.pageCount} page={page} book={book} />
    </>
  );
}
