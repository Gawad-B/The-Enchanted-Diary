import fastifyCookie from '@fastify/cookie';
import Fastify, { type FastifyInstance } from 'fastify';
import { mayDeleteData, type Config } from './config.js';
import { createDb, type Db } from './db/client.js';
import { runMigrations } from './db/migrate.js';
import { createIngestion, type Ingestion, type IngestionOverrides } from './ingest/index.js';
import { registerAskRoute } from './http/ask.js';
import { registerConversationRoutes } from './http/conversation.js';
import { registerCronRoutes } from './http/cron.js';
import { registerDocumentRoutes } from './http/documents.js';
import { registerRevealRoute } from './http/reveal.js';
import { registerSessionRoutes } from './http/session-routes.js';
import { registerTickRoutes } from './http/ticks.js';
import { registerUploadRoutes, type HandleUpload } from './http/uploads.js';
import { registerErrorHandling, sendError, sendNotFound, type NotFoundHandler } from './http/errors.js';
import { registerIpRateLimit } from './http/rate-limits.js';
import { applySecurityHeaders, contentSecurityPolicy, registerSecurityHeaders } from './http/security.js';
import { DEFAULT_WEB_DIST, registerWebStatic } from './http/static.js';
import { NO_PROVIDERS_READY, registerStatusRoutes, type ProviderReadiness } from './http/status.js';
import { createLlmProvider, type LLMProvider } from './llm/index.js';
import { buildLoggerOptions } from './logging.js';
import type { EvidenceThresholds } from './rag/constants.js';
import type { RagDeps } from './rag/answer.js';
import { registerSession } from './session/session.js';

declare module 'fastify' {
  interface FastifyInstance {
    db: Db;
    /** Storage, workers, embeddings, budgets and the tick runner of the PDF ingestion pipeline. */
    ingestion: Ingestion;
    /** The chat model that writes answers (a configured provider, or a double in tests). */
    llm: LLMProvider;
  }
}

/** Collaborators that tests (and later tasks) can replace. Everything is optional. */
export interface AppDeps {
  /** An already-open database (tests). The caller owns it: it is migrated but not closed by `app.close()`. */
  db?: Db;
  /** Which provider implementations are wired in; see ProviderReadiness. */
  providers?: ProviderReadiness;
  /** Directory with the built SPA; `null` disables static serving. Defaults to apps/web/dist in production. */
  webDist?: string | null;
  /** Replaces pieces of the ingestion pipeline (storage, embeddings, workers). Tests only. */
  ingestion?: IngestionOverrides;
  /** The Blob SDK's `handleUpload`, which makes the tokens browsers upload with. Tests only. */
  handleUpload?: HandleUpload;
  /**
   * The chat model. Without it the one the configuration asks for is created (and closed with the app); a provider
   * passed here belongs to the caller. The deterministic end-to-end server passes a scripted one.
   */
  llm?: LLMProvider;
  /** Overrides inside the RAG pipeline: the evidence thresholds of a stand-in embedding model, the prompt canary. Tests only. */
  rag?: { evidence?: EvidenceThresholds; canary?: string };
  /** Heartbeat of the ask and reveal streams in milliseconds (the contract says 5 s). Tests only. */
  answerHeartbeatMs?: number;
}

/**
 * Builds the Fastify application: database + migrations, security headers, rate limiting, signed-cookie
 * sessions, routes and the error contract. It does not listen (see main.ts) and is not yet `ready()`, so
 * tests can add routes before calling `app.inject`.
 */
