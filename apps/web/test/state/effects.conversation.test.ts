import type { Conversation } from '@enchanted/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../src/api/client';
import { createChatStore } from '../../src/state/chatStore';
import { startConversationEffect } from '../../src/state/effects/conversation';
import { createExperienceStore, initialExperienceState, type Phase } from '../../src/state/experience';
import { DOCUMENT_ID } from '../fixtures';

const message = (id: string, role: 'user' | 'assistant', content: string) => ({
  id,
  role,
  kind: role === 'user' ? ('question' as const) : ('answer' as const),
  content,
  citations: [],
  createdAt: '2026-10-01T10:00:00.000Z',
});
const conversation: Conversation = {
  documentId: DOCUMENT_ID,
  messages: [message('a1', 'user', 'Who?'), message('a2', 'assistant', 'Alaric.')],
};

function setup(phase: Phase = 'discovery', documentId: string | null = DOCUMENT_ID) {
  const chat = createChatStore();
  const experience = createExperienceStore({
    ...initialExperienceState,
    phase,
    sessionChecked: true,
    documentId,
  });
  const load = vi.fn((_id: string, _signal?: AbortSignal) => Promise.resolve(conversation));
  const remove = vi.fn((_id: string) => Promise.resolve());
  stops.push(startConversationEffect({ chat, experience, load, remove }));
  return { chat, experience, load, remove };
}

const stops: (() => void)[] = [];
afterEach(() => {
  for (const stop of stops.splice(0)) stop();
});

describe('the conversation effect: restore and clear', () => {
  it('when the manuscript is unveiled, the history comes back from the server as dried ink', async () => {
    const { chat, experience, load } = setup('reading');
    experience.setState({ phase: 'unveiling', epoch: 5 });
    expect(load).toHaveBeenCalledWith(DOCUMENT_ID, expect.any(AbortSignal));
    await vi.waitFor(() => {
      expect(chat.getState().messages).toHaveLength(2);
    });
    expect(chat.getState().messages[1]?.content).toBe('Alaric.');
  });

  it('a diary that is already in the manuscript phase at start-up loads once', async () => {
    const { chat, load } = setup('manuscript');
    await vi.waitFor(() => {
      expect(chat.getState().messages).toHaveLength(2);
    });
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('does not load twice for the same document as the phases go on', async () => {
    const { chat, experience, load } = setup('unveiling');
    await vi.waitFor(() => {
      expect(chat.getState().messages).toHaveLength(2);
    });
    experience.setState({ phase: 'manuscript', epoch: 9 });
    experience.setState({ phase: 'revealing', epoch: 10 });
    experience.setState({ phase: 'memory', epoch: 11 });
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('a failed restore leaves the diary empty and does not stop it (the reader can still write)', async () => {
    const chat = createChatStore();
    const experience = createExperienceStore({
      ...initialExperienceState,
      phase: 'manuscript',
      sessionChecked: true,
      documentId: DOCUMENT_ID,
    });
    const load = vi.fn(() => Promise.reject(new ApiError('NETWORK', 'offline')));
    stops.push(startConversationEffect({ chat, experience, load, remove: vi.fn(() => Promise.resolve()) }));
    await vi.waitFor(() => {
      expect(load).toHaveBeenCalled();
    });
    expect(chat.getState().messages).toEqual([]);
  });

  it('forgets the conversation when the diary closes', async () => {
    const { chat, experience } = setup('manuscript');
    await vi.waitFor(() => {
      expect(chat.getState().messages).toHaveLength(2);
    });
    experience.getState().dispatch({ type: 'CLOSE_REQUESTED' });
    experience.getState().dispatch({ type: 'CLOSE_DONE', epoch: experience.getState().epoch });
    expect(chat.getState().messages).toEqual([]);
    expect(chat.getState().turn).toBeNull();
  });

  it('a new document starts with a clean conversation (and loads its own)', async () => {
    const { chat, experience, load } = setup('manuscript');
    await vi.waitFor(() => {
      expect(chat.getState().messages).toHaveLength(2);
    });
    experience.setState({ documentId: 'second-document' });
    expect(chat.getState().messages).toEqual([]);
    expect(load).toHaveBeenLastCalledWith('second-document', expect.any(AbortSignal));
  });

  it('"Clear the conversation" asks the server to delete it and then forgets it here', async () => {
    const { chat, remove } = setup('manuscript');
    await vi.waitFor(() => {
      expect(chat.getState().messages).toHaveLength(2);
    });
    chat.getState().requestClear();
    expect(remove).toHaveBeenCalledWith(DOCUMENT_ID);
    await vi.waitFor(() => {
      expect(chat.getState().messages).toEqual([]);
    });
  });

  it('a clear that fails is shown (the technical error) and the history is read again from the server', async () => {
    const chat = createChatStore();
    const experience = createExperienceStore({
      ...initialExperienceState,
      phase: 'manuscript',
      sessionChecked: true,
      documentId: DOCUMENT_ID,
    });
    const load = vi.fn((_id: string) => Promise.resolve(conversation));
    const remove = vi.fn((_id: string) => Promise.reject(new ApiError('INTERNAL', 'boom', 500)));
    stops.push(startConversationEffect({ chat, experience, load, remove }));
    await vi.waitFor(() => {
      expect(chat.getState().messages).toHaveLength(2);
    });
    chat.getState().requestClear();
    await vi.waitFor(() => {
      expect(chat.getState().error?.code).toBe('INTERNAL');
    });
    await vi.waitFor(() => {
      expect(load).toHaveBeenCalledTimes(2);
    });
    expect(chat.getState().messages).toHaveLength(2);
  });
});
