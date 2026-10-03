import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  ApiErrorSchema,
  ERROR_HTTP_STATUS,
  HealthSchema,
  PublicConfigSchema,
  type ApiErrorBody,
} from '@enchanted/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { buildApp, type AppDeps } from '../src/app.js';
import { REPO_ROOT, type Config } from '../src/config.js';
import { createDb, type Db } from '../src/db/client.js';
import { AppError } from '../src/http/errors.js';
import { perIpRateLimit } from '../src/http/rate-limits.js';
import { CONTENT_SECURITY_POLICY } from '../src/http/security.js';
import { SESSION_COOKIE } from '../src/session/session.js';
import { FakeEmbeddings } from './doubles/fake-embeddings.js';
import { ScriptedLlm } from './doubles/scripted-llm.js';
import { PRODUCTION_ENV, resetCounters, testConfig } from './helpers.js';

let sharedDb: Db;
const apps: FastifyInstance[] = [];

beforeAll(async () => {
  sharedDb = await createDb(testConfig());
});

afterAll(async () => {
  await sharedDb.close();
});

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  // The limits count in the database, which the tests of this file share: each starts with empty counters.
  await resetCounters(sharedDb);
});

/** Builds an app on the shared in-memory database (the caller owns the database). */
async function makeApp(config: Config = testConfig(), deps: AppDeps = {}): Promise<FastifyInstance> {
  const app = await buildApp(config, { db: sharedDb, ...deps });
  apps.push(app);
  return app;
}

function parseError(body: string): ApiErrorBody {
  return ApiErrorSchema.parse(JSON.parse(body));
}

/** An OCR availability that has been checked and says `answer`; counts how often it is asked to start a check. */
function ocrAnswering(answer: boolean | null): {
  isAvailable: () => Promise<boolean>;
  peek: () => boolean | null;
  asked: () => number;
} {
  let asked = 0;
  return {
    asked: () => asked,
    peek: () => answer,
    isAvailable: () => {
      asked += 1;
      return Promise.resolve(answer === true);
    },
  };
}

describe('GET /api/health', () => {
  it('returns the health shape and creates no session', async () => {
    // The engine that was asked for does not start here: reported as unconfigured, not claimed.
    const app = await makeApp(testConfig({ OCR_PROVIDER: 'tesseract' }), {
      ingestion: { ocr: ocrAnswering(false) },
    });
    const sessionsBefore = (await sharedDb.query('SELECT 1 FROM sessions')).rowCount;
    const response = await app.inject('/api/health');
    expect(response.statusCode).toBe(200);
    const health = HealthSchema.parse(response.json());
    expect(health).toEqual({
      ok: true,
      db: 'pglite',
      // No key: the search model cannot be called, so it is not claimed (it is 'gemini:gemini-embedding-2' with one).
      providers: {
        llm: 'unconfigured',
        embeddings: 'unconfigured',
        ocr: 'unconfigured',
      },
    });
    expect(response.cookies).toHaveLength(0);
    expect((await sharedDb.query('SELECT 1 FROM sessions')).rowCount).toBe(sessionsBefore);
  });

  it('reports provider names only when they are configured and wired in', async () => {
    const configured = await makeApp(testConfig({ GEMINI_API_KEY: 'test-key', OCR_PROVIDER: 'tesseract' }), {
      providers: { embeddings: true, ocr: true },
    });
    expect(HealthSchema.parse((await configured.inject('/api/health')).json()).providers).toEqual({
      // provider and model, like the embeddings entry
      llm: 'gemini:gemini-3.5-flash-lite',
      embeddings: 'gemini:gemini-embedding-2',
      ocr: 'tesseract',
    });
    const anthropic = await makeApp(
      testConfig({ LLM_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: 'test-key', OCR_PROVIDER: 'none' }),
    );
    expect(HealthSchema.parse((await anthropic.inject('/api/health')).json()).providers.llm).toBe(
      'anthropic:claude-sonnet-5-5',
    );
    const withoutEmbeddings = await makeApp(testConfig({ OCR_PROVIDER: 'tesseract' }), {
      providers: { embeddings: false, ocr: false },
    });
    expect(
      HealthSchema.parse((await withoutEmbeddings.inject('/api/health')).json()).providers.embeddings,
    ).toBe('unconfigured');
    const none = await makeApp(testConfig({ LLM_PROVIDER: 'none', OCR_PROVIDER: 'none' }));
    expect(HealthSchema.parse((await none.inject('/api/health')).json()).providers).toMatchObject({
      llm: 'none',
      ocr: 'none',
    });
  });

  it('asks the OCR engine whether it can start when the provider is tesseract, and never when OCR is off', async () => {
    const working = ocrAnswering(true);
    const on = await makeApp(testConfig({ OCR_PROVIDER: 'tesseract' }), { ingestion: { ocr: working } });
    expect(HealthSchema.parse((await on.inject('/api/health')).json()).providers.ocr).toBe('tesseract');
    expect(PublicConfigSchema.parse((await on.inject('/api/config')).json()).ocr).toEqual({
      provider: 'tesseract',
      available: true,
    });
    const broken = await makeApp(testConfig({ OCR_PROVIDER: 'tesseract' }), {
      ingestion: { ocr: ocrAnswering(false) },
    });
    expect(HealthSchema.parse((await broken.inject('/api/health')).json()).providers.ocr).toBe(
      'unconfigured',
    );
    expect(PublicConfigSchema.parse((await broken.inject('/api/config')).json()).ocr).toEqual({
      provider: 'tesseract',
      available: false,
    });
    const off = ocrAnswering(true);
    const none = await makeApp(testConfig({ OCR_PROVIDER: 'none' }), { ingestion: { ocr: off } });
    expect(HealthSchema.parse((await none.inject('/api/health')).json()).providers.ocr).toBe('none');
    expect(PublicConfigSchema.parse((await none.inject('/api/config')).json()).ocr).toEqual({
      provider: 'none',
      available: false,
    });
    expect(off.asked()).toBe(0);
  });

  it('says "checking" while the OCR engine has not been checked, answers at once, and never starts the check itself', async () => {
    const unchecked = ocrAnswering(null);
    const app = await makeApp(testConfig({ OCR_PROVIDER: 'tesseract' }), { ingestion: { ocr: unchecked } });
    const began = Date.now();
    const health = await app.inject('/api/health');
    expect(health.statusCode).toBe(200);
    expect(HealthSchema.parse(health.json()).providers.ocr).toBe('checking');
    expect(PublicConfigSchema.parse((await app.inject('/api/config')).json()).ocr).toEqual({
      provider: 'tesseract',
      available: false,
    });
    expect(Date.now() - began).toBeLessThan(500);
    expect(unchecked.asked()).toBe(0); // a health call must not start the engine while the embedding model is loading
  });

  it('answers 503 with ok:false when the database cannot be queried', async () => {
    const failing: Db = {
      ...sharedDb,
      query: (sql, params) =>
        sql === 'SELECT 1' ? Promise.reject(new Error('connection lost')) : sharedDb.query(sql, params),
    };
    const app = await buildApp(testConfig(), { db: failing });
    apps.push(app);
    const response = await app.inject('/api/health');
    expect(response.statusCode).toBe(503);
    expect(HealthSchema.parse(response.json()).ok).toBe(false);
  });

  it('is not rate limited', async () => {
    const app = await makeApp(testConfig({ RATE_LIMIT_PER_MINUTE: '2' }));
    for (let i = 0; i < 5; i += 1) expect((await app.inject('/api/health')).statusCode).toBe(200);
  });
});

