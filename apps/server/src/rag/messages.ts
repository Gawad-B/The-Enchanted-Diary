import { detectQuestionLanguage, resolveAnswerLanguage } from './language.js';

/**
 * What the diary says when a guard refuses, in the language of the question (Lab 2's NOT_FOUND dictionary: English and
 * Arabic verbatim, the other languages in the same words). A question in a language without a line here gets English.
 */
export const NOT_FOUND_MESSAGES: Readonly<Record<string, string>> = {
  en: 'I could not find this information in the document. The provided PDF does not appear to cover this topic.',
  ar: 'لم أتمكن من العثور على هذه المعلومة في المستند. يبدو أن ملف PDF المقدَّم لا يغطي هذا الموضوع.',
  fr: 'Je n’ai pas trouvé cette information dans le document. Le PDF fourni ne semble pas couvrir ce sujet.',
  es: 'No pude encontrar esta información en el documento. El PDF proporcionado no parece cubrir este tema.',
  de: 'Ich konnte diese Information im Dokument nicht finden. Das bereitgestellte PDF scheint dieses Thema nicht abzudecken.',
  it: 'Non ho trovato questa informazione nel documento. Il PDF fornito non sembra trattare questo argomento.',
  pt: 'Não encontrei esta informação no documento. O PDF fornecido não parece abordar este tema.',
  tr: 'Bu bilgiyi belgede bulamadım. Sağlanan PDF bu konuyu kapsıyor gibi görünmüyor.',
};

export const notFoundMessageFor = (languageCode: string): string =>
  NOT_FOUND_MESSAGES[languageCode] ?? NOT_FOUND_MESSAGES.en ?? '';

/**
 * The refusal sentence for a question: in the question's language, else (the question's language is not known) in the
 * document's, else in English, the one line every language has.
 */
export const notFoundText = (question: string, documentLanguage = ''): string =>
  notFoundMessageFor(resolveAnswerLanguage(detectQuestionLanguage(question), documentLanguage));
