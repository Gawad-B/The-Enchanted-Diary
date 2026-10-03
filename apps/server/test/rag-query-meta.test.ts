import { describe, expect, it } from 'vitest';
import { isMetaQuestion } from '../src/rag/query.js';

/*
 * Which questions are about the document as a whole (fix round 4, review N3-3): the follow-up whose only topic is a pronoun, and a
 * topic that is a filler word elsewhere. The rest of the phrasings are in rag-round2.test.ts and rag-language.test.ts.
 */

describe('a follow-up whose only topic is a pronoun, and topics that are filler words elsewhere (review N3-3)', () => {
  it.each([
    'What does the document say about it?',
    'What does the document say about that?',
    'What does the document say about them?',
    'Summarize that',
    'Summarise it',
    'Summarize this',
    'Tell me about the document and what it says',
    'ماذا يقول المستند عن ذلك؟',
    'ماذا يقول المستند عنه؟',
    'ماذا تقول الوثيقة عنها؟',
    'لخص ذلك',
  ])(
    'is not about the whole document when there is an earlier question to resolve it from: %s',
    (question) => {
      expect(isMetaQuestion(question, { followUp: true }), question).toBe(false);
    },
  );

  it.each(['What does the document say about it?', 'Summarise it', 'ماذا يقول المستند عنه؟'])(
    'is still about the whole document when nothing came before it: %s',
    (question) => {
      expect(isMetaQuestion(question), question).toBe(true);
      expect(isMetaQuestion(question, { followUp: false }), question).toBe(true);
    },
  );

  it.each([
    'Summarize this document',
    'What does this document say?',
    'What does the document say?',
    'Give me a summary in English',
    'Summarize the document in three sentences',
    'ماذا يقول المستند؟',
    'ما الفكرة الرئيسية لهذا المستند؟',
    'What is it about?',
    'Give me an overview about the document',
    'Tell me about this document',
  ])(
    'does not take "this document", "this" before a document noun or an overview request for a pronoun: %s',
    (question) => {
      expect(isMetaQuestion(question, { followUp: true }), question).toBe(true);
    },
  );

  it.each([
    'What does the document say about translation?',
    'What does the document say about English?',
    'What does the document say about the book?',
    'What does the document say about the content?',
    'What does the document say about Arabic?',
    'What does this PDF say about the text of the oath?',
    'ماذا يقول المستند عن الإنجليزية؟',
    'ماذا يقول المستند عن الكتاب؟',
    'ماذا يقول المستند عن الترجمة؟',
  ])(
    'searches a topic that is a language, a kind of request or a document noun elsewhere: %s',
    (question) => {
      expect(isMetaQuestion(question), question).toBe(false);
    },
  );
});
