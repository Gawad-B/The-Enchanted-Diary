import { FormattedText } from '../i18n/FormattedText';
import { useStrings } from '../i18n/useStrings';
import { useSettingsStore, settingsStore } from '../state/settingsStore';

/** Shown while the simple view is forced for this session: says why, and offers the way back. */
export function ForcedSimpleNotice() {
  const forced = useSettingsStore((state) => state.forcedSimple);
  const { t, language } = useStrings();
  if (!forced) return null;
  return (
    <div className="notice" role="status">
      <p>
        <FormattedText
          template={t.scene.forcedSimple}
          values={{
            reason: (
              <bdi className="technical-inline">
                {language === 'ar' ? t.scene.genericReason : forced.reason}
              </bdi>
            ),
          }}
        />
      </p>
      <button
        type="button"
        className="button"
        onClick={() => {
          settingsStore.getState().clearForcedSimple();
        }}
      >
        {t.scene.tryImmersiveAgain}
      </button>
    </div>
  );
}
