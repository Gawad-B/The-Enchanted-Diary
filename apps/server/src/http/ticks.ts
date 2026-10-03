import type { IngestTickResponse } from '@enchanted/shared';
import type { FastifyInstance } from 'fastify';
import type { Config } from '../config.js';
import type { Db } from '../db/client.js';
import type { Ingestion } from '../ingest/index.js';
import { ownedDocument } from './document-access.js';
import { perSessionRateLimit } from './rate-limits.js';

export interface TickRouteDeps {
  db: Db;
  ingestion: Ingestion;
}

/**
 * The two routes a client reads the ingestion of its document with. `POST .../tick` does the work, a bit at a time: the client
 * calls it again and again until the status is `ready` or `failed` (see IngestTickResponseSchema); two ticks at once are
 * harmless, one works and the other returns the current progress. `GET .../progress` only reads (a second tab, a poll).
 */
export function registerTickRoutes(app: FastifyInstance, config: Config, deps: TickRouteDeps): void {
  const { db, ingestion } = deps;

  app.post(
    '/api/documents/:id/tick',
    {
      preHandler: [
        perSessionRateLimit(app, { name: 'ticks', max: config.ticksPerMinute, timeWindow: '1 minute' }),
      ],
    },
    async (request, reply): Promise<IngestTickResponse> => {
      const row = await ownedDocument(db, config, request);
      void reply.header('Cache-Control', 'no-store');
      return ingestion.runner.tick(row.id);
    },
  );

  app.get('/api/documents/:id/progress', async (request, reply): Promise<IngestTickResponse> => {
    const row = await ownedDocument(db, config, request);
    void reply.header('Cache-Control', 'no-store');
    return ingestion.runner.progress(row);
  });
}
