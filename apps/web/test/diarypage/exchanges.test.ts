import type { Citation, Message } from '@enchanted/shared';
import { describe, expect, it } from 'vitest';
import { exchangesOf, faceSetOf, LISTENING_ROWS, NOTICE_ROWS } from '../../src/diarypage/exchanges';
import { STRINGS } from '../../src/i18n/strings';
import { newTurn, reduceTurn, type Turn } from '../../src/state/chatTurn';

const citation = (over: Partial<Citation> = {}): Citation => ({
  marker: 'S1',
  chunkId: '5d0a3d1c-7f31-4c1e-8f7e-0d9d3a9d6b11',
  pageStart: 12,
  pageEnd: 12,
  sectionTitle: 'The Founding',
  snippet: 'x',
  language: 'en',
  direction: 'ltr',
  highlights: [{ page: 12, rects: [{ x: 0.1, y: 0.2, w: 0.5, h: 0.05 }] }],
  ...over,
});

const message = (
  id: string,
  role: 'user' | 'assistant',
  content: string,
  extra: Partial<Message> = {},
): Message => ({
  id: `00000000-0000-4000-8000-00000000000${id}`,
  role,
  kind: role === 'user' ? 'question' : 'answer',
  content,
  citations: [],
  createdAt: '2026-10-01T10:00:00.000Z',
  ...extra,
});

const doneEvent = (over = {}) =>
  ({
    type: 'done',
    messageId: '0c9b1e52-4a0b-4f0f-b9f6-2f1d5c3a9e77',
    answer: 'It was founded in 1847 [S1].',
    mode: 'answer',
    grounded: true,
    refusedBy: null,
    timingsMs: { retrieval: 1, firstToken: 2, total: 3 },
    ...over,
  }) as const;

function turnWith(question: string, events: Parameters<typeof reduceTurn>[1][]): Turn {
  return events.reduce((turn, event) => reduceTurn(turn, event, 2000), newTurn('turn-1', question, 1000));
}

describe('faceSetOf', () => {
  it('Arabic script (and Persian, Urdu) is written with the Arabic hands; everything else with the Latin ones', () => {
    expect(faceSetOf('من أسّس المدرسة؟')).toBe('arabic');
    expect(faceSetOf('Who founded it?')).toBe('latin');
    expect(faceSetOf('1847')).toBe('latin');
  });
});

describe('exchangesOf: the history', () => {
  it('pairs each question with its answer, the answer as pieces of ink with no marker in it, and its sources as notes', () => {
    const [first] = exchangesOf(
      {
        messages: [
          message('1', 'user', 'Who founded it?'),
          message('2', 'assistant', 'Alaric Thornquist [S1].', {
            mode: 'answer',
            grounded: true,
            citations: [citation()],
          }),
        ],
        turn: null,
      },
      'en',
    );
    expect(first?.question).toBe('Who founded it?');
    expect(first?.plain).toBe('Alaric Thornquist.');
    expect(first?.answer?.total).toBeGreaterThan(0);
    expect(first?.notes).toEqual([{ key: 'truth', label: 'Show me the truth', kind: 'cited' }]);
    expect(first?.chips).toHaveLength(1);
    expect(first?.current).toBe(false);
  });

  it("writes a refusal in the diary's own words, in the script of the question, whatever the server said", () => {
    const [arabic, latin] = exchangesOf(
      {
        messages: [
          message('1', 'user', 'ما هو اللون؟'),
          message('2', 'assistant', 'I could not find this.', { mode: 'not_found', grounded: false }),
          message('3', 'user', 'What colour?'),
          message('4', 'assistant', 'Not found.', { mode: 'not_found', grounded: false }),
        ],
        turn: null,
      },
      'en',
    );
    expect(arabic?.plain).toBe(STRINGS.ar.ask.notFound);
    expect(arabic?.answerFaces).toBe('arabic');
    expect(latin?.plain).toBe(STRINGS.en.ask.notFound);
  });

  it('names the pages in the language of the question: Eastern Arabic digits for an Arabic one in an English interface', () => {
    const [arabic] = exchangesOf(
      {
        messages: [
          message('1', 'user', 'من؟'),
          message('2', 'assistant', 'أسّسها [S1].', {
            mode: 'answer',
            grounded: true,
            citations: [citation({ pageStart: 3, pageEnd: 4 })],
          }),
        ],
        turn: null,
      },
      'en',
    );
    expect(arabic?.notes[0]?.label).toBe('أرني الحقيقة');
    expect(arabic?.noteFaces).toBe('arabic');
    expect(arabic?.language).toBe('ar');
  });

  it('a reply that was cut off says the ink ran out, in its own paragraph', () => {
    const [cut] = exchangesOf(
      {
        messages: [
          message('1', 'user', 'Q'),
          message('2', 'assistant', 'It was founded in 18', {
            mode: 'answer',
            grounded: true,
            truncated: true,
          }),
        ],
        turn: null,
      },
      'en',
    );
    expect(cut?.plain).toBe(`It was founded in 18\n\n${STRINGS.en.ask.truncated}`);
  });

  it('a question with no answer yet (it was left unanswered) is a question alone', () => {
    const [alone] = exchangesOf({ messages: [message('1', 'user', 'Anyone?')], turn: null }, 'en');
    expect(alone?.answer).toBeNull();
    expect(alone?.plain).toBe('');
  });
});

