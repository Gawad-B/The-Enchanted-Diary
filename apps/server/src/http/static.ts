import { existsSync } from 'node:fs';
import path from 'node:path';
import fastifyStatic from '@fastify/static';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Config } from '../config.js';
import { REPO_ROOT } from '../config.js';
import { sendNotFound, type NotFoundHandler } from './errors.js';

/** Where `npm run build -w @enchanted/web` writes the SPA. */
export const DEFAULT_WEB_DIST = path.join(REPO_ROOT, 'apps', 'web', 'dist');

/** True for browser navigations that should receive the SPA shell instead of a 404. */
function wantsSpaShell(request: FastifyRequest): boolean {
  if (request.method !== 'GET' && request.method !== 'HEAD') return false;
  if (request.url === '/api' || request.url.startsWith('/api/')) return false;
  const lastSegment = request.url.split('?')[0]?.split('/').pop() ?? '';
  return !lastSegment.includes('.') && (request.headers.accept ?? '').includes('text/html');
}

/**
 * Serves the built SPA with an index.html fallback for client-side routes. Returns the not-found handler
 * to install (it needs to be set once, together with the error handler).
 */
export async function registerWebStatic(
  app: FastifyInstance,
  config: Config,
  webDist: string,
): Promise<NotFoundHandler> {
  if (!existsSync(path.join(webDist, 'index.html'))) {
    app.log.warn(
      { webDist },
      'the web build was not found; run "npm run build" to serve the app from this server',
    );
    return (request, reply) => sendNotFound(request, reply, config);
  }
  await app.register(fastifyStatic, {
    root: webDist,
    wildcard: false,
    // Hashed assets never change; the shell must be revalidated so a new deploy is picked up.
    cacheControl: false,
    setHeaders(reply, filePath) {
      const hashed = filePath.includes(`${path.sep}assets${path.sep}`);
      void reply.header('Cache-Control', hashed ? 'public, max-age=31536000, immutable' : 'no-cache');
    },
  });
  return (request, reply) =>
    wantsSpaShell(request)
      ? reply.type('text/html').sendFile('index.html')
      : sendNotFound(request, reply, config);
}
