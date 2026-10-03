import type { IncomingMessage, ServerResponse } from 'node:http';
import type { FastifyInstance } from 'fastify';
import { buildApp, type AppDeps } from './app.js';
import { loadConfig } from './config.js';

/*
 * The Vercel function: the whole Fastify app behind one function (`api/index.ts` re-exports `handler`; `vercel.json` rewrites `/api/(.*)` to it). The app is built
 * once per instance, on the first request, and reused by every request that instance serves; it never listens (Vercel hands
 * it the Node request and response), and nothing in it relies on the instance staying alive: the database holds every job,
 * counter and session, so an instance may be stopped between two requests (and a second one started next to it) without
 * anything being lost.
 */

export type AppFactory = () => Promise<FastifyInstance>;

/** The app of this deployment: configured from the environment Vercel gives the function, without serving the SPA (Vercel does). */
export async function createVercelApp(deps: AppDeps = {}): Promise<FastifyInstance> {
  return buildApp(loadConfig(), { webDist: null, ...deps });
}

/**
 * A request handler that builds the app with `createApp` on first use and keeps it. A failed start (a bad environment, the
 * database not reachable) is not remembered: the next request tries again, and this one answers 500 without the reason.
 */
export function createHandler(
  createApp: AppFactory,
  onStartFailure: (error: unknown) => void = (error) => {
    console.error('the app could not start', error);
  },
): (request: IncomingMessage, response: ServerResponse) => Promise<void> {
  let starting: Promise<FastifyInstance> | undefined;
  const app = (): Promise<FastifyInstance> => {
    starting ??= createApp()
      .then(async (built) => {
        await built.ready();
        return built;
      })
      .catch((error: unknown) => {
        starting = undefined;
        throw error;
      });
    return starting;
  };

  return async (request, response) => {
    let instance: FastifyInstance;
    try {
      instance = await app();
    } catch (error) {
      onStartFailure(error);
      response.statusCode = 500;
      response.setHeader('content-type', 'application/json; charset=utf-8');
      response.end(
        JSON.stringify({ error: { code: 'INTERNAL', message: 'The server hit an unexpected error.' } }),
      );
      return;
    }
    // The standard way to run a Fastify app on a serverless platform: its HTTP server handles the request that was given.
    instance.server.emit('request', request, response);
  };
}

/** `export { default } from '@enchanted/server/vercel'` in `api/index.ts`. */
const handler = createHandler(() => createVercelApp());
export default handler;

/**
 * For file tracing only, never called: the ingestion worker threads are started from a file URL, which Vercel's tracer cannot
 * follow, so the worker (and with it everything only the worker imports: pdf.js extraction, the chunker, the OCR task) is
 * named here by a literal `import()`, which it can. `scripts/check-vercel-bundle.ts` checks that the traced bundle has it.
 */
export const TRACE_WORKER = (): Promise<unknown> => import('./ingest/worker/worker.js');
