import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { REPO_ROOT } from '../src/config.js';
import { createDb, type Db } from '../src/db/client.js';
import { documentsRepo } from '../src/db/repositories/documents.js';
import { ingestJobsRepo } from '../src/db/repositories/ingest-jobs.js';
import { contentSecurityPolicy } from '../src/http/security.js';
import { createHandler } from '../src/vercel.js';
import { FakeEmbeddings } from './doubles/fake-embeddings.js';
import { resetCounters, insertSession, testConfig } from './helpers.js';
import { startServer, type TestServer } from './http-helpers.js';

const CRON = 'cron-secret-cron-secret-cron-secret-0123';
const servers: TestServer[] = [];
let db: Db;

beforeAll(async () => {
  db = await createDb(testConfig());
});
afterEach(async () => {
  await Promise.all(servers.splice(0).map((started) => started.close()));
  await resetCounters(db);
});
afterAll(async () => {
  await db.close();
});

async function server(env: Record<string, string> = {}): Promise<TestServer> {
  const started = await startServer(db, testConfig(env), { embeddings: new FakeEmbeddings() });
  servers.push(started);
  return started;
}

describe('GET /api/cron/retention', () => {
  it('does not exist without a CRON_SECRET, whatever is sent', async () => {
    const started = await server();
    for (const authorization of [undefined, 'Bearer ', 'Bearer undefined', 'Bearer null', 'Bearer x']) {
      const response = await started.app.inject({
        url: '/api/cron/retention',
        ...(authorization === undefined ? {} : { headers: { authorization } }),
      });
      expect(response.statusCode, String(authorization)).toBe(401);
    }
  });

  it('refuses a missing, a wrong or a differently shaped secret, and creates no session', async () => {
    const started = await server({ CRON_SECRET: CRON });
    const before = (await db.query('SELECT 1 FROM sessions')).rowCount;
    for (const authorization of [undefined, `Bearer ${CRON}x`, `bearer ${CRON}`, CRON, 'Bearer ']) {
      const response = await started.app.inject({
        url: '/api/cron/retention',
        ...(authorization === undefined ? {} : { headers: { authorization } }),
      });
      expect(response.statusCode, String(authorization)).toBe(401);
      expect(response.cookies).toEqual([]);
    }
    expect((await db.query('SELECT 1 FROM sessions')).rowCount).toBe(before);
  });

  it('with the secret runs the retention pass, and leaves the jobs alone: parking is not its business', async () => {
    const started = await server({ CRON_SECRET: CRON });
    const sessionId = await insertSession(db);
    const parked = randomUUID();
    const stillParked = randomUUID();
    const expired = randomUUID();
    for (const id of [parked, stillParked, expired]) {
      await documentsRepo.insert(db, {
        id,
        sessionId,
        filename: 'a.pdf',
        byteSize: 1,
        sha256: 'x',
        pageCount: 1,
        storageKey: `${id}.pdf`,
        expiresAt: new Date(Date.now() + (id === expired ? -60_000 : 3_600_000)),
      });
      await ingestJobsRepo.create(db, id);
    }
    await db.query(
      `UPDATE ingest_jobs SET parked_until = now() - interval '1 minute', last_error = 'daily quota reached',
         updated_at = now() - interval '5 hours' WHERE document_id = $1`,
      [parked],
    );
    await db.query(
      `UPDATE ingest_jobs SET parked_until = now() + interval '5 hours', updated_at = now() - interval '5 hours' WHERE document_id = $1`,
      [stillParked],
    );
    await db.query(`UPDATE ingest_jobs SET updated_at = now() - interval '5 hours' WHERE document_id = $1`, [
      expired,
    ]);
    const parkedBefore = await ingestJobsRepo.find(db, parked);
    const activeBefore = await ingestJobsRepo.countActive(db, 600_000);
    expect(activeBefore).toBe(0); // nobody has touched any of the three for hours: the line is empty

    const response = await started.app.inject({
      url: '/api/cron/retention',
      headers: { authorization: `Bearer ${CRON}` },
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toMatchObject({ expiredDocuments: 1 });
    expect(response.json()).not.toHaveProperty('resumed');
    expect(await documentsRepo.findById(db, expired)).toBeNull(); // expired: removed, its job with it
    expect(await ingestJobsRepo.find(db, expired)).toBeNull();
    // The parked jobs are exactly as they were (the parking is not cleared and nothing is touched: it would make a job that
    // nobody is reading count as waiting in the line), and the line is no fuller than before.
    expect(await ingestJobsRepo.find(db, parked)).toEqual(parkedBefore);
    expect((await ingestJobsRepo.find(db, stillParked))?.parked_until).not.toBeNull();
    expect(await ingestJobsRepo.countActive(db, 600_000)).toBe(activeBefore);
    expect(response.cookies).toEqual([]); // no session for the platform's caller
  });

  it('deletes nothing in a preview that was not told it has a database and a store of its own, and works where it was told', async () => {
    const expiredRow = async (): Promise<string> => {
      const id = randomUUID();
      await documentsRepo.insert(db, {
        id,
        sessionId: await insertSession(db),
        filename: 'a.pdf',
        byteSize: 1,
        sha256: 'x',
        pageCount: 1,
        storageKey: `${id}.pdf`,
        expiresAt: new Date(Date.now() - 60_000),
      });
      return id;
    };
    const call = async (
      env: Record<string, string>,
    ): Promise<{ refused?: true; expiredDocuments: number }> => {
      const started = await server({ CRON_SECRET: CRON, ...env });
      const response = await started.app.inject({
        url: '/api/cron/retention',
        headers: { authorization: `Bearer ${CRON}` },
      });
      expect(response.statusCode, response.body).toBe(200);
      return response.json<{ refused?: true; expiredDocuments: number }>();
    };
    const id = await expiredRow();
    // A preview (or a development environment pulled to a laptop) that might share production's database: nothing is touched.
    expect(await call({ VERCEL_ENV: 'preview' })).toMatchObject({ refused: true, expiredDocuments: 0 });
    expect(await call({ VERCEL_ENV: 'development' })).toMatchObject({ refused: true });
    expect(await documentsRepo.findById(db, id)).not.toBeNull();
    // Told that it has its own: the pass runs.
    expect(await call({ VERCEL_ENV: 'preview', ALLOW_PREVIEW_DATA: 'true' })).toMatchObject({
      expiredDocuments: 1,
    });
    expect(await documentsRepo.findById(db, id)).toBeNull();
    // Production, and a server off Vercel, always run it.
    await expiredRow();
    expect(await call({ VERCEL_ENV: 'production' })).toMatchObject({ expiredDocuments: 1 });
    await expiredRow();
    expect(await call({})).toMatchObject({ expiredDocuments: 1 });
  });

  it('is not held to the per-IP limit of the API', async () => {
    const started = await server({ CRON_SECRET: CRON, RATE_LIMIT_PER_MINUTE: '1' });
    const statuses: number[] = [];
    for (let i = 0; i < 3; i += 1) {
      statuses.push(
        (
          await started.app.inject({
            url: '/api/cron/retention',
            headers: { authorization: `Bearer ${CRON}` },
          })
        ).statusCode,
      );
    }
    expect(statuses).toEqual([200, 200, 200]);
  });

  it('also sweeps the counters of windows that are long over', async () => {
    const started = await server({ CRON_SECRET: CRON });
    await db.query(
      `INSERT INTO rate_counters (key, window_start, count) VALUES ('old', now() - interval '5 days', 3)`,
    );
    await started.app.inject({ url: '/api/cron/retention', headers: { authorization: `Bearer ${CRON}` } });
    expect((await db.query(`SELECT 1 FROM rate_counters WHERE key = 'old'`)).rowCount).toBe(0);
  });
});

describe('the Vercel function handler', () => {
  let listening: Server | undefined;
  afterEach(() => {
    listening?.close();
    listening = undefined;
  });

  async function serve(handler: ReturnType<typeof createHandler>): Promise<string> {
    listening = createServer((request, response) => void handler(request, response));
    await new Promise<void>((resolve) => listening?.listen(0, '127.0.0.1', resolve));
    return `http://127.0.0.1:${String((listening.address() as AddressInfo).port)}`;
  }

  it('builds the app on the first request, once, and serves every request with it', async () => {
    let built = 0;
    const origin = await serve(
      createHandler(async () => {
        built += 1;
        return buildApp(testConfig(), { db, webDist: null });
      }),
    );
    const first = await fetch(`${origin}/api/health`);
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({ ok: true });
    expect((await fetch(`${origin}/api/health`)).status).toBe(200);
    const config = await fetch(`${origin}/api/config`);
    expect(config.status).toBe(200);
    expect(built).toBe(1);
    // The API and its errors work through it (not found is the contract's 404, not a platform page).
    const missing = await fetch(`${origin}/api/documents/${randomUUID()}`);
    expect(missing.status).toBe(404);
    expect(await missing.json()).toMatchObject({ error: { code: 'DOCUMENT_NOT_FOUND' } });
  });

  it('answers 500 without the reason when the app cannot start, and tries again on the next request', async () => {
    const reported: unknown[] = [];
    let attempts = 0;
    const origin = await serve(
      createHandler(
        () => {
          attempts += 1;
          return attempts === 1
            ? Promise.reject(new Error('DATABASE_URL: password authentication failed for user "x"'))
            : buildApp(testConfig(), { db, webDist: null });
        },
        (error) => reported.push(error),
      ),
    );
    const failed = await fetch(`${origin}/api/health`);
    expect(failed.status).toBe(500);
    const body = JSON.stringify(await failed.json());
    expect(body).not.toContain('password');
    expect(body).toContain('INTERNAL');
    expect(reported).toHaveLength(1);
    expect((await fetch(`${origin}/api/health`)).status).toBe(200); // the next request starts it again
    expect(attempts).toBe(2);
  });

  it('starts only one app for requests that arrive together', async () => {
    let built = 0;
    const origin = await serve(
      createHandler(async () => {
        built += 1;
        await new Promise((resolve) => setTimeout(resolve, 100));
        return buildApp(testConfig(), { db, webDist: null });
      }),
    );
    const responses = await Promise.all(Array.from({ length: 5 }, () => fetch(`${origin}/api/health`)));
    expect(responses.map((response) => response.status)).toEqual([200, 200, 200, 200, 200]);
    expect(built).toBe(1);
  });
});

/**
 * What Vercel does with the `rewrites` of vercel.json for a path that is not a file: the first whose source matches the whole
 * path (a path-to-regexp pattern; the sources here are plain regular expressions with groups, which is all that is needed to
 * decide which of them matches) sends it to its destination. A path no rewrite names is left alone (a 404 unless the file-system
 * routing has something for it).
 */
function rewritten(rewrites: { source: string; destination: string }[], pathname: string): string | null {
  for (const rewrite of rewrites) {
    if (new RegExp(`^${rewrite.source}$`, 'u').test(pathname)) return rewrite.destination;
  }
  return null;
}

describe('vercel.json', () => {
  const config = JSON.parse(readFileSync(path.join(REPO_ROOT, 'vercel.json'), 'utf8')) as {
    buildCommand: string;
    outputDirectory: string;
    functions: Record<string, { maxDuration: number; includeFiles: string; excludeFiles: string }>;
    rewrites: { source: string; destination: string }[];
    headers: { source: string; headers: { key: string; value: string }[] }[];
    crons: { path: string; schedule: string }[];
  };
  const manifest = JSON.parse(readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8')) as {
    scripts: Record<string, string>;
    engines: { node: string };
  };

  it('builds shared, server and web, checks the function, and only then migrates, and serves the web build', () => {
    expect(config.buildCommand).toBe('npm run vercel-build');
    // The order matters: a function that would not deploy (too big, a missing file) must not migrate the database first.
    expect(manifest.scripts['vercel-build']).toBe(
      'npm run build && npm run check:vercel && npm run db:migrate:build -w @enchanted/server',
    );
    expect(manifest.scripts.build).toBe(
      'npm run build -w @enchanted/shared && npm run build -w @enchanted/server && npm run build -w @enchanted/web',
    );
    expect(config.outputDirectory).toBe('apps/web/dist');
  });

  it('pins the Node version to the 22 line (a range that reaches 24 overrides the project setting and selects it)', () => {
    expect(manifest.engines.node).toBe('22.x');
  });

  it('gives the one function the Hobby maximum, the files that no import leads to, and none of the local-model packages', () => {
    const entries = Object.entries(config.functions);
    expect(entries.map(([pattern]) => pattern)).toEqual(['api/**/*.ts']);
    const fn = entries[0]?.[1];
    expect(fn?.maxDuration).toBe(300);
    for (const needed of [
      'ingest/worker',
      'db/migrations',
      'pdfjs-dist/{cmaps,standard_fonts',
      'pdfjs-dist/legacy/build',
      '@napi-rs/',
    ]) {
      expect(fn?.includeFiles, needed).toContain(needed);
    }
    for (const unwanted of [
      'tesseract.js/',
      'tesseract.js-core',
      '@tesseract.js-data',
      '@electric-sql',
      '@huggingface',
      'onnxruntime',
    ]) {
      expect(fn?.excludeFiles, unwanted).toContain(unwanted);
    }
  });

  it('ships the function as api/index.ts: outside Next.js a [...path] file matches ONE path segment, so it cannot be the entry', () => {
    expect(existsSync(path.join(REPO_ROOT, 'api/index.ts'))).toBe(true);
    expect(existsSync(path.join(REPO_ROOT, 'api/[...path].ts'))).toBe(false);
    expect(readFileSync(path.join(REPO_ROOT, 'api/index.ts'), 'utf8')).toContain(
      "export { default } from '@enchanted/server/vercel';",
    );
  });

  it('sends every /api path, however many segments, to the function, and everything else that is not a file to the SPA shell', () => {
    const route = (pathname: string): string | null => rewritten(config.rewrites, pathname);
    const apiPaths = [
      '/api/health',
      '/api/config',
      '/api/session/document',
      '/api/session/reset',
      '/api/uploads/ticket',
      '/api/uploads/blob',
      `/api/documents/${randomUUID()}/progress`,
      `/api/documents/${randomUUID()}/tick`,
      `/api/documents/${randomUUID()}/file`,
      `/api/documents/${randomUUID()}/conversation`,
      '/api/cron/retention',
      '/api/nope',
      '/api/a/b/c/d',
    ];
    for (const pathname of apiPaths) expect(route(pathname), pathname).toBe('/api');
    // The function itself is /api (the file api/index.ts): the bare path is no rewrite, and never the shell.
    expect(route('/api')).toBeNull();
    // The app's own routes and its entry are the shell; a missing hashed asset is a 404, not the shell (it would be served as
    // HTML, cached for a year as immutable, and refused by nosniff).
    for (const pathname of ['/', '/some/route', '/read/the/book', '/index.html']) {
      expect(route(pathname), pathname).toBe('/index.html');
    }
    for (const pathname of ['/assets/index-3f2a.js', '/assets/missing-chunk.mjs', '/assets/a/b.css']) {
      expect(route(pathname), pathname).toBeNull();
    }
    // /apiary is not the API.
    expect(route('/apiary/page')).toBe('/index.html');
  });

  it('puts the security headers on the static responses (the function’s own carry theirs), with the policy that allows the Blob upload endpoint', () => {
    const statics = config.headers.find((entry) => entry.source === '/((?!api(?:/|$)).*)');
    const byKey = Object.fromEntries((statics?.headers ?? []).map((header) => [header.key, header.value]));
    expect(byKey).toEqual({
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'same-origin',
      'X-Frame-Options': 'DENY',
      'Content-Security-Policy': contentSecurityPolicy({ blob: true }),
    });
    expect(byKey['Content-Security-Policy']).toContain("connect-src 'self' https://vercel.com/api/blob/;");
    expect(byKey['Content-Security-Policy']).not.toContain('blob.vercel-storage.com');
    // The header rule leaves the function alone, and the bare /api too.
    const rule = new RegExp(`^${statics?.source ?? ''}$`, 'u');
    expect(rule.test('/api')).toBe(false);
    expect(rule.test('/api/health')).toBe(false);
    expect(rule.test('/some/route')).toBe(true);
    expect(config.headers.find((entry) => entry.source === '/assets/(.*)')?.headers).toEqual([
      { key: 'Cache-Control', value: 'public, max-age=31536000, immutable' },
    ]);
  });

  it('runs the cron once a day, for the retention pass, at a time after the quotas have started again (midnight Pacific is 07:00 or 08:00 UTC)', () => {
    expect(config.crons).toEqual([{ path: '/api/cron/retention', schedule: '0 9 * * *' }]);
  });
});

describe('the policy of the server with a Blob store', () => {
  it('allows the store and nothing else more than without it', () => {
    const plain = contentSecurityPolicy();
    const withBlob = contentSecurityPolicy({ blob: true });
    expect(plain).toContain("connect-src 'self';");
    expect(withBlob.replace(' https://vercel.com/api/blob/', '')).toBe(plain);
  });

  it('is what a server in Blob mode sends, and only that one', async () => {
    const blob = await buildApp(
      testConfig({
        NODE_ENV: 'production',
        SESSION_SECRET: 'x'.repeat(40),
        STORAGE_PROVIDER: 'vercel-blob',
        BLOB_READ_WRITE_TOKEN: 't',
      }),
      {
        db,
        webDist: null,
        ingestion: { embeddings: new FakeEmbeddings() },
      },
    );
    const local = await buildApp(testConfig({ NODE_ENV: 'production', SESSION_SECRET: 'x'.repeat(40) }), {
      db,
      webDist: null,
      ingestion: { embeddings: new FakeEmbeddings() },
    });
    try {
      expect((await blob.inject('/api/config')).headers['content-security-policy']).toBe(
        contentSecurityPolicy({ blob: true }),
      );
      expect((await local.inject('/api/config')).headers['content-security-policy']).toBe(
        contentSecurityPolicy(),
      );
    } finally {
      await blob.close();
      await local.close();
    }
  });
});
