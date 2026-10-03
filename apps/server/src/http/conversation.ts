import type { Conversation } from '@enchanted/shared';
import type { FastifyInstance } from 'fastify';
import type { Config } from '../config.js';
import type { Db } from '../db/client.js';
import { conversationsRepo, toMessage } from '../db/repositories/conversations.js';
import { ownedDocument } from './document-access.js';

/** `GET` and `DELETE /api/documents/:id/conversation`: the questions and answers of the document, and clearing them. */
export function registerConversationRoutes(app: FastifyInstance, config: Config, db: Db): void {
  app.get('/api/documents/:id/conversation', async (request, reply): Promise<Conversation> => {
    const document = await ownedDocument(db, config, request);
    void reply.header('Cache-Control', 'no-store');
    const conversationId = await conversationsRepo.find(db, document.id);
    const rows = conversationId === null ? [] : await conversationsRepo.list(db, conversationId);
    return { documentId: document.id, messages: rows.map(toMessage) };
  });

  app.delete('/api/documents/:id/conversation', async (request, reply) => {
    const document = await ownedDocument(db, config, request);
    await conversationsRepo.clear(db, document.id);
    return reply.status(204).send();
  });
}