describe('GET /api/config', () => {
  // testConfig() switches OCR off (OCR_PROVIDER=none, see helpers.ts): the shape, not the production default, which is
  // `tesseract` and is pinned in config.test.ts.
  it('returns the public configuration shape without a session', async () => {
    const app = await makeApp();
    const response = await app.inject('/api/config');
    expect(response.statusCode).toBe(200);
    expect(PublicConfigSchema.parse(response.json())).toEqual({
      maxUploadBytes: 50 * 1024 * 1024,
      maxPages: 300,
      acceptedMimeTypes: ['application/pdf', 'application/x-pdf'],
      llm: {
        provider: 'gemini',
        model: 'gemini-3.5-flash-lite',
        available: false,
        profile: 'standard',
        // Gemini's free tier is the default: Google may use what is sent, so the UI is told to say so
        freeTierNotice: true,
      },
      // the search model needs the same key: without one the UI is told it cannot be used
      embeddings: { provider: 'gemini', model: 'gemini-embedding-2', available: false },
      ocr: { provider: 'none', available: false },
    });
    expect(response.cookies).toHaveLength(0);
  });

  it('says whether the search model can be called, by its key, and not only which one it is', async () => {
    const withKey = await makeApp(testConfig({ GEMINI_API_KEY: 'test-key' }));
    expect(PublicConfigSchema.parse((await withKey.inject('/api/config')).json()).embeddings).toEqual({
      provider: 'gemini',
      model: 'gemini-embedding-2',
      available: true,
    });
    const withoutKey = await makeApp(testConfig());
    expect(
      PublicConfigSchema.parse((await withoutKey.inject('/api/config')).json()).embeddings.available,
    ).toBe(false);
    const noProvider = await makeApp(testConfig({ GEMINI_API_KEY: 'test-key' }), {
      providers: { embeddings: false, ocr: false },
    });
    expect(
      PublicConfigSchema.parse((await noProvider.inject('/api/config')).json()).embeddings.available,
    ).toBe(false);
  });

  it('reflects configuration and never exposes secrets', async () => {
    const app = await makeApp(
      testConfig({ GEMINI_API_KEY: 'sk-secret-value', MAX_PAGES: '10', MAX_UPLOAD_MB: '5' }),
    );
    const response = await app.inject('/api/config');
    expect(response.body).not.toContain('sk-secret-value');
    expect(response.body).not.toContain('SESSION_SECRET');
    expect(PublicConfigSchema.parse(response.json())).toMatchObject({
      maxPages: 10,
      maxUploadBytes: 5 * 1024 * 1024,
      llm: { available: true },
    });
  });

  it('marks the model available once its key is set, and says nothing about a free tier for a billed key', async () => {
    const gemini = await makeApp(testConfig({ GEMINI_API_KEY: 'test-key', GEMINI_FREE_TIER: 'false' }));
    expect(PublicConfigSchema.parse((await gemini.inject('/api/config')).json()).llm).toEqual({
      provider: 'gemini',
      model: 'gemini-3.5-flash-lite',
      available: true,
      profile: 'standard',
      freeTierNotice: false,
    });
    const anthropic = await makeApp(
      testConfig({
        LLM_PROVIDER: 'anthropic',
        ANTHROPIC_API_KEY: 'test-key',
        EMBEDDING_PROVIDER: 'openai',
        EMBEDDING_MODEL: 'm',
      }),
    );
    expect(PublicConfigSchema.parse((await anthropic.inject('/api/config')).json()).llm).toMatchObject({
      provider: 'anthropic',
      available: true,
      freeTierNotice: false,
    });
  });

  it('names the stand-ins it is given and says nothing about a free tier when nothing is sent to Gemini', async () => {
    const standIns = await makeApp(testConfig({ GEMINI_FREE_TIER: 'true' }), {
      llm: new ScriptedLlm(),
      ingestion: { embeddings: new FakeEmbeddings() },
    });
    const config = PublicConfigSchema.parse((await standIns.inject('/api/config')).json());
    expect(config.llm).toMatchObject({ provider: 'scripted', available: true, freeTierNotice: false });
    expect(config.embeddings).toMatchObject({ provider: 'fake', available: true });
    expect(HealthSchema.parse((await standIns.inject('/api/health')).json()).providers.llm).toMatch(
      /^scripted/u,
    );
  });

  it('only reports OCR as available once the provider is wired in', async () => {
    const app = await makeApp(testConfig({ OCR_PROVIDER: 'tesseract' }), {
      providers: { embeddings: true, ocr: true },
    });
    expect(PublicConfigSchema.parse((await app.inject('/api/config')).json()).ocr).toEqual({
      provider: 'tesseract',
      available: true,
    });
  });
});