describe('exchangesOf: the exchange being written', () => {
  it('is the last one, marked current; while nothing has been said the diary is listening and keeps rows for it', () => {
    const turn = newTurn('turn-1', 'Who?', 1000);
    const [current] = exchangesOf({ messages: [], turn }, 'en');
    expect(current?.current).toBe(true);
    expect(current?.answer).toBeNull();
    expect(current?.listeningRows).toBe(LISTENING_ROWS);
  });

  it('shows the text as it streams, markers held back, and never the start of the refusal sentinel', () => {
    const streaming = turnWith('Q', [{ type: 'token', text: 'It was founded in 1847 [S' }]);
    const [a] = exchangesOf({ messages: [], turn: streaming }, 'en');
    expect(a?.plain).toBe('It was founded in 1847');
    const sentinel = turnWith('Q', [{ type: 'token', text: 'NOT_IN_' }]);
    const [b] = exchangesOf({ messages: [], turn: sentinel }, 'en');
    expect(b?.answer).toBeNull();
    expect(b?.listeningRows).toBe(LISTENING_ROWS);
  });

  it('the link "Show me the truth" is there once the answer is finished, and not before', () => {
    const before = turnWith('Q', [{ type: 'token', text: 'Text.' }]);
    expect(exchangesOf({ messages: [], turn: before }, 'en')[0]?.notes).toEqual([]);
    const after = turnWith('Q', [
      { type: 'token', text: 'Text.' },
      { type: 'citations', citations: [citation()], consulted: [] },
    ]);
    expect(exchangesOf({ messages: [], turn: after }, 'en')[0]?.notes).toEqual([]);
    const done = turnWith('Q', [
      { type: 'token', text: 'Text.' },
      { type: 'citations', citations: [citation()], consulted: [] },
      doneEvent({ answer: 'Text.' }),
    ]);
    expect(exchangesOf({ messages: [], turn: done }, 'en')[0]?.notes).toEqual([
      { key: 'truth', label: 'Show me the truth', kind: 'cited' },
    ]);
  });

  it('an ungrounded answer is uncertain and notes the pages it consulted as consulted', () => {
    const turn = turnWith('Q', [
      { type: 'token', text: 'Perhaps.' },
      { type: 'citations', citations: [], consulted: [{ page: 7 }] },
      doneEvent({ answer: 'Perhaps.', grounded: false }),
    ]);
    const [a] = exchangesOf({ messages: [], turn }, 'en');
    expect(a?.plain).toContain(STRINGS.en.ask.notCertain);
    expect(a?.chips.map((chip) => chip.key)).toEqual(['consulted-7']);
  });

  it('a question that could not be answered keeps rows for the notice', () => {
    const turn = reduceTurn(
      newTurn('turn-1', 'Q', 1000),
      { type: 'error', error: { code: 'LLM_FAILED', message: 'x' } },
      2000,
    );
    const [failed] = exchangesOf({ messages: [], turn }, 'en');
    expect(failed?.failed).toBe(true);
    expect(failed?.noticeRows).toBe(NOTICE_ROWS);
    expect(failed?.listeningRows).toBe(0);
  });

  it("a refusal and a list of pages are the diary's own lines, whatever text the stream carried", () => {
    const refusal = turnWith('ما هو؟', [
      { type: 'citations', citations: [], consulted: [] },
      doneEvent({ answer: 'English words.', mode: 'not_found', grounded: false }),
    ]);
    expect(exchangesOf({ messages: [], turn: refusal }, 'en')[0]?.plain).toBe(STRINGS.ar.ask.notFound);
    const passages = turnWith('Q', [
      { type: 'citations', citations: [citation()], consulted: [] },
      doneEvent({ answer: '', mode: 'passages' }),
    ]);
    expect(exchangesOf({ messages: [], turn: passages }, 'en')[0]?.plain).toBe(STRINGS.en.ask.passages);
  });

  it('the history comes first and the exchange being written last', () => {
    const all = exchangesOf(
      {
        messages: [
          message('1', 'user', 'One?'),
          message('2', 'assistant', 'One.', { mode: 'answer', grounded: true }),
        ],
        turn: newTurn('turn-2', 'Two?', 1000),
      },
      'en',
    );
    expect(all.map((exchange) => exchange.question)).toEqual(['One?', 'Two?']);
    expect(all.map((exchange) => exchange.current)).toEqual([false, true]);
  });
});
