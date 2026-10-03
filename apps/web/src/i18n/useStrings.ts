import { directionForLanguage, type Direction } from '@enchanted/shared';
import { useMemo } from 'react';
import { useSettingsStore } from '../state/settingsStore';
import { STRINGS, format, type Language, type Strings } from './strings';

/** Direction of the interface for a language (the page direction; a document's own direction is separate). */
export function uiDirection(language: Language): Direction {
  return directionForLanguage(language);
}

export interface StringsContext {
  language: Language;
  /** The interface direction: 'rtl' for Arabic. */
  direction: Direction;
  t: Strings;
  /** Fills `{placeholders}` in a line. */
  format: typeof format;
  /** Numbers in interface chrome follow the interface language (Eastern Arabic digits for Arabic). */
  formatNumber(value: number): string;
}

/** Builds the string context for a language. Pure, so it can be used outside React and in tests. */
export function createStringsContext(language: Language): StringsContext {
  const numbers = new Intl.NumberFormat(language === 'ar' ? 'ar-u-nu-arab' : 'en');
  return {
    language,
    direction: uiDirection(language),
    t: STRINGS[language],
    format,
    formatNumber: (value) => numbers.format(value),
  };
}

/** The copy, direction and number formatting for the interface language chosen in the settings. */
export function useStrings(): StringsContext {
  const language = useSettingsStore((state) => state.uiLanguage);
  return useMemo(() => createStringsContext(language), [language]);
}
