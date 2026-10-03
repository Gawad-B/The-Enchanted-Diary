import { useEffect, useMemo, useState } from 'react';
import type { Language } from '../../i18n/strings';
import { createStringsContext } from '../../i18n/useStrings';
import type { Turn } from '../../state/chatTurn';

/** After this long without an answer the diary says it needs a moment, and then that it is searching deeper (research section 4, row 4). */
export const SLOW_AFTER_MS = 6000;
export const DEEP_AFTER_MS = 15000;

type WaitLevel = 0 | 1 | 2;

const levelAt = (elapsedMs: number): WaitLevel =>
  elapsedMs >= DEEP_AFTER_MS ? 2 : elapsedMs >= SLOW_AFTER_MS ? 1 : 0;

/** 0 until the slow line, 1 from it, 2 from the deep-search line; the clock is only woken at those two moments. */
function useWaitLevel(since: number, active: boolean): WaitLevel {
  const [level, setLevel] = useState<WaitLevel>(() => levelAt(Date.now() - since));
  useEffect(() => {
    if (!active) return undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const check = (): void => {
      const elapsed = Date.now() - since;
      const current = levelAt(elapsed);
      setLevel(current);
      if (current === 2) return;
      timer = setTimeout(check, (current === 0 ? SLOW_AFTER_MS : DEEP_AFTER_MS) - elapsed);
    };
    check();
    return () => {
      clearTimeout(timer);
    };
  }, [since, active]);
  return level;
}

interface ListeningLineProps {
  turn: Turn;
  /** The pen has not started writing the reply yet. */
  waiting: boolean;
  /** The language the diary speaks in for this question: its script, whatever the interface language is. */
  language: Language;
}

/**
 * The diary listening: an in-world line (by the stage the server reports, then "give me a moment" and "still searching the
 * deeper pages" as the wait grows) with an ink-well that breathes, and, once the search is done, the REAL figures of it
 * ("Searched 312 passages · pages 3, 7, 12"). Polite live region: the stage lines are announced as they change.
 */
export function ListeningLine({ turn, waiting, language }: ListeningLineProps) {
  const ctx = useMemo(() => createStringsContext(language), [language]);
  const { t } = ctx;
  const level = useWaitLevel(turn.submittedAt, waiting);
  if (!waiting) return null;
  const line =
    level === 2
      ? t.progress.longWait
      : level === 1
        ? t.progress.slow
        : turn.stage === 'rewriting'
          ? t.ask.rewriting
          : turn.stage === 'retrieving'
            ? t.ask.retrieving
            : turn.stage === 'generating'
              ? t.ask.generating
              : t.ask.answering;
  const search = turn.retrieval;
  const pages = search?.pages.map((page) => ctx.formatNumber(page)).join(ctx.language === 'ar' ? '، ' : ', ');
  const technical = search
    ? [
        ctx.format(pages ? t.ask.retrievalLine : t.ask.retrievalNoPages, {
          n: ctx.formatNumber(search.searchedChunks),
          pages: pages ?? '',
        }),
        search.evidence === 'weak' ? t.ask.weakMatch : null,
      ]
        .filter((part): part is string => part !== null)
        .join(' · ')
    : null;
  return (
    <div className="ink-listening" role="status" data-level={level}>
      <span className="ink-listening__well" aria-hidden="true" />
      <p className="ink-listening__line">{line}</p>
      {technical !== null && <p className="technical ink-listening__technical">{technical}</p>}
    </div>
  );
}
