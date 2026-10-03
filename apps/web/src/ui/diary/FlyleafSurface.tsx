import { dominantDirection, type Direction } from '@enchanted/shared';
import { useEffect, useMemo, useRef, type CSSProperties } from 'react';
import { faceSetOf } from '../../diarypage/exchanges';
import { layoutDiary, type PageLine } from '../../diarypage/layout';
import { canvasMeasure } from '../../diarypage/measure';
import { PAGE_HEIGHT, PAGE_WIDTH, columnOf, rowTop } from '../../diarypage/typography';
import { useStrings } from '../../i18n/useStrings';
import { duration } from '../../motion/durations';
import { choreography, leadLength, replyStartAt } from '../../motion/ink';
import { useAnchorStore } from '../../state/anchorStore';
import { useSettingsStore } from '../../state/settingsStore';
import { AccessibleFlyleafLog } from './AccessibleFlyleafLog';
import { flyleafLine } from './flyleafLine';
import { useFlyleafStore, type FlyleafExchange } from './flyleafStore';
import { displayText, parseAnswer, plainText } from './format';
import { buildInkDoc, leadUnitCount } from './inkDoc';
import { PageLines, type FreshInk } from './PageLines';
import { PenFront } from './PenFront';
import { QuillInput, type QuillInputHandle } from './QuillInput';
import { getDraft, setDraft } from './quillDraft';
import { wordsOf } from './segment';
import { submitText } from './submit';
import { SurfaceControls } from './SurfaceControls';
import { useReveal } from './useReveal';
import { useKeyboardInset, useLivePage, useSurfacePlacement, useSurfaceReady } from './useSurface';

/** The row of the flyleaf where the diary's words begin (under the invitation the book's own page carries), and where the quill is. */
const FIRST_ROW = 4;
const QUILL_ROW = 6;

/** The diary's scripted line for an exchange on the flyleaf, in the language of the question's script. */

/**
 * Before there is a manuscript, the reader may write on the flyleaf of the book: the camera dives onto it, the invitation the
 * page carries stays where it is, and the words are written under it. They sink into the blank paper and the diary replies in
 * its own scripted voice, in the diary's hand: lines about having nothing to remember yet, never an answer about any content.
 * Nothing is kept: the flyleaf is not a diary page.
 */
export function FlyleafSurface() {
  const { t } = useStrings();
  const current = useFlyleafStore((state) => state.current);
  const ready = useSurfaceReady();
  const element = useRef<HTMLElement>(null);
  const quill = useRef<QuillInputHandle>(null);
  useSurfacePlacement(element);
  useLivePage(ready, 0, false);
  useKeyboardInset(true);
  const book = useAnchorStore((state) => state.layoutDirection);
  const column = columnOf(book);
  useEffect(() => {
    if (ready) quill.current?.focus();
  }, [ready]);
  return (
    <section
      ref={element}
      className="diary-surface diary-surface--flyleaf"
      aria-label={t.diary.leafLabel}
      data-ready={ready}
      data-placed="false"
      data-testid="diary-surface"
      inert={!ready}
      style={{ width: PAGE_WIDTH, height: PAGE_HEIGHT }}
    >
      {current && <FlyleafInk key={current.id} exchange={current} book={book} />}
      <div
        className="pg-quill"
        style={
          {
            top: rowTop(QUILL_ROW),
            left: column.left,
            width: column.width,
            '--quill-rows': 1,
          } as CSSProperties
        }
      >
        <QuillInput
          handle={quill}
          initialValue={getDraft()}
          onValueChange={setDraft}
          placeholder={t.invitation.writePrompt}
          onSubmit={(text) => submitText(text) === 'sent'}
        />
      </div>
      <SurfaceControls pages={1} page={0} book={book} />
      <AccessibleFlyleafLog exchange={current} />
    </section>
  );
}

function FlyleafInk({ exchange, book }: { exchange: FlyleafExchange; book: Direction }) {
  const ctx = useStrings();
  const reduced = useSettingsStore((state) => state.reducedMotionResolved);
  const line = flyleafLine(exchange, ctx.language);
  const plan = useMemo(
    () => choreography(wordsOf(exchange.question).length, reduced),
    [exchange.question, reduced],
  );
  const id = String(exchange.id);
  const { lines, total, rtl } = useMemo(() => {
    const paragraphs = parseAnswer(displayText(line.text, false), false);
    const doc = buildInkDoc(paragraphs);
    const plain = plainText(paragraphs);
    const base = {
      id,
      question: exchange.question,
      answer: doc,
      leadUnits: leadUnitCount(doc, leadLength(plain)),
      questionFaces: faceSetOf(exchange.question),
      answerFaces: faceSetOf(plain),
      notes: [],
      noteFaces: 'latin' as const,
    };
    // The question and the reply are written in the same place (the question is gone before the reply begins), so they are
    // laid out apart, both from the first row.
    const asked = layoutDiary([{ ...base, answer: null }], { book, measure: canvasMeasure });
    const answered = layoutDiary([{ ...base, question: '' }], { book, measure: canvasMeasure });
    const place = (lines: readonly PageLine[], role: PageLine['role']): PageLine[] =>
      lines.filter((entry) => entry.role === role).map((entry) => ({ ...entry, row: entry.row + FIRST_ROW }));
    return {
      lines: [
        ...place(asked.pages[0]?.lines ?? [], 'question'),
        ...place(answered.pages[0]?.lines ?? [], 'answer'),
      ],
      total: doc.total,
      rtl: dominantDirection(plain) === 'rtl',
    };
  }, [exchange.question, id, line.text, book]);
  const revealed = useReveal({
    startAt: replyStartAt(exchange.at, exchange.at, plan),
    available: total,
    endedAt: null,
    settled: true,
    stepMs: duration(rtl ? 'replyWordStagger' : 'replyStagger', false),
    enabled: !reduced,
  });
  const fresh: FreshInk = {
    exchange: id,
    revealed,
    animate: true,
    sink: { plan: plan.sink, holdMs: plan.sinkStartMs, gone: true },
  };
  return (
    <>
      <PageLines lines={lines} book={book} fresh={fresh} />
      <PenFront revealed={revealed} active={!reduced && rtl && revealed < total} />
    </>
  );
}
