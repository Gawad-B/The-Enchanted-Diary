import { describe, expect, it } from 'vitest';
import {
  detectQuestionLanguage,
  isSameLanguage,
  languageName,
  resolveAnswerLanguage,
} from '../src/rag/language.js';
import { NOT_FOUND_MESSAGES, notFoundText } from '../src/rag/messages.js';
import {
  isMetaQuestion,
  parsePageReferences,
  properNameTokens,
  queryTokens,
  refersToVisiblePages,
  withoutPageVocabulary,
} from '../src/rag/query.js';

/*
 * The language of a short question, the stopwords of the six required Latin-script languages (accents and elisions
 * included), and the small readings of a question that decide guard 1: identifiers, proper names, pages, "about the whole
 * document". Review issues I-6, I-10, I-11 and the minors M-8.
 */

describe('the language of a short Latin-script question', () => {
  const cases: [string, string][] = [
    ['Who founded the library?', 'en'],
    ['What is the capital of Peru?', 'en'],
    ['Qui a fondé la bibliothèque ?', 'fr'],
    ["Où se trouve l'université ?", 'fr'],
    ["Qu'est-ce que c'est ?", 'fr'],
    ['¿Quién fundó la biblioteca?', 'es'],
    ['¿Dónde está la biblioteca?', 'es'],
    ['Wer hat die Bibliothek gegründet?', 'de'],
    ['Wie viel kostet das Studium?', 'de'],
    ['Chi ha fondato la biblioteca?', 'it'],
    ['Quem fundou a biblioteca?', 'pt'],
    ['Kütüphaneyi kim kurdu?', 'tr'],
    ['من أسس المكتبة؟', 'ar'],
  ];

  it.each(cases)(
    '%s is %s (the franc detector needs 40 letters; function words and accents decide a short one)',
    (question, code) => {
      expect(detectQuestionLanguage(question)).toBe(code);
    },
  );

  it('says `und` for a question nothing tells, never "English"', () => {
    expect(detectQuestionLanguage('Peru capital?')).toBe('und');
    expect(detectQuestionLanguage('1847?')).toBe('und');
  });

  it('answers in the document’s language when the question’s is not known, else in the question’s', () => {
    expect(resolveAnswerLanguage('und', 'ar')).toBe('ar');
    expect(resolveAnswerLanguage('fr', 'ar')).toBe('fr');
    expect(resolveAnswerLanguage('und', 'und')).toBe('und');
    expect(resolveAnswerLanguage('und', '')).toBe('und');
    expect(notFoundText('Peru capital?', 'ar')).toBe(NOT_FOUND_MESSAGES.ar);
    expect(notFoundText('Peru capital?', '')).toBe(NOT_FOUND_MESSAGES.en);
    expect(notFoundText('Qui a fondé la bibliothèque ?', 'ar')).toBe(NOT_FOUND_MESSAGES.fr);
    expect(languageName('und')).toBeNull();
    expect(languageName('fr')).toBe('French');
  });

  it('is the same language, a different one, or null when either is not known (the gate then takes the lower floor)', () => {
    expect(isSameLanguage('Who founded the library?', 'en')).toBe(true);
    expect(isSameLanguage('Who founded the library?', 'ar')).toBe(false);
    expect(isSameLanguage('من أسس المكتبة؟', 'ar')).toBe(true);
    expect(isSameLanguage('Peru capital?', 'en')).toBeNull();
    expect(isSameLanguage('Who founded the library?', 'und')).toBeNull();
    expect(isSameLanguage('Who founded the library?', '')).toBeNull();
  });
});

describe('the stopwords of the Latin-script languages are written as the normaliser leaves a word', () => {
  it.each([
    ['Où était-il très souvent ?', []],
    ['¿Dónde está la biblioteca y cómo se llama?', ['biblioteca', 'llama']],
    ["Qu'est-ce que c'est ?", []],
    ['Nasıl çok değil için?', []],
    ['Wo ist die Bibliothek für Kinder?', ['bibliothek', 'kinder']],
    ['Quelle était la capitale du Pérou ?', ['capitale', 'pérou']],
    ['Perché è così più importante?', ['importante']],
    ['Quando não está também aqui?', []],
  ])('%s -> %j', (question, tokens) => {
    expect(queryTokens(question)).toEqual(tokens);
  });

  it('still keeps the words and the numbers that say something', () => {
    expect(queryTokens('When was MS-4471 written in 1847?')).toEqual(['ms', '4471', 'written', '1847']);
  });
});

