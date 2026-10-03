import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { UploadTicketSchema } from '@enchanted/shared';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createDb, type Db } from '../src/db/client.js';
import { contentSecurityPolicy } from '../src/http/security.js';
import { FakeBlobStore } from './doubles/fake-blob.js';
import { readFixture } from './fixtures.js';
import { testConfig } from './helpers.js';
import { startServer, type TestServer } from './http-helpers.js';
import { VercelBlobStorage } from '../src/storage/vercel-blob.js';

/*
 * The page's Content-Security-Policy against what the installed `@vercel/blob` client REALLY does. The browser half of the SDK
 * sends every upload request to `https://vercel.com/api/blob` (not to the store's own host): a policy that names the store makes
 * every upload fail in the browser, and the client retries for about 17 minutes before it says so. Nothing in development or in
 * the tests that use fakes would notice, so this test runs the real client (`upload` of `@vercel/blob/client`) against the real
 * token route of the server (with the SDK's own `handleUpload`), puts the network in the way (undici's MockAgent, with the
 * network switched off) and holds every request it makes against the policy the server sends.
 */

let db: Db;
const servers: TestServer[] = [];
beforeAll(async () => {
  db = await createDb(testConfig());
});
afterEach(async () => {
  await Promise.all(servers.splice(0).map((started) => started.close()));
});
afterAll(async () => {
  await db.close();
});

/** Whether a CSP `connect-src` list allows a request to `url` (the matching of CSP source expressions: scheme, host, path). */
function connectSrcAllows(policy: string, url: string): boolean {
  const directive = policy
    .split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith('connect-src '));
  if (directive === undefined) return false;
  const target = new URL(url);
  return directive
    .split(/\s+/u)
    .slice(1)
    .some((source) => {
      if (source.startsWith("'")) return false; // 'self': the page's own origin, which is not the Blob endpoint
      let expression: URL;
      try {
        expression = new URL(source.replace('*.', 'wildcard.'));
      } catch {
        return false;
      }
      const wildcard = source.includes('://*.');
      const host = wildcard
        ? target.hostname.endsWith(`.${expression.hostname.replace(/^wildcard\./u, '')}`)
        : target.hostname === expression.hostname;
      if (expression.protocol !== target.protocol || !host) return false;
      const path = expression.pathname;
      if (path === '/' && !source.endsWith('/')) return true; // no path in the source: any path
      if (source.endsWith('/')) return target.pathname.startsWith(path); // a path that ends in "/" matches by prefix
      return target.pathname === path; // otherwise exactly
    });
}

describe('connectSrcAllows (the matcher this test holds the policy to)', () => {
  const policy = "default-src 'self'; connect-src 'self' https://vercel.com/api/blob/; img-src 'self'";
  it('follows the CSP rules for a source with a path that ends in a slash, and refuses everything else', () => {
    expect(connectSrcAllows(policy, 'https://vercel.com/api/blob/?pathname=a.pdf')).toBe(true);
    expect(connectSrcAllows(policy, 'https://vercel.com/api/blob/mpu?pathname=a.pdf')).toBe(true);
    expect(connectSrcAllows(policy, 'https://vercel.com/api/blob')).toBe(false); // no trailing slash: not under the prefix
    expect(connectSrcAllows(policy, 'https://vercel.com/api/other')).toBe(false);
    expect(connectSrcAllows(policy, 'https://vercel.com/')).toBe(false);
    expect(connectSrcAllows(policy, 'http://vercel.com/api/blob/')).toBe(false);
    expect(connectSrcAllows(policy, 'https://abc123.private.blob.vercel-storage.com/a.pdf')).toBe(false);
    expect(
      connectSrcAllows(
        'connect-src https://*.blob.vercel-storage.com',
        'https://abc123.private.blob.vercel-storage.com/a.pdf',
      ),
    ).toBe(true);
    expect(
      connectSrcAllows('connect-src https://*.blob.vercel-storage.com', 'https://vercel.com/api/blob/'),
    ).toBe(false);
  });
});

