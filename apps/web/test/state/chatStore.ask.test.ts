import type { AnswerStreamEvent } from '@enchanted/shared';
import { describe, expect, it } from 'vitest';
import { createChatStore, isAsking } from '../../src/state/chatStore';

const MESSAGE_ID = '0c9b1e52-4a0b-4f0f-b9f6-2f1d5c3a9e77';
const done: AnswerStreamEvent = {
  type: 'done',
  messageId: MESSAGE_ID,
  answer: 'It was founded in 1847.',
  mode: 'answer',
  grounded: true,
  refusedBy: null,
  timingsMs: { retrieval: 1, firstToken: 2, total: 3 },
};

describe('chatStore: the conversation with the diary', () => {
  it('asking starts a turn, marks the diary as asking, and returns the turn id', () => {
    const store = createChatStore();
    const id = store.getState().ask('Who founded it?', 5000);
    expect(id).not.toBeNull();
    expect(store.getState().turn).toMatchObject({
      id,
      question: 'Who founded it?',
      status: 'asking',
      submittedAt: 5000,
    });
    expect(store.getState().askStatus).toBe('asking');
    expect(isAsking(store.getState().askStatus)).toBe(true);
  });

  it('refuses a second question while one is being answered (one answer at a time, like the server)', () => {
    const store = createChatStore();
    store.getState().ask('One?');
    expect(store.getState().ask('Two?')).toBeNull();
    expect(store.getState().turn?.question).toBe('One?');
  });

  it('follows the stream: stages, tokens, and the end', () => {
    const store = createChatStore();
    const id = store.getState().ask('Q') ?? '';
    store.getState().applyEvent(id, { type: 'status', stage: 'rewriting', elapsedMs: 1 });
    expect(store.getState().askStatus).toBe('rewriting');
    store.getState().applyEvent(id, { type: 'status', stage: 'retrieving', elapsedMs: 2 });
    expect(store.getState().askStatus).toBe('retrieving');
    store.getState().applyEvent(id, { type: 'status', stage: 'generating', elapsedMs: 3 });
    expect(store.getState().askStatus).toBe('generating');
    store.getState().applyEvent(id, { type: 'token', text: 'It was' });
    expect(store.getState().askStatus).toBe('streaming');
    expect(store.getState().turn?.text).toBe('It was');
    store.getState().applyEvent(id, done);
    expect(store.getState().askStatus).toBe('idle');
    expect(store.getState().turn).toMatchObject({ status: 'done', text: 'It was founded in 1847.' });
    expect(store.getState().error).toBeNull();
  });

  it('ignores events for a turn that is not the current one', () => {
    const store = createChatStore();
    store.getState().ask('Q');
    store.getState().applyEvent('some-other-turn', { type: 'token', text: 'stray' });
    expect(store.getState().turn?.text).toBe('');
  });

  it('an error event with no done after it leaves the diary failed, with the error kept', () => {
    const store = createChatStore();
    const id = store.getState().ask('Q') ?? '';
    store.getState().applyEvent(id, {
      type: 'error',
      error: { code: 'LLM_FAILED', message: 'upstream', detail: 'stopped' },
    });
    expect(store.getState().askStatus).toBe('failed');
    expect(store.getState().error).toMatchObject({ code: 'LLM_FAILED', detail: 'stopped' });
    expect(isAsking(store.getState().askStatus)).toBe(false);
  });

  it("failTurn records a failure that came from the connection, with the server's Retry-After", () => {
    const store = createChatStore();
    const id = store.getState().ask('Q') ?? '';
    store.getState().failTurn(id, { code: 'RATE_LIMITED', message: 'slow', retryAfterSeconds: 7 }, 9000);
    expect(store.getState().turn).toMatchObject({
      status: 'failed',
      error: { code: 'RATE_LIMITED', retryAfterSeconds: 7 },
    });
    expect(store.getState().askStatus).toBe('failed');
  });

  it('retrying starts the same turn over (attempt 2, nothing heard, same question)', () => {
    const store = createChatStore();
    const id = store.getState().ask('Q', 1000) ?? '';
    store.getState().applyEvent(id, { type: 'token', text: 'half' });
    store.getState().failTurn(id, { code: 'NETWORK', message: 'x' }, 2000);
    expect(store.getState().retryTurn(3000)).toBe(true);
    expect(store.getState().turn).toMatchObject({
      id,
      attempt: 2,
      status: 'asking',
      text: '',
      error: null,
      submittedAt: 3000,
    });
    expect(store.getState().askStatus).toBe('asking');
    expect(store.getState().error).toBeNull();
  });

  it('only a failed turn can be retried', () => {
    const store = createChatStore();
    store.getState().ask('Q');
    expect(store.getState().retryTurn()).toBe(false);
  });

  it('the next question moves the finished turn into the history (question and answer, in order)', () => {
    const store = createChatStore();
    const id = store.getState().ask('One?') ?? '';
    store.getState().applyEvent(id, done);
    store.getState().ask('Two?');
    expect(store.getState().messages.map((message) => message.content)).toEqual([
      'One?',
      'It was founded in 1847.',
    ]);
    expect(store.getState().turn?.question).toBe('Two?');
  });

  it('a failed turn that is replaced by a new question keeps just its question in the history', () => {
    const store = createChatStore();
    const id = store.getState().ask('One?') ?? '';
    store.getState().failTurn(id, { code: 'NETWORK', message: 'x' });
    store.getState().ask('Two?');
    expect(store.getState().messages.map((message) => message.content)).toEqual(['One?']);
  });

  it('clearing forgets the history and the turn', () => {
    const store = createChatStore();
    const id = store.getState().ask('One?') ?? '';
    store.getState().applyEvent(id, done);
    store.getState().clearConversation();
    expect(store.getState()).toMatchObject({ messages: [], turn: null, askStatus: 'idle', error: null });
  });

  it('asking for a clear raises a request the effect answers (each ask is a new request)', () => {
    const store = createChatStore();
    const before = store.getState().clearRequests;
    store.getState().requestClear();
    store.getState().requestClear();
    expect(store.getState().clearRequests).toBe(before + 2);
  });

  it('reset empties everything', () => {
    const store = createChatStore();
    store.getState().ask('Q');
    store.getState().reset();
    expect(store.getState()).toMatchObject({ messages: [], turn: null, askStatus: 'idle', error: null });
  });
});
