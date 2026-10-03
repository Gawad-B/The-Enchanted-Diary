import { useMemo } from 'react';
import { createStringsContext, useStrings } from '../../i18n/useStrings';
import { useChatStore } from '../../state/chatStore';
import { pairMessages } from '../../state/chatTurn';
import { chipsOf } from './citations';
import { displayText, parseAnswer, plainText } from './format';
import { detectLang, scriptLanguage } from './language';

/**
 * Every earlier exchange as real text, in order, for assistive technology: the pages of the diary are ink on paper and only
 * the page being written on is on the screen, and the oldest exchanges may no longer be on any page (the diary keeps a few
 * leaves), so the whole conversation is here, once. A plain list, not a live region: only the exchange being written is announced.
 */
export function AccessibleHistory() {
  const ctx = useStrings();
  const { t, language } = ctx;
  const messages = useChatStore((state) => state.messages);
  const exchanges = useMemo(() => pairMessages(messages), [messages]);
  if (exchanges.length === 0) return null;
  return (
    <div className="visually-hidden" role="group" aria-label={t.diary.pageSoFar} data-testid="diary-history">
      {exchanges.map(({ question, answer }) => {
        const own = createStringsContext(scriptLanguage(question.content, language));
        const body = answer
          ? answer.mode === 'not_found'
            ? own.t.ask.notFound
            : answer.mode === 'passages'
              ? own.t.ask.passages
              : plainText(parseAnswer(displayText(answer.content, false), false))
          : null;
        const pages = answer
          ? chipsOf(answer.citations).map((chip) =>
              chip.pageEnd > chip.pageStart
                ? own.format(own.t.citation.pages, {
                    from: own.formatNumber(chip.pageStart),
                    to: own.formatNumber(chip.pageEnd),
                  })
                : own.format(own.t.citation.page, { n: own.formatNumber(chip.pageStart) }),
            )
          : [];
        const lang = detectLang(question.content);
        return (
          <article key={question.id} {...(lang ? { lang } : {})}>
            <p dir="auto">{ctx.format(t.diary.youWrote, { text: question.content })}</p>
            {body !== null && (
              <p dir="auto">
                {ctx.format(t.diary.diaryWrote, { text: body })}
                {pages.length > 0 &&
                  ` ${ctx.format(t.diary.pagesNamed, { pages: pages.join(own.language === 'ar' ? '، ' : ', ') })}`}
              </p>
            )}
          </article>
        );
      })}
    </div>
  );
}
