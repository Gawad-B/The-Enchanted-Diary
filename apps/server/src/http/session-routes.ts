import { randomUUID } from 'node:crypto';
import type { SessionDocumentResponse } from '@enchanted/shared';
import type { FastifyInstance } from 'fastify';
import type { Config } from '../config.js';
import type { Db } from '../db/client.js';
import { documentsRepo } from '../db/repositories/documents.js';
import { sessionsRepo } from '../db/repositories/sessions.js';
import { loadDocumentDetail } from '../ingest/detail.js';
import type { Ingestion } from '../ingest/index.js';
import { issueSessionCookie } from '../session/session.js';

export interface SessionRouteDeps {
  db: Db;
  ingestion: Ingestion;
}

/** `GET /api/session/document` and `POST /api/session/reset`. */
export function registerSessionRoutes(app: FastifyInstance, config: Config, deps: SessionRouteDeps): void {
  const { db, ingestion } = deps;

  // The session's newest ready or processing document (never a failed one), or null: what the page asks at boot.
  app.get('/api/session/document', async (request, reply): Promise<SessionDocumentResponse> => {
    void reply.header('Cache-Control', 'no-store');
    const row = await documentsRepo.latestForSession(db, request.sessionId);
    if (row === null) return { document: null };
    const expiresAt = await documentsRepo.touch(db, row.id, {
      hours: config.documentRetentionHours,
      maxHours: config.documentMaxRetentionHours,
    });
    return {
      document: await loadDocumentDetail(db, expiresAt === null ? row : { ...row, expires_at: expiresAt }),
    };
  });

  // "Start a new session": every document of this session is removed (jobs stopped, files deleted) and the
  // browser gets a new, empty session.
  app.post('/api/session/reset', async (request, reply) => {
    const previous = request.sessionId;
    await ingestion.service.removeSessionDocuments(previous);
    const fresh = randomUUID();
    await db.query('INSERT INTO sessions (id) VALUES ($1)', [fresh]);
    await sessionsRepo.remove(db, previous);
    issueSessionCookie(reply, config, fresh);
    return reply.status(204).send();
  });
}