describe('identifiers are searched whole and in parts', () => {
  it('splits letters from digits, so "ms4471" finds "MS 4471" and "MS-4471" alike', () => {
    expect(queryTokens('What is ms4471?')).toEqual(['ms4471', 'ms', '4471']);
    expect(queryTokens('What is MS-4471?')).toEqual(['ms', '4471']);
    expect(queryTokens('room 12b')).toEqual(['room', '12b', '12']);
  });
});

describe('page references and the word "here"', () => {
  it('does not take a bare "here" or "هنا" for a pointer to the visible page', () => {
    expect(refersToVisiblePages('Does the university offer online programs here?')).toBe(false);
    expect(refersToVisiblePages('هل يوجد برنامج هنا؟')).toBe(false);
    expect(refersToVisiblePages('Is it sold here?')).toBe(false);
    expect(refersToVisiblePages('What does this page say?')).toBe(true);
    expect(refersToVisiblePages('What is on the current page?')).toBe(true);
    expect(refersToVisiblePages('ماذا في هذه الصفحة؟')).toBe(true);
  });

  it('leaves nothing but the question’s own words once the page vocabulary is taken out', () => {
    expect(queryTokens(withoutPageVocabulary('What is this page about?'))).toEqual([]);
    expect(
      queryTokens(withoutPageVocabulary(parsePageReferences('What does page 4 say?', 10).remainder)),
    ).toEqual([]);
    expect(
      queryTokens(
        withoutPageVocabulary(parsePageReferences('Does page 1 mention online programs?', 10).remainder),
      ),
    ).toEqual(['mention', 'online', 'programs']);
    expect(queryTokens(withoutPageVocabulary('What is the capital of Peru on this page?'))).toEqual([
      'capital',
      'peru',
    ]);
  });
});

describe('proper names', () => {
  it('finds the capitalised words that do not start the sentence', () => {
    expect([...properNameTokens('Who is Alaric Thornquist of Port Alderney?')]).toEqual([
      'alaric',
      'thornquist',
      'port',
      'alderney',
    ]);
    expect([...properNameTokens('What is the capital of Peru?')]).toEqual(['peru']);
    expect([...properNameTokens('Who founded the house?')]).toEqual([]);
    expect([...properNameTokens('Alaric founded it. Then Mira came.')]).toEqual(['mira']);
    expect([...properNameTokens('من أسس المكتبة؟')]).toEqual([]);
  });
});

describe('a question about the document as a whole', () => {
  it('is recognised in English, Arabic, French, Spanish and German', () => {
    for (const question of [
      'What is this document about?',
      "What's this PDF about?",
      'What does the document say?',
      'Give me a summary',
      'Summarise it please',
      'Can you give an overview of the book?',
      'What are the main points?',
      'TL;DR?',
      'ما موضوع هذا المستند؟',
      'عن ماذا يتحدث هذا الكتاب؟',
      'لخّص لي النص',
      'أعطني ملخصا',
      'De quoi parle ce document ?',
      'Résume ce texte',
      '¿De qué trata este documento?',
      'Worum geht es in diesem Dokument?',
      'Gib mir eine Zusammenfassung',
    ]) {
      expect(isMetaQuestion(question), question).toBe(true);
    }
  });

  it('is never a question that names a topic', () => {
    for (const question of [
      'Who founded the house?',
      'What is the capital of Peru?',
      'Does the university offer online programs?',
      'Summarise the section on tuition fees',
      'Summarize chapter 3',
      'Give me an overview of the admissions process and deadlines',
      'من أسس المكتبة؟',
      'لخص قسم الرسوم الدراسية في الجامعة',
    ]) {
      expect(isMetaQuestion(question), question).toBe(false);
    }
  });
});
