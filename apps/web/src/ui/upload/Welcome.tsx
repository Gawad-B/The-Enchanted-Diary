import { useStrings } from '../../i18n/useStrings';
import { experienceStore, useExperienceStore } from '../../state/experience';

/**
 * The welcome screen (owner direction T.3a): the title, and ONE button. The book lies open behind it and leafs through
 * itself slowly. Pressing the button (or the book) plays the long riffle that opens the diary.
 */
export function Welcome() {
  const { t } = useStrings();
  const phase = useExperienceStore((state) => state.phase);
  const sessionChecked = useExperienceStore((state) => state.sessionChecked);
  if (phase !== 'discovery' || !sessionChecked) return null;
  return (
    <div className="welcome" data-testid="welcome">
      <p className="welcome__title" aria-hidden="true">
        {t.app.title}
      </p>
      <button
        type="button"
        className="button welcome__start"
        onClick={() => {
          experienceStore.getState().dispatch({ type: 'INTERACT' });
        }}
      >
        {t.welcome.start}
      </button>
    </div>
  );
}
