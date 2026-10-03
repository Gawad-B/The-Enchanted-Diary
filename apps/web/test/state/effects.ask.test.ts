import type { AnswerStreamEvent } from '@enchanted/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../src/api/client';
import { AskError, type AskStreamOptions } from '../../src/api/ask';
import { createChatStore } from '../../src/state/chatStore';
import { startAskEffect } from '../../src/state/effects/ask';
import { createExperienceStore, initialExperienceState, type Phase } from '../../src/state/experience';
import { createReaderStore } from '../../src/state/readerStore';
import { DOCUMENT_ID } from '../fixtures';

const MESSAGE_ID = '0c9b1e52-4a0b-4f0f-b9f6-2f1d5c3a9e77';
const done: AnswerStreamEvent = {
  type: 'done',
  messageId: MESSAGE_ID,
  answer: 'Answer.',
  mode: 'answer',
  grounded: true,
  refusedBy: null,
  timingsMs: { retrieval: 1, firstToken: 2, total: 3 },
};

interface Call extends AskStreamOptions {
  resolve(): void;
  reject(error: unknown): void;
}

function setup(phase: Phase = 'manuscript') {
  const chat = createChatStore();
  const experience = createExperienceStore({
    ...initialExperienceState,
    phase,
    sessionChecked: true,
    documentId: DOCUMENT_ID,
  });
  const reader = createReaderStore({ hasDocument: true, pageCount: 10, spread: 2 });
  const calls: Call[] = [];
  const stream = vi.fn((options: AskStreamOptions) => {
    return new Promise<void>((resolve, reject) => {
      const call: Call = { ...options, resolve, reject };
      calls.push(call);
      options.signal?.addEventListener('abort', () => {
        reject(new DOMException('withdrawn', 'AbortError'));
      });
    });
  });
  const stop = startAskEffect({ chat, experience, reader, stream });
  stops.push(stop);
  return { chat, experience, reader, calls, stream };
}

const stops: (() => void)[] = [];
afterEach(() => {
  for (const stop of stops.splice(0)) stop();
});

describe('the ask effect: the network side of a question', () => {
  it('a new turn asks the server at once, with the document and the pages in view', () => {
    const { chat, calls } = setup();
    chat.getState().ask('Who founded it?');
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      documentId: DOCUMENT_ID,
      question: 'Who founded it?',
      visiblePages: [3, 4],
    });
  });

  it('feeds every event to the turn, and heartbeats mark it alive', () => {
    const { chat, calls } = setup();
    const id = chat.getState().ask('Q') ?? '';
    const call = calls[0];
    call?.onEvent({ type: 'status', stage: 'retrieving', elapsedMs: 3 });
    call?.onEvent({ type: 'token', text: 'Ans' });
    call?.onEvent(done);
    call?.resolve();
    expect(chat.getState().turn).toMatchObject({ id, status: 'done', text: 'Answer.' });
    expect(chat.getState().askStatus).toBe('idle');
  });

  it('a refusal before the stream (DIARY_BUSY) fails the turn with the code, so the reader can be told and retry', async () => {
    const { chat, calls } = setup();
    chat.getState().ask('Q');
    calls[0]?.reject(new AskError(new ApiError('DIARY_BUSY', 'busy', 429), undefined));
    await vi.waitFor(() => {
      expect(chat.getState().turn?.status).toBe('failed');
    });
    expect(chat.getState().turn?.error).toMatchObject({ code: 'DIARY_BUSY', message: 'busy' });
  });

  it('keeps Retry-After and the detail of a rate limit', async () => {
    const { chat, calls } = setup();
    chat.getState().ask('Q');
    calls[0]?.reject(new AskError(new ApiError('RATE_LIMITED', 'slow', 429, 'daily quota reached'), 42));
    await vi.waitFor(() => {
      expect(chat.getState().turn?.error).toMatchObject({
        code: 'RATE_LIMITED',
        detail: 'daily quota reached',
        retryAfterSeconds: 42,
      });
    });
  });

  it('a broken connection fails the turn as NETWORK', async () => {
    const { chat, calls } = setup();
    chat.getState().ask('Q');
    calls[0]?.reject(new ApiError('NETWORK', 'Nothing came from the archive for 20 seconds'));
    await vi.waitFor(() => {
      expect(chat.getState().turn?.error?.code).toBe('NETWORK');
    });
  });

  it('a document that is gone (404) fails the turn and tells the experience the document was lost', async () => {
    const { chat, calls, experience } = setup();
    chat.getState().ask('Q');
    calls[0]?.reject(new ApiError('DOCUMENT_NOT_FOUND', 'gone', 404));
    await vi.waitFor(() => {
      expect(experience.getState().phase).toBe('closing');
    });
    expect(experience.getState().error?.code).toBe('DOCUMENT_NOT_FOUND');
  });

  it('retrying asks again with a fresh request', () => {
    const { chat, calls } = setup();
    const id = chat.getState().ask('Q') ?? '';
    chat.getState().failTurn(id, { code: 'NETWORK', message: 'x' });
    expect(calls[0]?.signal?.aborted).toBe(false); // an error event may still be followed by a done
    chat.getState().retryTurn();
    expect(calls[0]?.signal?.aborted).toBe(true); // the failed attempt's request is let go when the new one starts
    expect(calls).toHaveLength(2);
    expect(calls[1]?.question).toBe('Q');
    expect(calls[1]?.signal?.aborted).toBe(false);
  });

  it('events of an attempt that was replaced are not applied to the new one', () => {
    const { chat, calls } = setup();
    const id = chat.getState().ask('Q') ?? '';
    chat.getState().failTurn(id, { code: 'NETWORK', message: 'x' });
    chat.getState().retryTurn();
    calls[0]?.onEvent({ type: 'token', text: 'stale' });
    expect(chat.getState().turn?.text).toBe('');
    calls[1]?.onEvent({ type: 'token', text: 'fresh' });
    expect(chat.getState().turn?.text).toBe('fresh');
  });

  it('aborts the request when the book starts to close', () => {
    const { chat, calls, experience } = setup();
    chat.getState().ask('Q');
    experience.getState().dispatch({ type: 'CLOSE_REQUESTED' });
    expect(calls[0]?.signal?.aborted).toBe(true);
  });

  it('aborts the request when the document is replaced', () => {
    const { chat, calls, experience } = setup();
    chat.getState().ask('Q');
    experience.setState({ documentId: 'another-document' });
    expect(calls[0]?.signal?.aborted).toBe(true);
  });

  it('aborts the request when the conversation is cleared', () => {
    const { chat, calls } = setup();
    chat.getState().ask('Q');
    chat.getState().clearConversation();
    expect(calls[0]?.signal?.aborted).toBe(true);
  });

  it('does NOT abort when the reveal starts (an answer in flight finishes behind it)', () => {
    const { chat, calls, experience } = setup();
    chat.getState().ask('Q');
    experience.getState().dispatch({ type: 'REVEAL_TRIGGERED' });
    expect(experience.getState().phase).toBe('revealing');
    expect(calls[0]?.signal?.aborted).toBe(false);
  });

  it('a turn without a document fails at once instead of calling the server', () => {
    const chat = createChatStore();
    const experience = createExperienceStore({
      ...initialExperienceState,
      phase: 'manuscript',
      sessionChecked: true,
    });
    const stream = vi.fn(() => Promise.resolve());
    stops.push(startAskEffect({ chat, experience, reader: createReaderStore(), stream }));
    chat.getState().ask('Q');
    expect(stream).not.toHaveBeenCalled();
    expect(chat.getState().turn?.error?.code).toBe('DOCUMENT_NOT_FOUND');
  });
});
