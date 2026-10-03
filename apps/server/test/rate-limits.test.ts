import { ApiErrorSchema } from '@enchanted/shared';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import type { Config } from '../src/config.js';
import { createDb, type Db } from '../src/db/client.js';
import { perSessionRateLimit } from '../src/http/rate-limits.js';
import { SESSION_COOKIE } from '../src/session/session.js';
import { PRODUCTION_ENV, resetCounters, testConfig } from './helpers.js';

let db: Db;
const apps: FastifyInstance[] = [];

beforeAll(async () => {
  db = await createDb(testConfig());
});

afterAll(async () => {
  await db.close();
});

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  await resetCounters(db); // the counters are rows of the database these tests share
});

async function makeApp(config: Config = testConfig()): Promise<FastifyInstance> {
  const app = await buildApp(config, { db });
  apps.push(app);
  return app;
}

/** A client: its own cookie jar, all requests from the same IP (inject always comes from 127.0.0.1). */
function client(app: FastifyInstance) {
  let cookie: string | undefined;
  return {
    /** The session cookie the app gave this client. */
    cookie: (): string => cookie ?? '',
    async get(url: string): Promise<LightMyRequestResponse> {
      const response = await app.inject({
        url,
        ...(cookie ? { cookies: { [SESSION_COOKIE]: cookie } } : {}),
      });
      cookie = response.cookies[0]?.value ?? cookie;
      return response;
    },
  };
}