describe('security headers', () => {
  it('adds nosniff, same-origin referrer policy and frame denial to every response', async () => {
    const app = await makeApp();
    for (const url of ['/api/health', '/api/nope']) {
      const response = await app.inject(url);
      expect(response.headers['x-content-type-options']).toBe('nosniff');
      expect(response.headers['referrer-policy']).toBe('same-origin');
      expect(response.headers['x-frame-options']).toBe('DENY');
    }
  });

  it('sends the CSP only in production', async () => {
    const development = await makeApp();
    expect((await development.inject('/api/health')).headers['content-security-policy']).toBeUndefined();
    const production = await makeApp(testConfig(PRODUCTION_ENV), { webDist: null });
    const header = (await production.inject('/api/health')).headers['content-security-policy'];
    expect(header).toBe(CONTENT_SECURITY_POLICY);
    expect(header).toBe(
      "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self' blob:; img-src 'self' data: blob:; " +
        "style-src 'self' 'unsafe-inline'; font-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; " +
        "frame-ancestors 'none'",
    );
  });

  it('lets a route set its own CSP', async () => {
    const app = await makeApp(testConfig(PRODUCTION_ENV), { webDist: null });
    app.get('/api/_sandboxed', { config: { public: true } }, (_request, reply) =>
      reply.header('Content-Security-Policy', 'sandbox').send('ok'),
    );
    expect((await app.inject('/api/_sandboxed')).headers['content-security-policy']).toBe('sandbox');
  });
});

