import { describe, expect, it } from 'vitest';
import type { ExcerptView } from '../src/rag/injection.js';
import { buildAnswerMessages, buildRevealMessages } from '../src/rag/prompts.js';
import { E2E_RULES } from './doubles/e2e-rules.js';
import { ScriptedLlm, replyLanguage } from './doubles/scripted-llm.js';

/*
 * The scripted model of the end-to-end server writes in the language it is asked in (global T.2: the owner rejected English in the
 * Arabic experience, and the QA shots of the Arabic journeys showed a scripted reply that began "The document states:").
 */

const LATIN = /[A-Za-z]/u;
const MARKERS = /\[S\d+\]/gu;
/** What is the double's own wording: the reply without the sentences it quotes from the document and without its citation markers. */
const framing = (reply: string): string => reply.replace(/«[^»]*»/gu, '').replace(MARKERS, '');

const excerpt = (text: string, language: string): ExcerptView => ({
  id: 'S1',
  pageStart: 1,
  pageEnd: 1,
  sectionTitle: null,
  language,
  text,
  flagged: false,
});
const ENGLISH_EXCERPT = excerpt(
  'The house was founded by Alaric Thornquist in 1847. It had seven rooms.',
  'en',
);
const ARABIC_EXCERPT = excerpt('أسس يوسف المكتبة في عام 1912. كانت تضم ثلاث قاعات.', 'ar');

async function reply(
  llm: ScriptedLlm,
  built: { system: string; messages: { role: 'user' | 'assistant'; content: string }[] },
) {
  let text = '';
  for await (const piece of llm.stream({ ...built, maxTokens: 400, temperature: 0 })) text += piece;
  return text;
}

const answerTo = (question: string, excerpts: ExcerptView[]) =>
  reply(
    new ScriptedLlm(E2E_RULES),
    buildAnswerMessages({
      question,
      history: [],
      excerpts,
      document: { filename: 'x.pdf' },
      evidence: 'strong',
    }),
  );

describe('an answer of the scripted model is in the language of the question', () => {
  it('frames an Arabic answer in Arabic, with no Latin letter outside the sentence it quotes', async () => {
    for (const excerpts of [[ARABIC_EXCERPT], [ENGLISH_EXCERPT]]) {
      const text = await answerTo('من أسس المكتبة؟', excerpts);
      expect(text.startsWith('يذكر المستند: «'), text).toBe(true);
      expect(text).toMatch(/\[S1\]$/u);
      expect(LATIN.test(framing(text)), `Latin letters in the framing of: ${text}`).toBe(false);
    }
  });

  it('keeps the English frame for an English question', async () => {
    const text = await answerTo('Who founded the house?', [ENGLISH_EXCERPT]);
    expect(text).toMatch(/^The document states: ".*Alaric Thornquist.*" \[S1\]$/u);
  });

  it('follows the language of a question whose excerpts are in the other language', async () => {
    expect(await answerTo('Who founded the library?', [ARABIC_EXCERPT])).toMatch(/^The document states: "/u);
    expect(await answerTo('من أسس البيت؟', [ENGLISH_EXCERPT])).toMatch(/^يذكر المستند: «/u);
  });

  it('refuses with the sentinel when it is shown nothing: the application writes the refusal in the question’s language', async () => {
    expect(await answerTo('من أسس المكتبة؟', [])).toBe('NOT_IN_DOCUMENT');
  });
});

describe('a reveal of the scripted model is in the language it is asked to write in', () => {
  const memoryIn = (languageName: string | null, excerpts: ExcerptView[]) =>
    reply(
      new ScriptedLlm(E2E_RULES),
      buildRevealMessages({
        focus: 'manuscript',
        question: null,
        excerpts,
        document: { filename: 'x.pdf' },
        languageName,
      }),
    );

  it('writes an Arabic memory in Arabic: the frame, and no English around the quoted sentences', async () => {
    const text = await memoryIn('Arabic', [ENGLISH_EXCERPT]);
    expect(text.startsWith('أتذكّر: «'), text).toBe(true);
    // the key points are the document's sentences, cited
    const [head] = text.split('\n');
    expect(LATIN.test(framing(head ?? '')), head).toBe(false);
    expect(text).toContain('\n- ');
  });

  it('follows the excerpts when no language is named', async () => {
    expect(await memoryIn(null, [ARABIC_EXCERPT])).toMatch(/^أتذكّر: «/u);
    expect(await memoryIn(null, [ENGLISH_EXCERPT])).toMatch(/^Memory: "/u);
  });

  it('keeps the English frame for an English memory', async () => {
    expect(await memoryIn('English', [ENGLISH_EXCERPT])).toMatch(/^Memory: ".*" \[S1\]\n- /u);
  });
});

describe('replyLanguage', () => {
  it('reads the language a reveal names, else the question’s, else the first excerpt’s', () => {
    expect(replyLanguage({ lastUser: 'x\nWrite in Arabic.' })).toBe('ar');
    expect(replyLanguage({ lastUser: 'x\nWrite in French.' })).toBe('en');
    expect(replyLanguage({ lastUser: 'Question: ما هي لغات التدريس؟\nAnswer in Arabic:' })).toBe('ar');
    expect(replyLanguage({ lastUser: '<question>\nWho founded it?\n</question>' })).toBe('en');
  });
});
