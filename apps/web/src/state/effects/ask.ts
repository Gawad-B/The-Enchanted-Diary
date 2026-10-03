import { ApiError, isAbortError } from '../../api/client';
import { AskError, askStream, type AskStreamOptions } from '../../api/ask';
import { fallbackText } from '../../i18n/fallbackText';
import { chatStore, type ChatStore } from '../chatStore';
import type { Turn, TurnError } from '../chatTurn';
import { experienceStore, type ExperienceStore } from '../experience';
import { readerStore, type ReaderStore } from '../readerStore';
import { visiblePagesOf } from '../visiblePages';

export interface AskEffectOptions {
  chat?: Pick<ChatStore, 'getState' | 'subscribe'>;
  experience?: Pick<ExperienceStore, 'getState' | 'subscribe'>;
  reader?: Pick<ReaderStore, 'getState'>;
  stream?: (options: AskStreamOptions) => Promise<void>;
}

/** What a failed question is told to the reader as. */
export function toTurnError(error: unknown): TurnError {
  if (error instanceof AskError) {
    return {
      ...error.toUiError(),
      ...(error.retryAfterSeconds === undefined ? {} : { retryAfterSeconds: error.retryAfterSeconds }),
    };
  }
  if (error instanceof ApiError) return error.toUiError();
  return {
    code: 'INTERNAL',
    message: error instanceof Error ? error.message : 'The answer could not be written',
  };
}

/**
 * The ask side effect (global section I1): the only place a question reaches the network. When the conversation starts a
 * turn (a new question, or "try again") it asks the server, with the pages in view, and feeds every event of the answer
 * stream into the turn. The request ends, aborted, when: another turn starts, the turn fails or is cleared, the diary starts
 * to close, or the document is replaced. It does NOT end when the reveal starts: an answer in flight finishes behind it.
 * Returns the function that stops the effect.
 */
export function startAskEffect(options: AskEffectOptions = {}): () => void {
  const chat = options.chat ?? chatStore;
  const experience = options.experience ?? experienceStore;
  const reader = options.reader ?? readerStore;
  const stream = options.stream ?? askStream;

  let current: { turnId: string; controller: AbortController } | null = null;
  const abort = (): void => {
    current?.controller.abort();
    current = null;
  };

  const begin = (turn: Turn): void => {
    abort();
    const documentId = experience.getState().documentId;
    if (documentId === null) {
      chat.getState().failTurn(turn.id, {
        code: 'DOCUMENT_NOT_FOUND',
        message: fallbackText().noManuscript,
      });
      return;
    }
    const controller = new AbortController();
    current = { turnId: turn.id, controller };
    const alive = (): boolean => current?.controller === controller && !controller.signal.aborted;
    stream({
      documentId,
      question: turn.question,
      visiblePages: visiblePagesOf(reader.getState()),
      signal: controller.signal,
      onEvent: (event) => {
        if (alive()) chat.getState().applyEvent(turn.id, event);
      },
      onActivity: () => {
        if (alive()) chat.getState().noteActivity(turn.id);
      },
    }).then(
      () => {
        if (current?.controller === controller) current = null;
      },
      (error: unknown) => {
        if (!alive() || isAbortError(error)) return;
        current = null;
        const failure = toTurnError(error);
        chat.getState().failTurn(turn.id, failure);
        // The document is gone (expired, deleted elsewhere): the diary closes with the in-world line, as for any lost document.
        if (failure.code === 'DOCUMENT_NOT_FOUND') {
          experience.getState().dispatch({ type: 'DOCUMENT_LOST', error: failure });
        }
      },
    );
  };

  const stopChat = chat.subscribe((state, previous) => {
    const { turn } = state;
    if (!turn) {
      abort();
      return;
    }
    if (
      turn.status === 'asking' &&
      (turn.id !== previous.turn?.id || turn.attempt !== previous.turn.attempt)
    ) {
      begin(turn);
    }
    // A turn that fails is not aborted here: an `error` event may be followed by the `done` that carries the diary's refusal
    // (an output block). A request that went silent was already ended by its own watchdog, and "try again" replaces it.
  });

  const stopExperience = experience.subscribe((state, previous) => {
    if (state.documentId !== previous.documentId) abort();
    if (state.phase === 'closing' && previous.phase !== 'closing') abort();
  });

  return () => {
    stopChat();
    stopExperience();
    abort();
  };
}
