import { useEffect, useId, useRef, useState } from 'react';
import { useStrings } from '../../i18n/useStrings';
import {
  settingsStore,
  useSettingsStore,
  type ReducedMotionSetting,
  type UiLanguage,
} from '../../state/settingsStore';

/**
 * The one quiet control in the corner: a single icon button that opens a small panel with sound (on or off), reduced motion
 * (system, on, off) and the interface language. Everything is a real button, labelled, and keyboard operable; Escape or a
 * tap outside closes it and returns the focus to the icon. The settings persist in the settings store.
 */

const MOTION_CHOICES: readonly { value: ReducedMotionSetting; label: 'system' | 'on' | 'off' }[] = [
  { value: 'system', label: 'system' },
  { value: 'reduce', label: 'on' },
  { value: 'no-preference', label: 'off' },
];

/** Each language is named in its own words (and script), whatever the interface language is. */
const LANGUAGES: readonly { value: UiLanguage; name: string }[] = [
  { value: 'en', name: 'English' },
  { value: 'ar', name: 'العربية' },
];

export function SettingsMenu() {
  const { t } = useStrings();
  const sound = useSettingsStore((state) => state.sound);
  const reducedMotion = useSettingsStore((state) => state.reducedMotion);
  const uiLanguage = useSettingsStore((state) => state.uiLanguage);
  const setSound = (value: boolean): void => {
    settingsStore.getState().setSound(value);
  };
  const setReducedMotion = (value: ReducedMotionSetting): void => {
    settingsStore.getState().setReducedMotion(value);
  };
  const setUiLanguage = (value: UiLanguage): void => {
    settingsStore.getState().setUiLanguage(value);
  };
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const panelId = useId();

  useEffect(() => {
    if (!open) return undefined;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
      button.current?.focus();
    };
    const onPointer = (event: PointerEvent): void => {
      if (event.target instanceof Node && !root.current?.contains(event.target)) setOpen(false);
    };
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('pointerdown', onPointer, true);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('pointerdown', onPointer, true);
    };
  }, [open]);

  return (
    <div className="settings" ref={root} data-open={open || undefined}>
      <button
        type="button"
        className="settings__button"
        ref={button}
        aria-label={t.settings.button}
        aria-expanded={open}
        aria-controls={panelId}
        data-testid="settings-button"
        onClick={() => {
          setOpen(!open);
        }}
      >
        <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" focusable="false">
          <circle cx="12" cy="12" r="3.2" fill="none" stroke="currentColor" strokeWidth="1.6" />
          <path
            d="M12 3v2.4M12 18.6V21M3 12h2.4M18.6 12H21M5.6 5.6l1.7 1.7M16.7 16.7l1.7 1.7M5.6 18.4l1.7-1.7M16.7 7.3l1.7-1.7"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
          />
        </svg>
      </button>
      {open && (
        <div
          className="settings__panel"
          id={panelId}
          role="group"
          aria-label={t.settings.title}
          data-testid="settings-panel"
        >
          <div className="settings__row">
            <span className="settings__label">{t.settings.sound}</span>
            <button
              type="button"
              className="settings__choice"
              aria-pressed={sound}
              data-testid="setting-sound"
              onClick={() => {
                setSound(!sound);
              }}
            >
              {sound ? t.settings.on : t.settings.off}
            </button>
          </div>
          <div className="settings__row" role="group" aria-label={t.settings.reducedMotion}>
            <span className="settings__label" aria-hidden="true">
              {t.settings.reducedMotion}
            </span>
            {MOTION_CHOICES.map((choice) => (
              <button
                key={choice.value}
                type="button"
                className="settings__choice"
                aria-pressed={reducedMotion === choice.value}
                data-testid={`setting-motion-${choice.value}`}
                onClick={() => {
                  setReducedMotion(choice.value);
                }}
              >
                {t.settings[choice.label]}
              </button>
            ))}
          </div>
          <div className="settings__row" role="group" aria-label={t.settings.language}>
            <span className="settings__label" aria-hidden="true">
              {t.settings.language}
            </span>
            {LANGUAGES.map((language) => (
              <button
                key={language.value}
                type="button"
                className="settings__choice"
                lang={language.value}
                aria-pressed={uiLanguage === language.value}
                data-testid={`setting-language-${language.value}`}
                onClick={() => {
                  setUiLanguage(language.value);
                }}
              >
                {language.name}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
