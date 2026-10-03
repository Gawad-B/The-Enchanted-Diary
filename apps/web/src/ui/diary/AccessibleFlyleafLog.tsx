import { STRINGS } from '../../i18n/strings';
import { useStrings } from '../../i18n/useStrings';
import type { FlyleafExchange } from './flyleafStore';
import { flyleafLine } from './flyleafLine';
import { detectLang } from './language';

/**
 * The flyleaf's record for assistive technology: what the reader wrote and what the diary said, as a polite log (a live region
 * has to exist before it has something to say, so it is always there).
 */
export function AccessibleFlyleafLog({ exchange }: { exchange: FlyleafExchange | null }) {
  const ctx = useStrings();
  const { t } = ctx;
  const line = exchange ? flyleafLine(exchange, ctx.language) : null;
  const lang = exchange ? detectLang(exchange.question) : undefined;
  return (
    <div
      className="visually-hidden"
      role="log"
      aria-live="polite"
      aria-label={t.diary.log}
      data-testid="diary-log"
    >
      {exchange && line && (
        <>
          <p dir="auto" {...(lang ? { lang } : {})}>
            {ctx.format(t.diary.youWrote, { text: exchange.question })}
          </p>
          <p dir="auto" lang={line.language}>
            {ctx.format(STRINGS[line.language].diary.diaryWrote, { text: line.text })}
          </p>
        </>
      )}
    </div>
  );
}
