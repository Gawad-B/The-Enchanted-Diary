import { forwardRef } from 'react';
import { createStringsContext } from '../../i18n/useStrings';
import type { DiaryExchange } from '../../diarypage/exchanges';
import type { Turn } from '../../state/chatTurn';
import { AskFailure } from '../diary/AskFailure';
import type { Chip } from '../diary/citations';
import { detectLang, firstStrongDirection } from '../diary/language';

interface ExchangeCardProps {
  exchange: DiaryExchange;
  /** The turn behind the current exchange (for the notice of a question that could not be answered). */
  turn: Turn | null;
  /** What the diary is doing while it has not begun to write (already in the language of the exchange). */
  waiting: string;
  onTruth: (chip: Chip, opener: HTMLElement) => void;
}

/**
 * One exchange on a parchment card: the question, the answer under it in the same hand, and, under the answer, the one link
 * that checks it ("Show me the truth"). Every piece of text carries its own `lang` and `dir`: the question and the answer are
 * the reader's and the diary's words, which need not be in the language of the interface.
 */
export const ExchangeCard = forwardRef<HTMLElement, ExchangeCardProps>(function ExchangeCard(
  { exchange, turn, waiting, onTruth },
  ref,
) {
  const ctx = createStringsContext(exchange.language);
  const chip = exchange.chips[0];
  const showTruth = exchange.notes.length > 0 && chip !== undefined;
  const answerParagraphs = exchange.plain === '' ? [] : exchange.plain.split(/\n{2,}/u);
  const pending = exchange.current && !exchange.failed && exchange.plain === '';
  return (
    <article className="simple-card" ref={ref} data-testid="exchange-card" data-current={exchange.current}>
      <p
        className="simple-card__question"
        lang={detectLang(exchange.question) ?? exchange.language}
        dir={firstStrongDirection(exchange.question)}
      >
        {exchange.question}
      </p>
      {answerParagraphs.map((paragraph, index) => (
        <p
          key={`${exchange.id}-${String(index)}`}
          className="simple-card__answer"
          lang={exchange.language}
          dir={firstStrongDirection(paragraph)}
        >
          {paragraph}
        </p>
      ))}
      {pending && (
        <p className="simple-card__wait" aria-hidden="true" lang={exchange.language} dir={ctx.direction}>
          {waiting}
        </p>
      )}
      {exchange.failed && turn !== null && <AskFailure turn={turn} language={exchange.language} />}
      {showTruth && (
        <button
          type="button"
          className="simple-card__truth"
          lang={exchange.language}
          dir={ctx.direction}
          onClick={(event) => {
            onTruth(chip, event.currentTarget);
          }}
        >
          {ctx.t.diary.showTruth}
        </button>
      )}
    </article>
  );
});
