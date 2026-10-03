import type { AnswerStreamEvent, Message } from '@enchanted/shared';
import { createStore, useStore, type StoreApi } from 'zustand';
import type { UiError } from '../api/client';
import { newTurn, reduceTurn, turnToMessages, type Turn, type TurnError } from './chatTurn';

/**
 * Where an answer is in its life: `asking` (sent, nothing heard yet), the stage the server reports (`rewriting`,
 * `retrieving`, `generating`), `streaming` (tokens are arriving), `idle` (nothing in flight, or the answer is complete)
 * and `failed`.
 */
export type AskStatus =
  'idle' | 'asking' | 'rewriting' | 'retrieving' | 'generating' | 'streaming' | 'failed';

/** True while a question is in flight (the diary writes one answer at a time). */
export function isAsking(status: AskStatus): boolean {
  return status !== 'idle' && status !== 'failed';
}

/**
 * The conversation with the diary. `messages` is the history (finished exchanges, oldest first: restored from the server
 * or moved here when the next question starts); `turn` is the exchange being written, or the latest one until the next
 * question. Plain state and setters: the network belongs to state/effects/{ask,conversation}.ts, which feed events in.
 */
export interface ChatState {
  messages: Message[];
  turn: Turn | null;
  askStatus: AskStatus;
  error: UiError | null;
  /** Counts the reader's requests to clear the conversation; the conversation effect answers each one (DELETE). */
  clearRequests: number;

  setMessages(messages: Message[]): void;
  appendMessage(message: Message): void;
  setAskStatus(status: AskStatus): void;
  setError(error: UiError | null): void;
  /** Starts a turn for a question; null (nothing started) while another question is still being answered. */
  ask(question: string, now?: number): string | null;
  /** Writes the diary's own line under a question without asking the server (nothing is kept). Null while a question is being asked. */
  sayLocally(question: string, text: string, now?: number): string | null;
  /** Applies one event of the answer stream to the current turn (events for another turn are ignored). */
  applyEvent(turnId: string, event: AnswerStreamEvent, now?: number): void;
  /** Bytes arrived (a heartbeat, a frame): the turn is alive. */
  noteActivity(turnId: string, now?: number): void;
  /** The question could not be answered (a refusal, a broken connection): the turn fails with this error. */
  failTurn(turnId: string, error: TurnError, now?: number): void;
  /** Starts the failed turn over (same question). */
  retryTurn(now?: number): boolean;
  requestClear(): void;
  /** Forgets the history and the turn (after the server has cleared them). */
  clearConversation(): void;
  reset(): void;
}

const emptyChatState = {
  messages: [],
  turn: null,
  askStatus: 'idle',
  error: null,
} satisfies Partial<ChatState>;

let turnCounter = 0;

function statusFor(turn: Turn): AskStatus {
  switch (turn.status) {
    case 'done':
      return 'idle';
    case 'failed':
      return 'failed';
    case 'streaming':
      return 'streaming';
    case 'asking':
      return turn.stage ?? 'asking';
  }
}

export type ChatStore = StoreApi<ChatState>;

export function createChatStore(): ChatStore {
  return createStore<ChatState>()((set, get) => {
    const update = (turnId: string, change: (turn: Turn) => Turn): void => {
      const { turn } = get();
      if (turn?.id !== turnId) return;
      const next = change(turn);
      if (next === turn) return;
      set({
        turn: next,
        askStatus: statusFor(next),
        error: next.status === 'failed' ? next.error : null,
      });
    };
    return {
      ...emptyChatState,
      clearRequests: 0,
      setMessages: (messages) => {
        set({ messages });
      },
      appendMessage: (message) => {
        set((state) => ({ messages: [...state.messages, message] }));
      },
      setAskStatus: (askStatus) => {
        set({ askStatus });
      },
      setError: (error) => {
        set({ error });
      },
      ask: (question, now = Date.now()) => {
        const state = get();
        if (isAsking(state.askStatus)) return null;
        turnCounter += 1;
        const id = `turn-${String(turnCounter)}`;
        set({
          // The exchange that was fresh dries into the history.
          messages: state.turn ? [...state.messages, ...turnToMessages(state.turn)] : state.messages,
          turn: newTurn(id, question, now),
          askStatus: 'asking',
          error: null,
        });
        return id;
      },
      sayLocally: (question, text, now = Date.now()) => {
        const state = get();
        if (isAsking(state.askStatus)) return null;
        turnCounter += 1;
        const id = `turn-${String(turnCounter)}`;
        set({
          messages: state.turn ? [...state.messages, ...turnToMessages(state.turn)] : state.messages,
          turn: {
            ...newTurn(id, question, now),
            status: 'done',
            text,
            localText: text,
            done: {
              messageId: `${id}:local`,
              mode: 'not_found',
              grounded: false,
              refusedBy: null,
              truncated: false,
            },
            streamEndedAt: now,
          },
          askStatus: 'idle',
          error: null,
        });
        return id;
      },
      applyEvent: (turnId, event, now = Date.now()) => {
        update(turnId, (turn) => reduceTurn(turn, event, now));
      },
      noteActivity: (turnId, now = Date.now()) => {
        const { turn } = get();
        if (turn?.id === turnId && turn.lastByteAt !== now) set({ turn: { ...turn, lastByteAt: now } });
      },
      failTurn: (turnId, error, now = Date.now()) => {
        update(turnId, (turn) =>
          turn.status === 'done'
            ? turn
            : { ...turn, status: 'failed', error, streamEndedAt: now, lastByteAt: now },
        );
      },
      retryTurn: (now = Date.now()) => {
        const { turn } = get();
        if (turn?.status !== 'failed') return false;
        set({
          turn: newTurn(turn.id, turn.question, now, turn.attempt + 1),
          askStatus: 'asking',
          error: null,
        });
        return true;
      },
      requestClear: () => {
        set((state) => ({ clearRequests: state.clearRequests + 1 }));
      },
      clearConversation: () => {
        set({ ...emptyChatState });
      },
      reset: () => {
        set({ ...emptyChatState });
      },
    };
  });
}

export const chatStore = createChatStore();

export function useChatStore<T>(selector: (state: ChatState) => T): T {
  return useStore(chatStore, selector);
}
