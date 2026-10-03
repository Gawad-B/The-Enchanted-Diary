import { STRINGS, type Language, type Strings } from '../../i18n/strings';
import { scriptLanguage } from './language';

/**
 * The diary's own lines for a question: they follow the script of the question (global section I), whatever the interface
 * language is: an Arabic question is answered in Arabic words, a Latin-script one in English.
 */
export function diaryLines(question: string, interfaceLanguage: Language): Strings['ask'] {
  return STRINGS[scriptLanguage(question, interfaceLanguage)].ask;
}
