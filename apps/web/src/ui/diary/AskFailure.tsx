import { useMemo } from 'react';
import type { Language } from '../../i18n/strings';
import { createStringsContext } from '../../i18n/useStrings';
import { chatStore } from '../../state/chatStore';
import type { Turn } from '../../state/chatTurn';
import { useConfigStore } from '../../state/configStore';
import { technicalLine } from '../upload/errorText';
import { describeAskError } from './askErrors';

/**
 * A question that could not be answered, said in the diary's own words in the language of the question: the line, the
 * technical code and detail in a line of their own, and a way to ask again (the same question, started over).
 */
export function AskFailure({ turn, language }: { turn: Turn; language: Language }) {
  const ctx = useMemo(() => createStringsContext(language), [language]);
  const config = useConfigStore((state) => state.config);
  const { error } = turn;
  if (!error) return null;
  const technical = technicalLine(error, language);
  const retryable = error.code !== 'DOCUMENT_NOT_FOUND';
  return (
    <div className="in-world-error ink-failure" role="alert">
      <p className="in-world-error__line">{describeAskError(error, ctx, config)}</p>
      {technical !== '' && <p className="technical in-world-error__technical">{technical}</p>}
      {retryable && (
        <button
          type="button"
          className="ink-failure__retry"
          onClick={() => {
            chatStore.getState().retryTurn();
          }}
        >
          {ctx.t.ask.retry}
        </button>
      )}
    </div>
  );
}
