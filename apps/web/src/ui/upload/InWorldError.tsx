import type { UiError } from '../../api/client';
import { useStrings } from '../../i18n/useStrings';
import { useConfigStore } from '../../state/configStore';
import { describeError, technicalLine } from './errorText';

/**
 * An error as the diary tells it: the in-world line first, with the technical code and message in a smaller ordinary
 * font under it (research section 7). `role="alert"`: it is announced the moment it appears. These are errors of the
 * upload and the reading (never of a question), so a 400 that is "not a question" reads as an internal fault.
 */
export function InWorldError({ error }: { error: UiError }) {
  const ctx = useStrings();
  const config = useConfigStore((state) => state.config);
  const technical = technicalLine(error, ctx.language);
  return (
    <div className="in-world-error" role="alert">
      <p className="in-world-error__line">{describeError(error, ctx, config, { outsideAsk: true })}</p>
      {technical !== '' && (
        <p className="technical in-world-error__technical">
          <span className="visually-hidden">{ctx.t.spell.technicalLabel}: </span>
          {technical}
        </p>
      )}
    </div>
  );
}
