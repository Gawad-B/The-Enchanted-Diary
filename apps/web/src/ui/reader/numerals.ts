import type { Language } from '../../i18n/strings';

/**
 * Digits for the numbers of the reader's chrome (page indicator, "Go to page", thumbnails): the INTERFACE language's,
 * whatever the manuscript is written in (global section I: UI-chrome numerals follow the interface language; ruling R2).
 * An Arabic interface shows Arabic-Indic digits even over an English manuscript, and an English interface shows Western
 * digits even over an Arabic one. A page number has no grouping separators.
 */
export function pageNumberFormat(interfaceLanguage: Language): (value: number) => string {
  const format = new Intl.NumberFormat(interfaceLanguage === 'ar' ? 'ar-u-nu-arab' : 'en', {
    useGrouping: false,
  });
  return (value) => format.format(value);
}