describe('perSessionRateLimit', () => {
  it('gives two clients with distinct sessions independent buckets', async () => {
    const app = await makeApp();
    app.get(
      '/api/_questions',
      { preHandler: [perSessionRateLimit(app, { name: 'test-questions', max: 2, timeWindow: '1 minute' })] },
      () => ({
        ok: true,
      }),
    );
    const alice = client(app);
    const bob = client(app);
    const statuses = [
      (await alice.get('/api/_questions')).statusCode,
      (await alice.get('/api/_questions')).statusCode,
      (await alice.get('/api/_questions')).statusCode, // Alice is over her budget
      (await bob.get('/api/_questions')).statusCode, // Bob's budget is untouched
      (await bob.get('/api/_questions')).statusCode,
      (await bob.get('/api/_questions')).statusCode,
      (await alice.get('/api/_questions')).statusCode,
    ];
    expect(statuses).toEqual([200, 200, 429, 200, 200, 429, 429]);
  });

  it('answers 429 RATE_LIMITED in the contract shape, with Retry-After', async () => {
    const app = await makeApp();
    app.get(
      '/api/_one',
      { preHandler: [perSessionRateLimit(app, { name: 'one', max: 1, timeWindow: '1 minute' })] },
      () => ({ ok: true }),
    );
    const visitor = client(app);
    await visitor.get('/api/_one');
    const rejected = await visitor.get('/api/_one');
    expect(rejected.statusCode).toBe(429);
    expect(ApiErrorSchema.parse(rejected.json()).error.code).toBe('RATE_LIMITED');
    expect(Number(rejected.headers['retry-after'])).toBeGreaterThan(0);
  });

  it('keeps separately named limits apart, even for one session', async () => {
    const app = await makeApp();
    app.get(
      '/api/_uploads',
      { preHandler: [perSessionRateLimit(app, { name: 'test-uploads', max: 1, timeWindow: '1 hour' })] },
      () => ({ ok: true }),
    );
    app.get(
      '/api/_questions',
      { preHandler: [perSessionRateLimit(app, { name: 'test-questions', max: 1, timeWindow: '1 minute' })] },
      () => ({ ok: true }),
    );
    const visitor = client(app);
    const statuses = [
      (await visitor.get('/api/_uploads')).statusCode,
      (await visitor.get('/api/_uploads')).statusCode,
      (await visitor.get('/api/_questions')).statusCode,
      (await visitor.get('/api/_questions')).statusCode,
    ];
    expect(statuses).toEqual([200, 429, 200, 429]);
  });

  it('shares one budget between routes that use the same name (the limiter is created once per app and name)', async () => {
    const app = await makeApp();
    for (const route of ['/api/_first', '/api/_second']) {
      app.get(
        route,
        { preHandler: [perSessionRateLimit(app, { name: 'shared', max: 1, timeWindow: '1 minute' })] },
        () => ({
          ok: true,
        }),
      );
    }
    const visitor = client(app);
    expect([
      (await visitor.get('/api/_first')).statusCode,
      (await visitor.get('/api/_second')).statusCode, // same name on another route: the budget is spent
      (await visitor.get('/api/_first')).statusCode,
    ]).toEqual([200, 429, 429]);
    // Another session has its own budget on both routes.
    expect((await client(app).get('/api/_second')).statusCode).toBe(200);
  });

  it('returns the same hook for the same name and rejects a different limit under that name', async () => {
    const app = await makeApp();
    const hook = perSessionRateLimit(app, { name: 'same', max: 5, timeWindow: '1 minute' });
    expect(perSessionRateLimit(app, { name: 'same', max: 5, timeWindow: '1 minute' })).toBe(hook);
    expect(() => perSessionRateLimit(app, { name: 'same', max: 6, timeWindow: '1 minute' })).toThrow(
      /already created/u,
    );
    expect(() => perSessionRateLimit(app, { name: 'same', max: 5, timeWindow: '1 hour' })).toThrow(
      /already created/u,
    );
    // Hooks are per app: another app has its own limits under the same name.
    const otherApp = await makeApp();
    expect(perSessionRateLimit(otherApp, { name: 'same', max: 9, timeWindow: '1 minute' })).not.toBe(hook);
  });

  it('is added to the per-IP limit, not a replacement for it', async () => {
    const app = await makeApp(testConfig({ RATE_LIMIT_PER_MINUTE: '3' }));
    app.get(
      '/api/_questions',
      { preHandler: [perSessionRateLimit(app, { name: 'test-questions', max: 2, timeWindow: '1 minute' })] },
      () => ({
        ok: true,
      }),
    );
    const alice = client(app);
    const bob = client(app);
    const statuses = [
      (await alice.get('/api/_questions')).statusCode,
      (await alice.get('/api/_questions')).statusCode,
      (await bob.get('/api/_questions')).statusCode, // third request from this IP: allowed
      (await bob.get('/api/_questions')).statusCode, // Bob has budget left, but the IP does not
    ];
    expect(statuses).toEqual([200, 200, 200, 429]);
  });

  it('is shared by every instance: two apps on one database spend one budget, per session and per IP', async () => {
    const config = testConfig({ RATE_LIMIT_PER_MINUTE: '3' });
    const first = await makeApp(config);
    const second = await makeApp(config);
    for (const app of [first, second]) {
      app.get(
        '/api/_shared',
        { preHandler: [perSessionRateLimit(app, { name: 'shared-across', max: 2, timeWindow: '1 minute' })] },
        () => ({ ok: true }),
      );
    }
    const visitor = client(first);
    expect((await visitor.get('/api/_shared')).statusCode).toBe(200); // instance one
    const viaSecond = await second.inject({
      url: '/api/_shared',
      cookies: { [SESSION_COOKIE]: visitor.cookie() },
    });
    expect(viaSecond.statusCode).toBe(200); // instance two: the second request of the same session
    const third = await first.inject({
      url: '/api/_shared',
      cookies: { [SESSION_COOKIE]: visitor.cookie() },
    });
    expect(third.statusCode).toBe(429); // the session's budget of 2 is spent, whichever instance answers
    // The address is spent too: three requests of 3 a minute, over both instances.
    const fourth = await second.inject({
      url: '/api/_shared',
      cookies: { [SESSION_COOKIE]: visitor.cookie() },
    });
    expect(fourth.statusCode).toBe(429);
  });

  it('counts a request that a limit refuses nowhere else: the window ends when it would have, not later', async () => {
    const app = await makeApp(testConfig({ RATE_LIMIT_PER_MINUTE: '2' }));
    app.get('/api/_window', { config: { public: true } }, () => ({ ok: true }));
    const statuses: number[] = [];
    for (let i = 0; i < 6; i += 1) statuses.push((await app.inject('/api/_window')).statusCode);
    expect(statuses).toEqual([200, 200, 429, 429, 429, 429]);
    const used = await db.query<{ count: number }>("SELECT count FROM rate_counters WHERE key LIKE 'ip:%'");
    expect(used.rows.map((row) => row.count)).toEqual([2]); // the four refusals added nothing
  });

  it('keeps the health check out of the limit (a platform polls it)', async () => {
    const app = await makeApp(testConfig({ RATE_LIMIT_PER_MINUTE: '1' }));
    for (let i = 0; i < 4; i += 1) expect((await app.inject('/api/health')).statusCode).toBe(200);
  });

  it('reads the address from X-Forwarded-For when the proxy is trusted, and from the socket when it is not', async () => {
    const trusting = await makeApp(testConfig({ RATE_LIMIT_PER_MINUTE: '1', TRUST_PROXY: 'true' }));
    trusting.get('/api/_ip', { config: { public: true } }, () => ({ ok: true }));
    const from = (ip: string) => trusting.inject({ url: '/api/_ip', headers: { 'x-forwarded-for': ip } });
    expect([(await from('198.51.100.1')).statusCode, (await from('198.51.100.2')).statusCode]).toEqual([
      200, 200,
    ]);
    expect((await from('198.51.100.1')).statusCode).toBe(429);

    await resetCounters(db);
    const direct = await makeApp(testConfig({ RATE_LIMIT_PER_MINUTE: '1', TRUST_PROXY: 'false' }));
    direct.get('/api/_ip', { config: { public: true } }, () => ({ ok: true }));
    const spoofed = (ip: string) => direct.inject({ url: '/api/_ip', headers: { 'x-forwarded-for': ip } });
    expect([(await spoofed('198.51.100.1')).statusCode, (await spoofed('198.51.100.2')).statusCode]).toEqual([
      200, 429,
    ]);
  });

  it('works through a percent-encoded path too', async () => {
    const app = await makeApp();
    app.get(
      '/api/_one',
      { preHandler: [perSessionRateLimit(app, { name: 'one', max: 1, timeWindow: '1 minute' })] },
      () => ({ ok: true }),
    );
    const visitor = client(app);
    expect((await visitor.get('/%61pi/_one')).statusCode).toBe(200);
    expect((await visitor.get('/api/_one')).statusCode).toBe(429);
  });

  describe('used where there is no session (the rule it pins: session-dependent logic runs in preHandler)', () => {
    it('fails loudly on a public route instead of sharing one bucket for everyone', async () => {
      const app = await makeApp();
      app.get(
        '/api/_public',
        {
          config: { public: true },
          preHandler: [perSessionRateLimit(app, { name: 'oops', max: 1, timeWindow: '1 minute' })],
        },
        () => ({ ok: true }),
      );
      const response = await app.inject('/api/_public');
      expect(response.statusCode).toBe(500);
      expect(ApiErrorSchema.parse(response.json()).error.detail).toContain('ran without a session');
    });

    it('fails loudly in onRequest, where the session does not exist yet, and leaks nothing in production', async () => {
      const app = await makeApp(testConfig(PRODUCTION_ENV));
      app.get(
        '/api/_early',
        { onRequest: [perSessionRateLimit(app, { name: 'early', max: 1, timeWindow: '1 minute' })] },
        () => ({ ok: true }),
      );
      const response = await app.inject('/api/_early');
      expect(response.statusCode).toBe(500);
      expect(ApiErrorSchema.parse(response.json()).error).toEqual({
        code: 'INTERNAL',
        message: 'The server hit an unexpected error.',
      });
    });

    it('is why a session-keyed limiter in onRequest would have shared one bucket: the session id is empty there', async () => {
      const app = await makeApp();
      const seenInOnRequest: string[] = [];
      const seenInPreHandler: string[] = [];
      app.get(
        '/api/_stages',
        {
          onRequest: (request, _reply, done) => {
            seenInOnRequest.push(request.sessionId);
            done();
          },
          preHandler: (request, _reply, done) => {
            seenInPreHandler.push(request.sessionId);
            done();
          },
        },
        () => ({ ok: true }),
      );
      await app.inject('/api/_stages');
      expect(seenInOnRequest).toEqual(['']);
      expect(seenInPreHandler[0]).toMatch(/^[0-9a-f-]{36}$/);
    });
  });
});