describe('the policy of a server with a Blob store', () => {
  it('allows every request the installed Blob client makes to upload a file, and nothing it did not need', async () => {
    const store = new FakeBlobStore();
    const started = await startServer(
      db,
      testConfig({
        NODE_ENV: 'production',
        SESSION_SECRET: 'csp-test-secret-csp-test-secret-0123456789',
        STORAGE_PROVIDER: 'vercel-blob',
        // Shaped like a read-write token, so that the real handleUpload can sign a client token with it. Not a real one.
        BLOB_READ_WRITE_TOKEN: 'vercel_blob_rw_teststore_notarealsecret0123456789',
      }),
      {
        deps: {
          ingestion: {
            storage: new VercelBlobStorage({ client: store.client, token: 'vercel_blob_rw_test' }),
          },
        },
      },
    );
    servers.push(started);
    const client = started.client();
    const ticket = UploadTicketSchema.parse((await client.request('POST', '/api/uploads/ticket')).json());
    if (ticket.mode !== 'blob') throw new Error('not a blob ticket');
    const policy = String((await client.get('/api/config')).headers['content-security-policy']);
    expect(policy).toBe(contentSecurityPolicy({ blob: true }));

    // The real client, in this process. Its request for a token is answered with what the real token route of the server (with
    // the SDK's own handleUpload) says to the same request; its upload goes through the SDK's own HTTP client (the undici the SDK
    // depends on), which the mock agent stands in front of, with the network switched off.
    const tokenResponse = await client.postJson('/api/uploads/blob', {
      type: 'blob.generate-client-token',
      payload: { pathname: ticket.pathname, clientPayload: ticket.clientPayload, multipart: false },
    });
    expect(tokenResponse.statusCode, tokenResponse.body).toBe(200);
    const sdkRequire = createRequire(createRequire(import.meta.url).resolve('@vercel/blob'));
    const { MockAgent, getGlobalDispatcher, setGlobalDispatcher } = sdkRequire('undici') as {
      MockAgent: new () => {
        disableNetConnect(): void;
        get(origin: string): {
          intercept(options: { path: (path: string) => boolean; method: string }): {
            reply(
              callback: (options: { path: string; method: string }) => {
                statusCode: number;
                data: string;
                responseOptions: { headers: Record<string, string> };
              },
            ): { persist(): unknown };
          };
        };
        close(): Promise<void>;
      };
      getGlobalDispatcher(): unknown;
      setGlobalDispatcher(dispatcher: unknown): void;
    };
    const seen: { origin: string; method: string; path: string }[] = [];
    const agent = new MockAgent();
    agent.disableNetConnect();
    agent
      .get('http://diary.test')
      .intercept({ path: () => true, method: 'POST' })
      .reply(() => ({
        statusCode: tokenResponse.statusCode,
        data: tokenResponse.body,
        responseOptions: { headers: { 'content-type': 'application/json' } },
      }))
      .persist();
    const previous = getGlobalDispatcher();
    setGlobalDispatcher(agent);
    try {
      for (const [origin, method] of [
        ['https://vercel.com', 'PUT'],
        ['https://vercel.com', 'POST'],
      ] as const) {
        agent
          .get(origin)
          .intercept({ path: () => true, method })
          .reply((options) => {
            seen.push({ origin, method: options.method, path: options.path });
            return {
              statusCode: 200,
              data: JSON.stringify({
                url: `https://teststore.private.blob.vercel-storage.com/${ticket.pathname}`,
                downloadUrl: `https://teststore.private.blob.vercel-storage.com/${ticket.pathname}?download=1`,
                pathname: ticket.pathname,
                contentType: 'application/pdf',
                contentDisposition: 'inline',
                etag: 'e',
              }),
              responseOptions: { headers: { 'content-type': 'application/json' } },
            };
          })
          .persist();
      }
      const { upload } = await import('@vercel/blob/client');
      const bytes = await readFixture('text-en.pdf');
      await upload(ticket.pathname, new Blob([new Uint8Array(bytes)], { type: 'application/pdf' }), {
        access: 'private',
        handleUploadUrl: `http://diary.test${ticket.handleUploadUrl}`,
        clientPayload: ticket.clientPayload,
        multipart: false,
      });
    } finally {
      setGlobalDispatcher(previous);
      await agent.close();
    }

    // What the client did: one request, to vercel.com/api/blob (and nowhere else: the network was off).
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.map((request) => request.origin)).toEqual(seen.map(() => 'https://vercel.com'));
    expect(seen[0]).toMatchObject({ method: 'PUT' });
    expect(seen[0]?.path).toMatch(/^\/api\/blob\/\?pathname=/u);
    for (const request of seen) {
      expect(
        connectSrcAllows(policy, `${request.origin}${request.path}`),
        `${request.method} ${request.path}`,
      ).toBe(true);
    }
    // The multipart calls of the same client (create, part, complete) go to /mpu under the same prefix.
    for (const path of ['/api/blob/mpu?pathname=a.pdf', '/api/blob/?pathname=a.pdf']) {
      expect(connectSrcAllows(policy, `https://vercel.com${path}`), path).toBe(true);
    }
    // And the store's own host, which nothing in the browser needs (the server reads blobs with the token), is not allowed.
    expect(
      connectSrcAllows(policy, `https://teststore.private.blob.vercel-storage.com/${randomUUID()}.pdf`),
    ).toBe(false);
    expect(policy).not.toContain('vercel-storage.com');
  }, 60_000);
});