describe('sessions', () => {
  async function appWithWhoami(config: Config = testConfig()): Promise<FastifyInstance> {
    const app = await makeApp(config);
    app.get('/api/_whoami', (request) => ({ sessionId: request.sessionId }));
    return app;
  }

  async function sessionRow(id: string): Promise<{ last_seen_at: Date } | undefined> {
    return (
      await sharedDb.query<{ last_seen_at: Date }>('SELECT last_seen_at FROM sessions WHERE id = $1', [id])
    ).rows[0];
  }

  it('issues a signed httpOnly cookie once and creates the session row', async () => {
    const app = await appWithWhoami();
    const first = await app.inject('/api/_whoami');
    const { sessionId } = first.json<{ sessionId: string }>();
    expect(sessionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(first.cookies).toHaveLength(1);
    const cookie = first.cookies[0];
    expect(cookie).toMatchObject({ name: SESSION_COOKIE, path: '/', httpOnly: true, sameSite: 'Lax' });
    expect(cookie?.secure).toBeFalsy();
    expect(cookie?.value).toContain(sessionId); // `<id>.<signature>`
    expect(cookie?.value).not.toBe(sessionId);
    expect(cookie?.maxAge).toBe(72 * 3600);
    expect(await sessionRow(sessionId)).toBeDefined();
  });

  it('reuses the session for a returning cookie without issuing another', async () => {
    const app = await appWithWhoami();
    const first = await app.inject('/api/_whoami');
    const cookie = first.cookies[0];
    expect(cookie).toBeDefined();
    const second = await app.inject({
      url: '/api/_whoami',
      cookies: { [SESSION_COOKIE]: cookie?.value ?? '' },
    });
    expect(second.json()).toEqual(first.json());
    expect(second.cookies).toHaveLength(0);
  });

  it('touches last_seen_at at most once a minute and re-issues the cookie when it does', async () => {
    const app = await appWithWhoami();
    const first = await app.inject('/api/_whoami');
    const { sessionId } = first.json<{ sessionId: string }>();
    const cookies = { [SESSION_COOKIE]: first.cookies[0]?.value ?? '' };

    const before = (await sessionRow(sessionId))?.last_seen_at.getTime() ?? 0;
    await app.inject({ url: '/api/_whoami', cookies });
    expect((await sessionRow(sessionId))?.last_seen_at.getTime()).toBe(before);

    await sharedDb.query(`UPDATE sessions SET last_seen_at = now() - interval '2 minutes' WHERE id = $1`, [
      sessionId,
    ]);
    const stale = (await sessionRow(sessionId))?.last_seen_at.getTime() ?? 0;
    const touched = await app.inject({ url: '/api/_whoami', cookies });
    expect((await sessionRow(sessionId))?.last_seen_at.getTime()).toBeGreaterThan(stale);
    expect(touched.cookies).toHaveLength(1);
    expect(touched.json<{ sessionId: string }>().sessionId).toBe(sessionId);
  });

  it('replaces a forged or unsigned cookie with a new session', async () => {
    const app = await appWithWhoami();
    const forgedId = '11111111-2222-4333-8444-555555555555';
    for (const value of [forgedId, `${forgedId}.not-a-valid-signature`, 'garbage']) {
      const response = await app.inject({ url: '/api/_whoami', cookies: { [SESSION_COOKIE]: value } });
      const { sessionId } = response.json<{ sessionId: string }>();
      expect(sessionId).not.toBe(forgedId);
      expect(response.cookies).toHaveLength(1);
    }
    expect(await sessionRow(forgedId)).toBeUndefined();
  });

  it('re-creates the row for a valid cookie whose session was swept', async () => {
    const app = await appWithWhoami();
    const first = await app.inject('/api/_whoami');
    const { sessionId } = first.json<{ sessionId: string }>();
    await sharedDb.query('DELETE FROM sessions WHERE id = $1', [sessionId]);
    const again = await app.inject({
      url: '/api/_whoami',
      cookies: { [SESSION_COOKIE]: first.cookies[0]?.value ?? '' },
    });
    expect(again.json<{ sessionId: string }>().sessionId).toBe(sessionId);
    expect(await sessionRow(sessionId)).toBeDefined();
  });

  it('marks the cookie Secure in production', async () => {
    const app = await appWithWhoami(testConfig(PRODUCTION_ENV));
    const response = await app.inject('/api/_whoami');
    expect(response.cookies[0]?.secure).toBe(true);
  });

  it('creates no session row and sets no cookie for requests the rate limiter rejects', async () => {
    const app = await appWithWhoami(testConfig({ RATE_LIMIT_PER_MINUTE: '2' }));
    const before = (await sharedDb.query('SELECT 1 FROM sessions')).rowCount;
    const responses = [];
    for (let i = 0; i < 10; i += 1) responses.push(await app.inject('/api/_whoami')); // a client that drops cookies
    expect(responses.map((response) => response.statusCode)).toEqual([
      200,
      200,
      ...Array<number>(8).fill(429),
    ]);
    expect(responses.slice(2).flatMap((response) => response.cookies)).toEqual([]);
    // One row per admitted request, none for the eight rejected ones.
    expect((await sharedDb.query('SELECT 1 FROM sessions')).rowCount).toBe(before + 2);
  });

  it('gives a request to a percent-encoded API path a real session, as the route it reaches expects', async () => {
    const app = await appWithWhoami();
    // `/%61pi/_whoami` is decoded by the router and served by the route `/api/_whoami`.
    for (const url of ['/%61pi/_whoami', '/api/%5Fwhoami', '/%61pi/%5Fwhoami']) {
      const response = await app.inject(url);
      expect(response.statusCode, url).toBe(200);
      const { sessionId } = response.json<{ sessionId: string }>();
      expect(sessionId, url).toMatch(/^[0-9a-f-]{36}$/);
      expect(response.cookies, url).toHaveLength(1);
      expect(await sessionRow(sessionId), url).toBeDefined();
    }
  });

  it('does not create sessions for unknown routes', async () => {
    const app = await appWithWhoami();
    const before = (await sharedDb.query('SELECT 1 FROM sessions')).rowCount;
    const response = await app.inject('/api/not-a-route');
    expect(response.statusCode).toBe(404);
    expect(response.cookies).toHaveLength(0);
    expect((await sharedDb.query('SELECT 1 FROM sessions')).rowCount).toBe(before);
  });
});

describe('error handling', () => {
  it('answers an unknown route with a 404 ApiError', async () => {
    const app = await makeApp();
    for (const method of ['GET', 'POST'] as const) {
      const response = await app.inject({ method, url: '/api/nowhere?x=1' });
      expect(response.statusCode).toBe(404);
      expect(response.headers['content-type']).toContain('application/json');
      const { error } = parseError(response.body);
      expect(error.code).toBe('DOCUMENT_NOT_FOUND');
      expect(error.detail).toBe(`${method} /api/nowhere`);
    }
  });

  it('maps an AppError to its status, code, message and detail', async () => {
    const app = await makeApp();
    app.get('/api/_boom', { config: { public: true } }, () => {
      throw new AppError('PDF_ENCRYPTED', 'This manuscript is sealed.', 'the file requires a password');
    });
    const response = await app.inject('/api/_boom');
    expect(response.statusCode).toBe(422);
    expect(parseError(response.body)).toEqual({
      error: {
        code: 'PDF_ENCRYPTED',
        message: 'This manuscript is sealed.',
        detail: 'the file requires a password',
      },
    });
  });

  it('omits detail when an AppError has none', async () => {
    const app = await makeApp();
    app.get('/api/_busy', { config: { public: true } }, () => {
      throw new AppError('DIARY_BUSY', 'The diary is still writing.');
    });
    const response = await app.inject('/api/_busy');
    expect(response.statusCode).toBe(429);
    expect(parseError(response.body).error).toEqual({
      code: 'DIARY_BUSY',
      message: 'The diary is still writing.',
    });
  });

  it('maps zod validation errors to QUESTION_INVALID / 400 with the offending field', async () => {
    const app = await makeApp();
    app.post('/api/_validate', { config: { public: true } }, (request) =>
      z.object({ question: z.string().min(1) }).parse(request.body),
    );
    const response = await app.inject({ method: 'POST', url: '/api/_validate', payload: { question: '' } });
    expect(response.statusCode).toBe(400);
    const { error } = parseError(response.body);
    expect(error.code).toBe('QUESTION_INVALID');
    expect(error.detail).toContain('question');
  });

  it('maps malformed JSON bodies to QUESTION_INVALID / 400', async () => {
    const app = await makeApp();
    app.post('/api/_json', { config: { public: true } }, () => ({ ok: true }));
    const response = await app.inject({
      method: 'POST',
      url: '/api/_json',
      headers: { 'content-type': 'application/json' },
      payload: '{"broken":',
    });
    expect(response.statusCode).toBe(400);
    expect(parseError(response.body).error.code).toBe('QUESTION_INVALID');
  });

  it('maps multipart limit errors to FILE_TOO_LARGE / 413', async () => {
    const app = await makeApp();
    app.get('/api/_limit', { config: { public: true } }, () => {
      throw Object.assign(new Error('request file too large'), {
        code: 'FST_REQ_FILE_TOO_LARGE',
        statusCode: 413,
      });
    });
    const response = await app.inject('/api/_limit');
    expect(response.statusCode).toBe(413);
    expect(parseError(response.body).error.code).toBe('FILE_TOO_LARGE');
  });

  it.each([
    [400, 'QUESTION_INVALID'],
    [401, 'INTERNAL'],
    [403, 'INTERNAL'],
    [404, 'DOCUMENT_NOT_FOUND'],
    [405, 'INTERNAL'],
    [408, 'INTERNAL'],
    [409, 'INTERNAL'],
    [429, 'RATE_LIMITED'],
  ])('keeps the status of a thrown %i error (code %s)', async (statusCode, code) => {
    const app = await makeApp();
    app.get('/api/_status', { config: { public: true } }, () => {
      throw Object.assign(new Error(`thrown ${String(statusCode)}`), { statusCode });
    });
    const response = await app.inject('/api/_status');
    expect(response.statusCode).toBe(statusCode);
    expect(parseError(response.body).error.code).toBe(code);
  });

  it('does not treat a thrown 5xx as anything but INTERNAL / 500', async () => {
    const app = await makeApp(testConfig(PRODUCTION_ENV), { webDist: null });
    app.get('/api/_unavailable', { config: { public: true } }, () => {
      throw Object.assign(new Error('upstream is down'), { statusCode: 503 });
    });
    const response = await app.inject('/api/_unavailable');
    expect(response.statusCode).toBe(500);
    expect(parseError(response.body)).toEqual({
      error: { code: 'INTERNAL', message: 'The server hit an unexpected error.' },
    });
  });

  describe('413 and 415', () => {
    async function twoRoutes(): Promise<FastifyInstance> {
      const app = await makeApp();
      const fail = (statusCode: number) => () => {
        throw Object.assign(new Error('refused'), { statusCode });
      };
      app.get('/api/_json413', { config: { public: true } }, fail(413));
      app.get('/api/_json415', { config: { public: true } }, fail(415));
      app.get('/api/_upload413', { config: { public: true, upload: true } }, fail(413));
      app.get('/api/_upload415', { config: { public: true, upload: true } }, fail(415));
      return app;
    }

    it('mean file problems only on the upload route', async () => {
      const app = await twoRoutes();
      const tooLarge = await app.inject('/api/_upload413');
      expect(tooLarge.statusCode).toBe(413);
      expect(parseError(tooLarge.body).error.code).toBe('FILE_TOO_LARGE');
      const notPdf = await app.inject('/api/_upload415');
      expect(notPdf.statusCode).toBe(415);
      expect(parseError(notPdf.body).error.code).toBe('FILE_NOT_PDF');
    });

    it('are about the request on every other route: a question is not a PDF', async () => {
      const app = await twoRoutes();
      for (const url of ['/api/_json413', '/api/_json415']) {
        const response = await app.inject(url);
        expect(response.statusCode).toBe(url.includes('413') ? 413 : 415);
        expect(parseError(response.body).error.code).toBe('QUESTION_INVALID');
      }
    });

    it('apply to a real oversized body: FILE_TOO_LARGE on the upload route, QUESTION_INVALID elsewhere', async () => {
      const app = await makeApp();
      app.post('/api/_ask', { config: { public: true } }, () => ({ ok: true }));
      app.post('/api/_upload', { config: { public: true, upload: true } }, () => ({ ok: true }));
      const payload = JSON.stringify({ question: 'x'.repeat(1_200_000) }); // over Fastify's 1 MiB default
      const headers = { 'content-type': 'application/json' };
      const ask = await app.inject({ method: 'POST', url: '/api/_ask', headers, payload });
      expect(ask.statusCode).toBe(413);
      expect(parseError(ask.body).error.code).toBe('QUESTION_INVALID');
      const upload = await app.inject({ method: 'POST', url: '/api/_upload', headers, payload });
      expect(upload.statusCode).toBe(413);
      expect(parseError(upload.body).error.code).toBe('FILE_TOO_LARGE');
    });
  });

  describe('percent-encoded API paths', () => {
    it('count against the global per-IP limit like the plain path', async () => {
      const app = await makeApp(testConfig({ RATE_LIMIT_PER_MINUTE: '2' }));
      app.get('/api/_limited', { config: { public: true } }, () => ({ ok: true }));
      const urls = [
        '/api/_limited',
        '/%61pi/_limited',
        '/%61pi/_limited',
        '/api/_limited',
        '/api/%5Flimited',
      ];
      const statuses: number[] = [];
      for (const url of urls) statuses.push((await app.inject(url)).statusCode);
      expect(statuses).toEqual([200, 200, 429, 429, 429]);
    });

    it('count against a route-level limit like the plain path (the per-IP upload limit)', async () => {
      const app = await makeApp();
      app.post(
        '/api/_upload',
        {
          config: { public: true },
          onRequest: [perIpRateLimit(app, { name: 'test-route', max: 1, timeWindow: '1 minute' })],
        },
        () => ({ ok: true }),
      );
      const statuses: number[] = [];
      for (const url of ['/%61pi/_upload', '/api/_upload', '/%61pi/_upload']) {
        statuses.push((await app.inject({ method: 'POST', url })).statusCode);
      }
      expect(statuses).toEqual([200, 429, 429]);
    });

    it('are still served without a limit when they lead to a static file', async () => {
      const dist = await mkdtemp(path.join(REPO_ROOT, '.data', 'tmp', 'encoded-static-'));
      try {
        await writeFile(path.join(dist, 'index.html'), '<!doctype html><title>shell</title>');
        const app = await makeApp(testConfig({ ...PRODUCTION_ENV, RATE_LIMIT_PER_MINUTE: '2' }), {
          webDist: dist,
        });
        for (let i = 0; i < 6; i += 1) expect((await app.inject('/index.html')).statusCode).toBe(200);
      } finally {
        await rm(dist, { recursive: true, force: true });
      }
    });
  });

  describe('requests that match no route', () => {
    it('answer a JSON 404 and are never rate limited, never given a session', async () => {
      const app = await makeApp(testConfig({ RATE_LIMIT_PER_MINUTE: '2' }));
      const before = (await sharedDb.query('SELECT 1 FROM sessions')).rowCount;
      for (const url of ['/api/nope', '/%61pi/nope', '/missing.js', '/%2e%2e/%61pi/x']) {
        for (let i = 0; i < 6; i += 1) {
          const response = await app.inject(url);
          expect(response.statusCode, url).toBe(404);
          expect(parseError(response.body).error.code, url).toBe('DOCUMENT_NOT_FOUND');
          expect(response.cookies, url).toHaveLength(0);
        }
      }
      expect((await sharedDb.query('SELECT 1 FROM sessions')).rowCount).toBe(before);
    });

    it('answer a malformed URL with the contract error shape, with the security headers', async () => {
      const app = await makeApp();
      for (const url of ['/api/%E0%A4%A', '/%E0%A4%A', '/api/_x/%']) {
        const response = await app.inject(url);
        expect(response.statusCode, url).toBe(400);
        expect(parseError(response.body).error.code, url).toBe('QUESTION_INVALID');
        expect(response.headers['content-type'], url).toContain('application/json');
        expect(response.headers['x-content-type-options'], url).toBe('nosniff');
      }
    });
  });

  describe('multipart errors on the upload route', () => {
    async function uploadApp(): Promise<FastifyInstance> {
      // The multipart plugin is registered by the document routes, with the upload limit from the configuration.
      const app = await makeApp(testConfig({}, { maxUploadBytes: 50 }));
      app.post('/api/_upload', { config: { public: true, upload: true } }, async (request) => {
        const file = await request.file();
        if (!file) throw new Error('no file');
        await file.toBuffer(); // throws when the file is over the limit
        return { ok: true };
      });
      return app;
    }

    const boundary = 'test-boundary';
    const multipartBody = (content: string): string =>
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="a.pdf"\r\nContent-Type: application/pdf\r\n\r\n${content}\r\n--${boundary}--\r\n`;

    it('answer FILE_MISSING with the contract status 400 (the plugin itself says 406)', async () => {
      const app = await uploadApp();
      const response = await app.inject({
        method: 'POST',
        url: '/api/_upload',
        headers: { 'content-type': 'application/json' },
        payload: '{}',
      });
      expect(response.statusCode).toBe(ERROR_HTTP_STATUS.FILE_MISSING);
      expect(parseError(response.body).error.code).toBe('FILE_MISSING');
    });

    it('answer FILE_TOO_LARGE with 413 for a file over the limit', async () => {
      const app = await uploadApp();
      const response = await app.inject({
        method: 'POST',
        url: '/api/_upload',
        headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
        payload: multipartBody('A'.repeat(500)),
      });
      expect(response.statusCode).toBe(ERROR_HTTP_STATUS.FILE_TOO_LARGE);
      expect(parseError(response.body).error.code).toBe('FILE_TOO_LARGE');
    });

    it('accept a file within the limit', async () => {
      const app = await uploadApp();
      const response = await app.inject({
        method: 'POST',
        url: '/api/_upload',
        headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
        payload: multipartBody('A'.repeat(10)),
      });
      expect(response.statusCode).toBe(200);
    });

    it('uses the contract status whenever a plugin error is mapped onto a contract meaning, whatever status it carried', async () => {
      const app = await makeApp();
      const cases: [
        fastifyCode: string,
        carriedStatus: number,
        code: 'FILE_MISSING' | 'FILE_TOO_LARGE' | 'DOCUMENT_NOT_FOUND',
      ][] = [
        ['FST_INVALID_MULTIPART_CONTENT_TYPE', 406, 'FILE_MISSING'],
        ['FST_INVALID_JSON_FIELD_ERROR', 406, 'FILE_MISSING'],
        ['FST_FILES_LIMIT', 413, 'FILE_TOO_LARGE'],
        ['FST_PARTS_LIMIT', 400, 'FILE_TOO_LARGE'],
        ['FST_FIELDS_LIMIT', 422, 'FILE_TOO_LARGE'],
        ['FST_ERR_MAX_PARAM_LENGTH', 414, 'DOCUMENT_NOT_FOUND'], // an :id over the router's limit
      ];
      for (const [fastifyCode, statusCode] of cases) {
        app.get(`/api/_${fastifyCode}`, { config: { public: true } }, () => {
          throw Object.assign(new Error('refused'), { statusCode, code: fastifyCode });
        });
      }
      for (const [fastifyCode, statusCode, code] of cases) {
        const response = await app.inject(`/api/_${fastifyCode}`);
        expect(response.statusCode, `${fastifyCode} carried ${String(statusCode)}`).toBe(
          ERROR_HTTP_STATUS[code],
        );
        expect(parseError(response.body).error.code).toBe(code);
      }
    });
  });

  it('maps the rate limit to RATE_LIMITED / 429', async () => {
    const app = await makeApp(testConfig({ RATE_LIMIT_PER_MINUTE: '3' }));
    app.get('/api/_limited', { config: { public: true } }, () => ({ ok: true }));
    const statuses: number[] = [];
    let last: Awaited<ReturnType<typeof app.inject>> | undefined;
    for (let i = 0; i < 5; i += 1) {
      last = await app.inject('/api/_limited');
      statuses.push(last.statusCode);
    }
    expect(statuses).toEqual([200, 200, 200, 429, 429]);
    expect(parseError(last?.body ?? '').error.code).toBe('RATE_LIMITED');
    expect(last?.headers['retry-after']).toBeDefined();
  });

  describe('unexpected errors', () => {
    const secretMessage = 'boom: could not read /home/someone/secret/file.pdf';

    async function boomApp(config: Config): Promise<FastifyInstance> {
      const app = await makeApp(config, { webDist: null });
      app.get('/api/_crash', { config: { public: true } }, () => {
        throw new Error(secretMessage);
      });
      return app;
    }

    it('hides the message and stack in production', async () => {
      const app = await boomApp(testConfig(PRODUCTION_ENV));
      const response = await app.inject('/api/_crash');
      expect(response.statusCode).toBe(500);
      expect(parseError(response.body)).toEqual({
        error: { code: 'INTERNAL', message: 'The server hit an unexpected error.' },
      });
      expect(response.body).not.toContain('boom');
      expect(response.body).not.toContain('/home/someone');
      expect(response.body).not.toContain('stack');
      expect(response.body).not.toContain('.ts:');
    });

    it('includes the message but never the stack outside production', async () => {
      const app = await boomApp(testConfig());
      const response = await app.inject('/api/_crash');
      expect(response.statusCode).toBe(500);
      const { error } = parseError(response.body);
      expect(error.code).toBe('INTERNAL');
      expect(error.detail).toBe(secretMessage);
      expect(response.body).not.toContain('stack');
      expect(response.body).not.toMatch(/\bat .*\(.*:\d+:\d+\)/);
    });
  });
});

describe('static serving', () => {
  let webDist: string;

  beforeAll(async () => {
    webDist = await mkdtemp(path.join(REPO_ROOT, '.data', 'tmp', 'web-dist-'));
    await mkdir(path.join(webDist, 'assets'));
    await writeFile(
      path.join(webDist, 'index.html'),
      '<!doctype html><title>shell</title><div id="root"></div>',
    );
    await writeFile(path.join(webDist, 'assets', 'app-abc123.js'), 'console.log("app");');
  });

  afterAll(async () => {
    await rm(webDist, { recursive: true, force: true });
  });

  it('serves the shell at / with revalidation and the production CSP', async () => {
    const app = await makeApp(testConfig(PRODUCTION_ENV), { webDist });
    const response = await app.inject('/');
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain('<title>shell</title>');
    expect(response.headers['cache-control']).toBe('no-cache');
    expect(response.headers['content-security-policy']).toBe(CONTENT_SECURITY_POLICY);
  });

  it('does not count static files against the API rate limit', async () => {
    const app = await makeApp(testConfig({ ...PRODUCTION_ENV, RATE_LIMIT_PER_MINUTE: '3' }), { webDist });
    app.get('/api/_limited', { config: { public: true } }, () => ({ ok: true }));
    const html = { accept: 'text/html' };
    for (let i = 0; i < 10; i += 1) {
      expect((await app.inject('/assets/app-abc123.js')).statusCode).toBe(200);
      expect((await app.inject({ url: '/', headers: html })).statusCode).toBe(200);
      expect((await app.inject({ url: '/some/client/route', headers: html })).statusCode).toBe(200);
    }
    // The API budget is untouched by all of that, and still enforced.
    const api = [];
    for (let i = 0; i < 5; i += 1) api.push((await app.inject('/api/_limited')).statusCode);
    expect(api).toEqual([200, 200, 200, 429, 429]);
    // A missing asset is a plain 404, not a 429.
    expect((await app.inject('/assets/missing-123.js')).statusCode).toBe(404);
  });

  it('serves hashed assets as immutable', async () => {
    const app = await makeApp(testConfig(PRODUCTION_ENV), { webDist });
    const response = await app.inject('/assets/app-abc123.js');
    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('public, max-age=31536000, immutable');
  });

  it('falls back to the shell for client-side routes that ask for HTML', async () => {
    const app = await makeApp(testConfig(PRODUCTION_ENV), { webDist });
    const response = await app.inject({
      url: '/some/client/route',
      headers: { accept: 'text/html,application/xhtml+xml' },
    });
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain('<title>shell</title>');
  });

  it('keeps JSON 404s for the API, missing files and non-HTML requests, and creates no session', async () => {
    const app = await makeApp(testConfig(PRODUCTION_ENV), { webDist });
    const before = (await sharedDb.query('SELECT 1 FROM sessions')).rowCount;
    for (const request of [
      { url: '/api/nope', headers: { accept: 'text/html' } },
      { url: '/missing.js', headers: { accept: 'text/html' } },
      { url: '/some/route', headers: { accept: 'application/json' } },
      { url: '/some/route', method: 'POST' as const, headers: { accept: 'text/html' } },
    ]) {
      const response = await app.inject(request);
      expect(response.statusCode).toBe(404);
      expect(parseError(response.body).error.code).toBe('DOCUMENT_NOT_FOUND');
    }
    expect((await sharedDb.query('SELECT 1 FROM sessions')).rowCount).toBe(before);
  });

  it('serves nothing in development unless a directory is given', async () => {
    const app = await makeApp();
    expect((await app.inject({ url: '/', headers: { accept: 'text/html' } })).statusCode).toBe(404);
  });

  it('answers JSON 404s when the web build is missing', async () => {
    const app = await makeApp(testConfig(PRODUCTION_ENV), { webDist: path.join(webDist, 'does-not-exist') });
    const response = await app.inject({ url: '/', headers: { accept: 'text/html' } });
    expect(response.statusCode).toBe(404);
    expect(parseError(response.body).error.code).toBe('DOCUMENT_NOT_FOUND');
  });
});

describe('lifecycle', () => {
  it('closes a database it created, and leaves an injected one open', async () => {
    const owning = await buildApp(testConfig());
    await owning.close();
    await expect(owning.db.query('SELECT 1')).rejects.toThrow();

    const borrowing = await buildApp(testConfig(), { db: sharedDb });
    await borrowing.close();
    expect((await sharedDb.query('SELECT 1 AS one')).rows).toEqual([{ one: 1 }]);
  });

  it('migrates the database it is given', async () => {
    const app = await makeApp();
    const versions = await app.db.query('SELECT version FROM schema_migrations');
    expect(versions.rows).toEqual([
      { version: '001_init' },
      { version: '002_serverless' },
      { version: '003_upload_tickets' },
    ]);
  });
});
