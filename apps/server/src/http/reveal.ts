import { RevealRequestSchema } from '@enchanted/shared';
import type { FastifyInstance } from 'fastify';
import type { Config } from '../config.js';
import { ANSWER_HEARTBEAT_MS } from '../rag/constants.js';
import { runReveal } from '../rag/reveal.js';
import { AnswerSpend } from '../rag/spend.js';
import { openAnswerStream, watchClient } from './answer-stream.js';
import { questionLimit, sessionPlaceOf, takeSessionPlace, type AnswerRouteDeps } from './ask.js';
import { readyDocument } from './document-access.js';

/** `POST /api/documents/:id/reveal`: the outline of the manuscript, then a memory of what it says (SSE). */
export function registerRevealRoute(app: FastifyInstance, config: Config, deps: AnswerRouteDeps): void {
  app.post(
    '/api/documents/:id/reveal',
    { preHandler: [takeSessionPlace(app), questionLimit(app, config)] },
    async (request, reply) => {
      const client = watchClient(reply);
      const release = sessionPlaceOf(request);
      try {
        const document = await readyDocument(deps.db, config, request);
        const body = RevealRequestSchema.parse(request.body);
        // eslint-disable-next-line @typescript-eslint/return-await -- a reply is returned as is, never awaited
        if (client.signal.aborted) return reply;
        const spend = new AnswerSpend(deps.budgets, 'reveal', deps.rag.log);
        await spend.reserve();
        const stream = openAnswerStream(reply, config, deps.heartbeatMs ?? ANSWER_HEARTBEAT_MS, client);
        try {
          await runReveal(
            spend.wrap(deps.rag),
            {
              document: {
                id: document.id,
                filename: document.filename,
                pageCount: document.page_count,
                primaryLanguage: document.primary_language,
                sections: document.sections,
                languages: document.languages,
              },
              focus: body.focus,
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
