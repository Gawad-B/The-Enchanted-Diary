import { STRINGS, type Language } from '../../i18n/strings';
import type { FlyleafExchange } from './flyleafStore';
import { scriptLanguage } from './language';

/** The diary's scripted flyleaf reply for an exchange, in the language of the visitor's writing. */
export function flyleafLine(
  exchange: FlyleafExchange,
  uiLanguage: Language,
): { text: string; language: Language } {
  const language = scriptLanguage(exchange.question, uiLanguage);
  const t = STRINGS[language];
  const text =
    exchange.line === 'nothing'
      ? t.ask.nothingToShow
      : t.preUpload[exchange.line === 'first' ? 0 : exchange.line === 'second' ? 1 : 2];
  return { text, language };
}