export async function buildApp(config: Config, deps: AppDeps = {}): Promise<FastifyInstance> {
  const app = Fastify({
    logger: buildLoggerOptions(config),
    trustProxy: config.trustProxy,
    // Errors raised before routing (a malformed URL such as /api/%E0%A4%A) skip the error handler and the
    // onSend hooks; without this they would answer with Fastify's own body instead of the ApiErrorSchema shape,
    // and without the security headers.
    frameworkErrors: (error, _request, reply) => {
      applySecurityHeaders(reply, { csp: config.isProduction });
      void sendError(reply, error, config);
    },
  });

  const db = deps.db ?? (await createDb(config, app.log));
  const ownsDb = deps.db === undefined;
  try {
    // A preview that was not told it has a database of its own must not change one that may be production's.
    if (mayDeleteData(config)) await runMigrations(db);
    else app.log.warn('migrations skipped: this is not production and ALLOW_PREVIEW_DATA is not true');
  } catch (error) {
    if (ownsDb) await db.close();
    throw error;
  }
  app.decorate('db', db);

  // A document a previous process left half-read is not lost: its job is in the database and the next tick goes on.
  const ingestion = await createIngestion(config, db, app.log, deps.ingestion);
  app.decorate('ingestion', ingestion);
  const ownsLlm = deps.llm === undefined;
  const llm = deps.llm ?? createLlmProvider(config);
  app.decorate('llm', llm);
  app.addHook('onClose', async () => {
    if (ownsLlm) await llm.dispose?.();
    await ingestion.close();
    if (ownsDb) await db.close();
  });

  // The error handler goes in before any route so that every route, including the ones below, uses it.
  // Static serving may replace the 404 body later (SPA fallback), hence the late-bound handler.
  let onNotFound: NotFoundHandler = (request, reply) => sendNotFound(request, reply, config);
  registerErrorHandling(app, config, (request, reply) => onNotFound(request, reply));

  registerSecurityHeaders(app, {
    csp: config.isProduction,
    policy: contentSecurityPolicy({ blob: config.storageProvider === 'vercel-blob' }),
  });
  // Per client address, over the API (the built web app is never limited); the counters are rows of the database.
  registerIpRateLimit(app, config);
  await app.register(fastifyCookie, { secret: config.sessionSecret });
  registerSession(app, config, db);

  registerStatusRoutes(app, config, db, {
    ...NO_PROVIDERS_READY,
    // Ready when the provider can be used (its key is set): without one a question cannot be searched.
    embeddings: ingestion.embeddings.isConfigured?.() ?? true,
    embeddingsLabel: `${ingestion.embeddings.name}:${ingestion.embeddings.model}`,
    embeddingsInfo: { provider: ingestion.embeddings.name, model: ingestion.embeddings.model },
    // Whether the OCR engine can start is found out once, in a worker thread (after the embedding model has loaded, or
    // by the first scanned page); health and config only read the answer.
    ocr: () => ingestion.ocr.peek(),
    llm,
    ...deps.providers,
  });
  await registerDocumentRoutes(app, config, { db, ingestion });
  registerUploadRoutes(app, config, {
    db,
    ingestion,
    ...(deps.handleUpload === undefined ? {} : { handleUpload: deps.handleUpload }),
  });
  registerTickRoutes(app, config, { db, ingestion });
  registerCronRoutes(app, config, { db, ingestion });
  registerSessionRoutes(app, config, { db, ingestion });

  const rag: RagDeps = {
    db,
    config,
    embeddings: ingestion.embeddings,
    llm,
    log: app.log,
    ...(deps.rag?.evidence === undefined ? {} : { evidence: deps.rag.evidence }),
    ...(deps.rag?.canary === undefined ? {} : { canary: deps.rag.canary }),
  };
  const answerRoutes = {
    db,
    rag,
    // reserved by the routes themselves, once a question is accepted, and given back when no model was asked (§S.7)
    budgets: ingestion.budgets,
    ...(deps.answerHeartbeatMs === undefined ? {} : { heartbeatMs: deps.answerHeartbeatMs }),
  };
  registerAskRoute(app, config, answerRoutes);
  registerRevealRoute(app, config, answerRoutes);
  registerConversationRoutes(app, config, db);

  const webDist = deps.webDist === undefined ? (config.isProduction ? DEFAULT_WEB_DIST : null) : deps.webDist;
  if (webDist !== null) onNotFound = await registerWebStatic(app, config, webDist);

  return app;
}
