import { AskRequestSchema } from '@enchanted/shared';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Config } from '../config.js';
import type { Db } from '../db/client.js';
import { ANSWER_HEARTBEAT_MS } from '../rag/constants.js';
import type { GeminiBudgets } from '../limits/gemini-budget.js';
import { runAsk, type RagDeps } from '../rag/answer.js';
import { AnswerSpend } from '../rag/spend.js';
import { openAnswerStream, watchClient } from './answer-stream.js';
import { readyDocument } from './document-access.js';
import { AppError } from './errors.js';
import { perSessionRateLimit } from './rate-limits.js';

export interface AnswerRouteDeps {
  db: Db;
  rag: RagDeps;
  /** For tests: a shorter heartbeat than the 5 seconds the contract promises. */
  heartbeatMs?: number;
  /** The daily Gemini budgets: reserved once a question is accepted, given back when no model was asked (rag/spend.ts). */
  budgets?: GeminiBudgets;
}

/** The refusal for a second question while one is already being answered for the same session (429 DIARY_BUSY). */
export function diaryBusy(): AppError {
  return new AppError(
    'DIARY_BUSY',
    'The diary is already answering another question. Wait a moment and ask again.',
  );
}

/** The sessions that have an answer (or a reveal) in flight, per app: one at a time each (what DIARY_BUSY means). */
const inFlight = new WeakMap<FastifyInstance, Set<string>>();

/**
 * Marks the session as answering and returns the function that ends it (idempotent: the place goes back once, and never one that
 * another request has taken since); a second question or reveal of the same session while one is being written is refused with
 * DIARY_BUSY, before any stream opens (a plain 429 the client can retry). The limit is per process: an app-wide budget of model
 * requests is the database's business (the answer budgets), not this gate's.
 */
export function beginAnswer(app: FastifyInstance, sessionId: string): () => void {
  let sessions = inFlight.get(app);
  if (sessions === undefined) {
    sessions = new Set();
    inFlight.set(app, sessions);
  }
  if (sessions.has(sessionId)) throw diaryBusy();
  sessions.add(sessionId);
  const owned = sessions;
  let held = true;
  return () => {
    if (!held) return;
    held = false;
    owned.delete(sessionId);
  };
}

/** The places taken by the pre-handler, by request: the handler ends them when its answer is over. */
const places = new WeakMap<FastifyRequest, { release: () => void; stopWatching: () => void }>();

/**
 * The pre-handler of ask and reveal: takes the session's place BEFORE the question is counted against QUESTIONS_PER_MINUTE, so
 * that a refusal for DIARY_BUSY costs no minute allowance, and a double submit (two requests that both pass a mere check before
 * either takes the place) counts one question, not two. The place goes back when the handler ends; for the paths where the
 * handler never runs (a request refused by the minute's limit, or by a later pre-handler) it goes back when the response closes,
 * and ONLY then: once the handler has the place (`sessionPlaceOf`) a visitor who goes away does not free it, because the pipeline
 * is still unwinding (its model call, its settling of the budgets) and a second answer of the session must not start beside it.
 */
export function takeSessionPlace(app: FastifyInstance) {
  return (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const release = beginAnswer(app, request.sessionId);
    reply.raw.once('close', release);
    places.set(request, { release, stopWatching: () => reply.raw.off('close', release) });
    return Promise.resolve();
  };
}

/**
 * The place the pre-handler took for this request, now the handler's own: it gives it back, once, when its answer is over (the
 * close of the response no longer does).
 */
export function sessionPlaceOf(request: FastifyRequest): () => void {
  const place = places.get(request);
  if (place === undefined)
    throw new Error('the session place was not taken: takeSessionPlace must be a pre-handler of the route');
  place.stopWatching();
  return place.release;
}

/** The limit shared by ask and reveal: QUESTIONS_PER_MINUTE per session. */
export const questionLimit = (app: FastifyInstance, config: Config) =>
  perSessionRateLimit(app, { name: 'questions', max: config.questionsPerMinute, timeWindow: '1 minute' });

/** `POST /api/documents/:id/ask`: a question about the document, answered as a stream of AnswerStreamEvents. */
export function registerAskRoute(app: FastifyInstance, config: Config, deps: AnswerRouteDeps): void {
  app.post(
    '/api/documents/:id/ask',
    { preHandler: [takeSessionPlace(app), questionLimit(app, config)] },
    async (request, reply) => {
      const client = watchClient(reply);
      // (the session's place was taken by the pre-handler, before the question was counted; it goes back whatever happens next)
      const release = sessionPlaceOf(request);
      try {
        const document = await readyDocument(deps.db, config, request);
        const body = AskRequestSchema.parse(request.body);
        // the visitor left while the document was being looked up: spend nothing (a reply is returned as is, never awaited)
        // eslint-disable-next-line @typescript-eslint/return-await
        if (client.signal.aborted) return reply;
        // the budgets are taken now that the question is accepted (a 429 here comes before any stream opens)
        const spend = new AnswerSpend(deps.budgets, 'ask', deps.rag.log);
        await spend.reserve();
        const stream = openAnswerStream(reply, config, deps.heartbeatMs ?? ANSWER_HEARTBEAT_MS, client);
        try {
          await runAsk(
            spend.wrap(deps.rag),
            {
              document: {
                id: document.id,
                filename: document.filename,
                pageCount: document.page_count,
                primaryLanguage: document.primary_language,
              },
              question: body.question,
              ...(body.context === undefined ? {} : { visiblePages: body.context.visiblePages }),
              signal: stream.signal,
            },
            stream.emit,
          );
        } finally {
          stream.end();
          await spend.settle(deps.rag.log);
        }
      } finally {
        release();
      }
      return reply;
    },
  );
}
