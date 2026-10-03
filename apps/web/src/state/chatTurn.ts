import type {
  AnswerStreamEvent,
  Citation,
  Evidence,
  Message,
  RefusedBy,
  AnswerMode,
} from '@enchanted/shared';
import type { UiError } from '../api/client';
import { leadingSentinel } from './sentinel';

/*
 * One exchange with the diary, as the stream of answer events builds it. Pure: the store keeps the current turn and the
 * effects feed it events; the leaf draws it. A turn stays "the current one" (fresh ink) until the next question starts,
 * when it joins the history (dried ink).
 */

/** A failure shown under the question: the code and words, plus how long the server asked the reader to wait. */
export type TurnError = UiError & { retryAfterSeconds?: number };

export type TurnStatus = 'asking' | 'streaming' | 'done' | 'failed';
export type TurnStage = 'rewriting' | 'retrieving' | 'generating';

export interface TurnRetrieval {
  searchedChunks: number;
  retrievedChunks: number;
  pages: number[];
  evidence: Evidence;
}

export interface TurnDone {
  messageId: string;
  mode: AnswerMode;
  grounded: boolean;
  refusedBy: RefusedBy | null;
  truncated: boolean;
}

export interface Turn {
  id: string;
  question: string;
  /** Epoch ms of the question (the sink and the reply's earliest start count from here). */
  submittedAt: number;
  /** Starts at 1; "try again" starts the same turn over and adds one. */
  attempt: number;
  status: TurnStatus;
  stage: TurnStage | null;
  retrieval: TurnRetrieval | null;
  /** Everything written so far, markers included; after `done`, the authoritative final text. */
  text: string;
  /** True while the text so far begins like the refusal sentinel (it is held back, never shown). */
  hidden: boolean;
  firstTokenAt: number | null;
  lastByteAt: number;
  streamEndedAt: number | null;
  citations: Citation[];
  consulted: number[];
  citationsReceived: boolean;
  done: TurnDone | null;
  error: TurnError | null;
  /** The diary's own line, written without asking the server ("I have nothing to show you yet"). It is not kept. */
  localText?: string;
}

export function newTurn(id: string, question: string, now: number, attempt = 1): Turn {
  return {
    id,
    question,
    submittedAt: now,
    attempt,
    status: 'asking',
    stage: null,
    retrieval: null,
    text: '',
    hidden: false,
    firstTokenAt: null,
    lastByteAt: now,
    streamEndedAt: null,
    citations: [],
    consulted: [],
    citationsReceived: false,
    done: null,
    error: null,
  };
}

/** Whether the turn has stopped (answered, or failed): no more events will change it. */
export function isSettled(turn: Turn): boolean {
  return turn.status === 'done' || turn.status === 'failed';
}

/** Applies one stream event. Events after the end are ignored (the same object comes back). */
export function reduceTurn(turn: Turn, event: AnswerStreamEvent, now: number): Turn {
  if (turn.status === 'done') return turn;
  const next: Turn = { ...turn, lastByteAt: now };
  switch (event.type) {
    case 'status':
      return { ...next, stage: event.stage };
    case 'retrieval':
      return {
        ...next,
        retrieval: {
          searchedChunks: event.searchedChunks,
          retrievedChunks: event.retrievedChunks,
          pages: event.pages,
          evidence: event.evidence,
        },
      };
    case 'outline':
      return next; // reveal only
    case 'token': {
      const text = turn.text + event.text;
      return {
        ...next,
        text,
        hidden: leadingSentinel(text) !== 'none',
        status: 'streaming',
        firstTokenAt: turn.firstTokenAt ?? (event.text === '' ? null : now),
      };
    }
    case 'citations':
      return {
        ...next,
        citations: event.citations,
        consulted: event.consulted.map((entry) => entry.page),
        citationsReceived: true,
      };
    case 'done': {
      const sentinel = leadingSentinel(event.answer) === 'yes';
      return {
        ...next,
        status: 'done',
        text: sentinel ? '' : event.answer,
        hidden: false,
        streamEndedAt: now,
        done: {
          messageId: event.messageId,
          mode: sentinel ? 'not_found' : event.mode,
          grounded: sentinel ? false : event.grounded,
          refusedBy: sentinel ? (event.refusedBy ?? 'model') : (event.refusedBy ?? null),
          truncated: event.truncated === true,
        },
      };
    }
    case 'error':
      return {
        ...next,
        status: 'failed',
        streamEndedAt: now,
        error: {
          code: event.error.code,
          message: event.error.message,
          ...(event.error.detail === undefined ? {} : { detail: event.error.detail }),
        },
      };
  }
}

/** The two messages a turn adds to the history: its question, and its answer when it got one. */
export function turnToMessages(turn: Turn): Message[] {
  if (turn.localText !== undefined) return [];
  const createdAt = new Date(turn.submittedAt).toISOString();
  const question: Message = {
    id: `${turn.id}:question`,
    role: 'user',
    kind: 'question',
    content: turn.question,
    citations: [],
    createdAt,
  };
  if (turn.status !== 'done' || turn.done === null) return [question];
  const answer: Message = {
    id: turn.done.messageId,
    role: 'assistant',
    kind: 'answer',
    content: turn.text,
    mode: turn.done.mode,
    grounded: turn.done.grounded,
    refusedBy: turn.done.refusedBy,
    truncated: turn.done.truncated,
    citations: turn.citations,
    createdAt,
  };
  return [question, answer];
}

export interface Exchange {
  question: Message;
  answer: Message | null;
}

/** Joins each question with the answer that follows it; reveal messages (the memory's) are not part of the leaf. */
export function pairMessages(messages: readonly Message[]): Exchange[] {
  const exchanges: Exchange[] = [];
  for (const message of messages) {
    if (message.kind === 'reveal') continue;
    if (message.role === 'user') exchanges.push({ question: message, answer: null });
    else {
      const last = exchanges.at(-1);
      if (last?.answer === null) last.answer = message;
    }
  }
  return exchanges;
}
