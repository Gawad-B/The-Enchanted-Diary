import { useMemo } from 'react';
import { useStrings } from '../../i18n/useStrings';
import type { Turn } from '../../state/chatTurn';
import { chipsOf, consultedChips } from './citations';
import { detectLang } from './language';
import { diaryLines } from './lines';
import { displayText, parseAnswer, plainText } from './format';

/**
 * The accessible record of the exchange being written: a polite log that holds the question the moment it is asked (while the
 * ink is still sinking, and after it has sunk) and the finished answer once, at the end: never the tokens one by one. The
 * animated ink beside it is decorative and hidden from assistive technology; earlier exchanges are real text and need no log.
 */
export function AccessibleLog({ turn }: { turn: Turn | null }) {
  const ctx = useStrings();
  const { t } = ctx;
  const answer = useMemo(() => {
    if (turn?.status !== 'done' || turn.done === null) return null;
    const mode = turn.done.mode;
    const own = diaryLines(turn.question, ctx.language);
    const own2 = turn.localText;
    const body =
      own2 ??
      (mode === 'passages'
        ? own.passages
        : mode === 'not_found'
          ? own.notFound
          : plainText(parseAnswer(displayText(turn.text, false), false)));
    const chips =
      mode === 'not_found'
        ? []
        : [
            ...chipsOf(turn.citations),
            ...(turn.citations.length === 0 ? consultedChips(turn.consulted, []) : []),
          ];
    const pages = chips
      .map((chip) =>
        chip.pageEnd > chip.pageStart
          ? ctx.format(t.citation.pages, {
              from: ctx.formatNumber(chip.pageStart),
              to: ctx.formatNumber(chip.pageEnd),
            })
          : ctx.format(t.citation.page, { n: ctx.formatNumber(chip.pageStart) }),
      )
      .join(ctx.language === 'ar' ? '، ' : ', ');
    return { body, pages };
  }, [turn, t, ctx]);
  const lang = turn ? detectLang(turn.question) : undefined;
  return (
    <div
      className="visually-hidden"
      role="log"
      aria-label={t.diary.log}
      aria-live="polite"
      aria-relevant="additions text"
      data-testid="diary-log"
      {...(lang ? { lang } : {})}
    >
      {turn && <p dir="auto">{ctx.format(t.diary.youWrote, { text: turn.question })}</p>}
      {answer && (
        <p dir="auto">
          {ctx.format(t.diary.diaryWrote, { text: answer.body })}
          {answer.pages !== '' && ` ${ctx.format(t.diary.pagesNamed, { pages: answer.pages })}`}
        </p>
      )}
    </div>
  );
}
