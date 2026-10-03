import type { AnswerStreamEvent, Citation } from '@enchanted/shared';
import { describe, expect, it } from 'vitest';
import { leadingSentinel } from '../../src/state/sentinel';
import { newTurn, pairMessages, reduceTurn, turnToMessages, type Turn } from '../../src/state/chatTurn';

const MESSAGE_ID = '0c9b1e52-4a0b-4f0f-b9f6-2f1d5c3a9e77';
const CHUNK_ID = '5d0a3d1c-7f31-4c1e-8f7e-0d9d3a9d6b11';

const citation = (over: Partial<Citation> = {}): Citation => ({
  marker: 'S1',
  chunkId: CHUNK_ID,
  pageStart: 12,
  pageEnd: 12,
  sectionTitle: 'The Founding',
  snippet: 'x',
  language: 'en',
  direction: 'ltr',
  highlights: [{ page: 12, rects: [{ x: 0.1, y: 0.2, w: 0.5, h: 0.05 }] }],
  ...over,
});

const done = (over: Partial<Extract<AnswerStreamEvent, { type: 'done' }>> = {}): AnswerStreamEvent => ({
  type: 'done',
  messageId: MESSAGE_ID,
  answer: 'Final text [S1].',
  mode: 'answer',
  grounded: true,
  refusedBy: null,
  timingsMs: { retrieval: 1, firstToken: 2, total: 3 },
  ...over,
});

const apply = (turn: Turn, ...events: AnswerStreamEvent[]): Turn =>
  events.reduce((current, event, index) => reduceTurn(current, event, 1000 + index * 10), turn);

const fresh = (): Turn => newTurn('t1', 'Who founded it?', 1000);

describe('a turn: one exchange with the diary', () => {
  it('starts as a question that has been sent and nothing heard yet', () => {
    expect(fresh()).toMatchObject({
      id: 't1',
      question: 'Who founded it?',
      submittedAt: 1000,
      attempt: 1,
      status: 'asking',
      stage: null,
      retrieval: null,
      text: '',
      firstTokenAt: null,
      citations: [],
      citationsReceived: false,
      done: null,
      error: null,
    });
  });

  it('follows the stages the server reports', () => {
    const turn = apply(fresh(), { type: 'status', stage: 'retrieving', elapsedMs: 5 });
    expect(turn.stage).toBe('retrieving');
    expect(turn.status).toBe('asking');
  });

  it('keeps the real retrieval figures (searched, retrieved, pages, evidence)', () => {
    const turn = apply(fresh(), {
      type: 'retrieval',
      query: 'Q',
      rewrittenQuery: null,
      searchedChunks: 312,
      retrievedChunks: 6,
      pages: [3, 7, 12],
      evidence: 'weak',
      timingsMs: { embed: 1, semantic: 2, lexical: 3, total: 6 },
    });
    expect(turn.retrieval).toEqual({
      searchedChunks: 312,
      retrievedChunks: 6,
      pages: [3, 7, 12],
      evidence: 'weak',
    });
  });

  it('appends tokens, notes when the first one arrived, and goes to streaming', () => {
    const turn = apply(fresh(), { type: 'token', text: 'The ' }, { type: 'token', text: 'house' });
    expect(turn.text).toBe('The house');
    expect(turn.firstTokenAt).toBe(1000);
    expect(turn.status).toBe('streaming');
  });

  it('an empty token is not the first token', () => {
    const turn = apply(fresh(), { type: 'token', text: '' });
    expect(turn.firstTokenAt).toBeNull();
  });

  it('keeps citations and consulted pages, and remembers that they arrived', () => {
    const turn = apply(fresh(), {
      type: 'citations',
      citations: [citation()],
      consulted: [{ page: 12 }, { page: 14 }],
    });
    expect(turn.citations).toHaveLength(1);
    expect(turn.consulted).toEqual([12, 14]);
    expect(turn.citationsReceived).toBe(true);
  });

  it('done makes its answer authoritative: it replaces what was streamed when they differ', () => {
    const turn = apply(fresh(), { type: 'token', text: 'Streamed text [S9].' }, done());
    expect(turn.text).toBe('Final text [S1].');
    expect(turn.status).toBe('done');
    expect(turn.done).toMatchObject({
      messageId: MESSAGE_ID,
      mode: 'answer',
      grounded: true,
      refusedBy: null,
      truncated: false,
    });
    expect(turn.streamEndedAt).not.toBeNull();
  });

  it('done keeps truncated and refusedBy', () => {
    const turn = apply(fresh(), done({ truncated: true }));
    expect(turn.done?.truncated).toBe(true);
    const refused = apply(
      fresh(),
      done({ mode: 'not_found', grounded: false, refusedBy: 'grounding', answer: 'Nothing.' }),
    );
    expect(refused.done).toMatchObject({ mode: 'not_found', refusedBy: 'grounding' });
  });

  it('an error event fails the turn but keeps whatever was written, with the server detail', () => {
    const turn = apply(
      fresh(),
      { type: 'token', text: 'Half an ans' },
      { type: 'error', error: { code: 'LLM_FAILED', message: 'upstream 502', detail: 'the model stopped' } },
    );
    expect(turn.status).toBe('failed');
    expect(turn.text).toBe('Half an ans');
    expect(turn.error).toEqual({ code: 'LLM_FAILED', message: 'upstream 502', detail: 'the model stopped' });
  });

  it('an output block sends the error and then a done: the answer is shown and the error stays as the technical line', () => {
    const turn = apply(
      fresh(),
      { type: 'error', error: { code: 'OUTPUT_BLOCKED', message: 'held back' } },
      done({ answer: 'I held back my answer.', grounded: false }),
    );
    expect(turn.status).toBe('done');
    expect(turn.text).toBe('I held back my answer.');
    expect(turn.error?.code).toBe('OUTPUT_BLOCKED');
  });

  it('records when bytes last arrived', () => {
    expect(reduceTurn(fresh(), { type: 'status', stage: 'generating', elapsedMs: 1 }, 5000).lastByteAt).toBe(
      5000,
    );
  });

  it('events after the end are ignored', () => {
    const finished = apply(fresh(), done());
    expect(reduceTurn(finished, { type: 'token', text: 'late' }, 9000)).toBe(finished);
  });
});

