import type { Conversation } from '@enchanted/shared';
import { isAbortError } from '../../api/client';
import { deleteConversation, getConversation } from '../../api/conversation';
import { chatStore, type ChatStore } from '../chatStore';
import { toTurnError } from './ask';
import { experienceStore, type ExperienceStore, type Phase } from '../experience';

export interface ConversationEffectOptions {
  chat?: Pick<ChatStore, 'getState' | 'subscribe'>;
  experience?: Pick<ExperienceStore, 'getState' | 'subscribe'>;
  load?: (documentId: string, signal?: AbortSignal) => Promise<Conversation>;
  remove?: (documentId: string) => Promise<void>;
}

/** The phases in which the diary shows its conversation (and so needs the history). */
const SHOWS_HISTORY: readonly Phase[] = ['unveiling', 'manuscript', 'revealing', 'memory'];

/**
 * The conversation's network side effects. Restore: when the manuscript is unveiled (or the page starts in it), the history of
 * this document is read from the server and shown as dried ink, once per document. Clear: "Clear the conversation" asks the
 * server to delete it (the local copy goes at once; a failure is shown and the history is read again, so the screen tells the
 * truth). The conversation is forgotten when the diary closes and when the document changes.
 */
export function startConversationEffect(options: ConversationEffectOptions = {}): () => void {
  const chat = options.chat ?? chatStore;
  const experience = options.experience ?? experienceStore;
  const load = options.load ?? ((id, signal) => getConversation(id, signal));
  const remove = options.remove ?? ((id) => deleteConversation(id));

  let loadedFor: string | null = null;
  let controller: AbortController | null = null;

  const restore = (documentId: string): void => {
    controller?.abort();
    const mine = new AbortController();
    controller = mine;
    load(documentId, mine.signal).then(
      (conversation) => {
        if (mine.signal.aborted || experience.getState().documentId !== documentId) return;
        chat.getState().setMessages(conversation.messages);
      },
      (error: unknown) => {
        if (mine.signal.aborted || isAbortError(error)) return;
        // No history is not a reason to stop the diary: the reader can still write.
        if (import.meta.env.DEV) console.warn('[conversation] could not read the conversation', error);
      },
    );
  };

  const sync = (): void => {
    const { documentId, phase } = experience.getState();
    if (documentId !== null && SHOWS_HISTORY.includes(phase) && loadedFor !== documentId) {
      loadedFor = documentId;
      restore(documentId);
    }
  };

  const forget = (): void => {
    controller?.abort();
    controller = null;
    loadedFor = null;
    chat.getState().reset();
  };

  const stopExperience = experience.subscribe((state, previous) => {
    if (
      (state.documentId !== previous.documentId && previous.documentId !== null) ||
      (previous.phase === 'closing' && state.phase !== 'closing')
    ) {
      forget();
    }
    sync();
  });

  const stopChat = chat.subscribe((state, previous) => {
    if (state.clearRequests === previous.clearRequests) return;
    const documentId = experience.getState().documentId;
    // The turn in flight is withdrawn with the history (the ask effect aborts when the turn is gone).
    chat.getState().clearConversation();
    if (documentId === null) return;
    remove(documentId).catch((error: unknown) => {
      chat.getState().setError(toTurnError(error));
      restore(documentId);
    });
  });

  sync();
  return () => {
    stopExperience();
    stopChat();
    controller?.abort();
  };
}
