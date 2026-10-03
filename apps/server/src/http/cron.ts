import { createHash, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Config } from '../config.js';
import type { Db } from '../db/client.js';
import type { Ingestion } from '../ingest/index.js';

export interface CronRouteDeps {
  db: Db;
  ingestion: Ingestion;
}

const digest = (value: string): Buffer => createHash('sha256').update(value).digest();

/** `Authorization: Bearer <CRON_SECRET>`, which is what Vercel Cron sends when the project has that variable. */
function authorised(request: FastifyRequest, secret: string | null): boolean {
  if (secret === null) return false;
  const header = request.headers.authorization ?? '';
  const given = header.startsWith('Bearer ') ? header.slice('Bearer '.length) : '';
  return timingSafeEqual(digest(given), digest(secret));
}

/**
 * `GET /api/cron/retention`, called once a day by Vercel Cron (the Hobby plan allows nothing more often): the retention pass
 * that a long-lived server does on a timer (expired documents and their blobs, blobs nobody claimed, orphans, old counters).
 * It is for retention ONLY: it does not touch the jobs. A job parked for a daily quota is let go by the next tick of its
 * client once the quota has started again (`acquire` finds the parking over); nothing on the server drives a job, so the
 * cron cannot "resume" anything. Outside production the pass refuses to delete unless ALLOW_PREVIEW_DATA is set (see
 * `mayDeleteData`). Without CRON_SECRET the route does not exist for anybody.
 */
export function registerCronRoutes(app: FastifyInstance, config: Config, deps: CronRouteDeps): void {
  app.get('/api/cron/retention', { config: { public: true, unlimited: true } }, async (request, reply) => {
    if (!authorised(request, config.cronSecret)) {
      return reply.status(401).send({ error: { code: 'INTERNAL', message: 'Not authorised.' } });
    }
    return deps.ingestion.sweep();
  });
}