describe('the refusal sentinel never reaches the reader', () => {
  it('recognises the sentinel and its variants at the start of a reply, and a prefix that may become one', () => {
    expect(leadingSentinel('NOT_IN_DOCUMENT')).toBe('yes');
    expect(leadingSentinel('  not in document.')).toBe('yes');
    expect(leadingSentinel('[[NOT_FOUND]]')).toBe('yes');
    expect(leadingSentinel('**NOT_FOUND**')).toBe('yes');
    expect(leadingSentinel('NOT_IN')).toBe('maybe');
    expect(leadingSentinel('No')).toBe('maybe');
    expect(leadingSentinel('The house')).toBe('none');
    expect(leadingSentinel('')).toBe('none');
    // a sentinel later in a reply is text
    expect(leadingSentinel('The answer is NOT_FOUND here')).toBe('none');
  });

  it('a done whose answer is the sentinel becomes a not-found reply with no text of its own', () => {
    const turn = apply(fresh(), done({ answer: 'NOT_IN_DOCUMENT', mode: 'answer', grounded: false }));
    expect(turn.done).toMatchObject({ mode: 'not_found', refusedBy: 'model' });
    expect(turn.text).toBe('');
  });

  it('the streamed tokens of a sentinel are not shown as text', () => {
    const turn = apply(fresh(), { type: 'token', text: 'NOT_IN_' }, { type: 'token', text: 'DOCUMENT' });
    expect(turn.hidden).toBe(true);
  });
});

describe('turns and the conversation history', () => {
  it('a finished turn becomes a question and an answer message', () => {
    const turn = apply(
      fresh(),
      { type: 'citations', citations: [citation()], consulted: [{ page: 12 }] },
      done({ answer: 'It was founded in 1847 [S1].' }),
    );
    const [question, answer] = turnToMessages(turn);
    expect(question).toMatchObject({ role: 'user', kind: 'question', content: 'Who founded it?' });
    expect(answer).toMatchObject({
      id: MESSAGE_ID,
      role: 'assistant',
      kind: 'answer',
      content: 'It was founded in 1847 [S1].',
      mode: 'answer',
      grounded: true,
    });
    expect(answer?.citations).toHaveLength(1);
  });

  it('a failed turn leaves only its question', () => {
    const turn = apply(fresh(), { type: 'error', error: { code: 'LLM_FAILED', message: 'x' } });
    expect(turnToMessages(turn)).toHaveLength(1);
  });

  it('pairMessages joins each question with the answer after it, and skips reveal messages', () => {
    const q = (id: string, content: string) => ({
      id,
      role: 'user' as const,
      kind: 'question' as const,
      content,
      citations: [],
      createdAt: '2026-10-01T10:00:00.000Z',
    });
    const a = (id: string, content: string) => ({
      id,
      role: 'assistant' as const,
      kind: 'answer' as const,
      content,
      citations: [],
      createdAt: '2026-10-01T10:00:01.000Z',
    });
    const reveal = { ...a('r1', 'a memory'), kind: 'reveal' as const };
    const pairs = pairMessages([q('q1', 'One?'), a('a1', 'One.'), reveal, q('q2', 'Two?')]);
    expect(pairs.map((pair) => [pair.question.content, pair.answer?.content ?? null])).toEqual([
      ['One?', 'One.'],
      ['Two?', null],
    ]);
  });
});
