import { randomUUID } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { UploadTicketSchema, type UploadTicket } from '@enchanted/shared';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createDb, type Db } from '../src/db/client.js';
import { documentsRepo } from '../src/db/repositories/documents.js';
import { ingestJobsRepo } from '../src/db/repositories/ingest-jobs.js';
import { uploadTicketsRepo } from '../src/db/repositories/upload-tickets.js';
import { INGEST_CACHE_DIRECTORY } from '../src/ingest/bytes.js';
import { BUSY_RETRY_AFTER_SECONDS } from '../src/http/accept-upload.js';
import {
  CLIENT_TOKEN_TTL_MS,
  createDocumentFromBlob,
  signTicket,
  ticketSubject,
  type HandleUpload,
} from '../src/http/uploads.js';
import { UPLOAD_SCRATCH_DIRECTORY } from '../src/storage/retention.js';
import { VercelBlobStorage } from '../src/storage/vercel-blob.js';
import { FakeBlobStore } from './doubles/fake-blob.js';
import { readFixture } from './fixtures.js';
import { resetCounters, testConfig } from './helpers.js';
import {
  errorOf,
  sessionOf,
  startServer,
  summaryOf,
  tickUntilDone,
  type Client,
  type TestServer,
} from './http-helpers.js';

/*
 * Uploads that do not go through the function: the ticket, the token route (with a stand-in for the Blob SDK's handleUpload,
 * and once with the real one), and the document made from the blob the browser uploaded, which takes a ticket that is good for
 * ONE document. The Blob store is a private in-memory stand-in.
 */

const SECRET = 'upload-test-secret-upload-test-secret-0123456789';
/** Shaped like a read-write token (`vercel_blob_rw_<store id>_<secret>`) so that the real SDK can sign a client token with it. */
const FAKE_RW_TOKEN = 'vercel_blob_rw_teststore_notarealsecret0123456789';

let db: Db;
const servers: TestServer[] = [];

beforeAll(async () => {
  db = await createDb(testConfig());
});
afterEach(async () => {
  await Promise.all(servers.splice(0).map((started) => started.close()));
  await resetCounters(db);
  // The line of documents is the database's: what one test left reading must not fill it for the next.
  await db.query('DELETE FROM documents');
  await db.query('DELETE FROM upload_tickets');
});
afterAll(async () => {
  await db.close();
});

interface TokenRequest {
  pathname: string;
  clientPayload: string | null;
  multipart: boolean;
  options: Awaited<ReturnType<Parameters<HandleUpload>[0]['onBeforeGenerateToken']>> | { refused: string };
  requestHasHeaders: boolean;
  token: string | undefined;
}

interface BlobServer {
  started: TestServer;
  store: FakeBlobStore;
  tokenRequests: TokenRequest[];
}

/** A server in Blob mode: the storage is the Blob provider over the fake store, and handleUpload behaves like the SDK's. */
async function blobServer(
  env: Record<string, string> = {},
  options: { realHandleUpload?: boolean } = {},
): Promise<BlobServer> {
  const store = new FakeBlobStore();
  const tokenRequests: TokenRequest[] = [];
  const handleUpload: HandleUpload = async (request) => {
    const { pathname, clientPayload, multipart } = (
      request.body as { payload: { pathname: string; clientPayload: string | null; multipart: boolean } }
    ).payload;
    const entry: TokenRequest = {
      pathname,
      clientPayload,
      multipart,
      options: { refused: '' },
      requestHasHeaders: typeof request.request.headers === 'object',
      token: request.token,
    };
    tokenRequests.push(entry);
    try {
      entry.options = await request.onBeforeGenerateToken(pathname, clientPayload, multipart);
    } catch (error) {
      entry.options = { refused: error instanceof Error ? error.message : 'refused' };
      throw error;
    }
    return { type: 'blob.generate-client-token', clientToken: 'fake-client-token' };
  };
  const started = await startServer(
    db,
    testConfig({
      STORAGE_PROVIDER: 'vercel-blob',
      BLOB_READ_WRITE_TOKEN: options.realHandleUpload === true ? FAKE_RW_TOKEN : 'vercel_blob_rw_test',
      SESSION_SECRET: SECRET,
      ...env,
    }),
    {
      deps: {
        ingestion: { storage: new VercelBlobStorage({ client: store.client, token: 'vercel_blob_rw_test' }) },
        ...(options.realHandleUpload === true ? {} : { handleUpload }),
      },
    },
  );
  servers.push(started);
  return { started, store, tokenRequests };
}

async function ticketOf(client: Client): Promise<Extract<UploadTicket, { mode: 'blob' }>> {
  const response = await client.request('POST', '/api/uploads/ticket');
  expect(response.statusCode, response.body).toBe(200);
  const ticket = UploadTicketSchema.parse(response.json());
  if (ticket.mode !== 'blob') throw new Error('not a blob ticket');
  return ticket;
}

type Ticket = Awaited<ReturnType<typeof ticketOf>>;

/** `POST /api/documents` the way the web app makes the document of an upload: the pathname and the ticket that came with it. */
const createFrom = (client: Client, ticket: Ticket, extra: Record<string, unknown> = {}) =>
  client.postJson('/api/documents', {
    blobPathname: ticket.pathname,
    ticket: ticket.clientPayload,
    ...extra,
  });

const tokenBody = (ticket: {
  pathname: string;
  clientPayload: string;
}): { type: string; payload: object } => ({
  type: 'blob.generate-client-token',
  payload: { pathname: ticket.pathname, multipart: false, clientPayload: ticket.clientPayload },
});

/** What the page can read out of a ticket: its payload (the part before the dot). */
const readableBy = (ticket: Ticket): string =>
  Buffer.from(ticket.clientPayload.split('.')[0] ?? '', 'base64url').toString('utf8');

describe('POST /api/uploads/ticket', () => {
  it('says "direct" when files go to this server (development, tests)', async () => {
    const started = await startServer(db, testConfig());
    servers.push(started);
    const response = await started.client().request('POST', '/api/uploads/ticket');
    expect(response.statusCode).toBe(200);
    expect(UploadTicketSchema.parse(response.json())).toEqual({
      mode: 'direct',
      maxBytes: started.config.maxUploadBytes,
    });
    expect(response.headers['cache-control']).toBe('no-store');
  });

  it('in Blob mode names the blob (a uuid and .pdf), the token route and the limit, signs it for the session and records it', async () => {
    const { started } = await blobServer({ MAX_UPLOAD_MB: '7' });
    const client = started.client();
    const ticket = await ticketOf(client);
    expect(ticket).toMatchObject({
      mode: 'blob',
      maxBytes: 7 * 1024 * 1024,
      handleUploadUrl: '/api/uploads/blob',
    });
    expect(ticket.pathname).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.pdf$/);
    expect(ticket.clientPayload.split('.')).toHaveLength(2);
    expect(new Set([(await ticketOf(started.client())).pathname, ticket.pathname]).size).toBe(2); // fresh each time
    // The server's own record of it: this session's, open, for as many bytes as the limit.
    expect(await uploadTicketsRepo.find(db, ticket.pathname)).toMatchObject({
      session_id: await sessionOf(client),
      max_bytes: 7 * 1024 * 1024,
      claimed_at: null,
      document_id: null,
    });
  });

  it('does not show the page the id of its session', async () => {
    const { started } = await blobServer();
    const client = started.client();
    const ticket = await ticketOf(client);
    const sid = await sessionOf(client);
    expect(readableBy(ticket)).not.toContain(sid);
    expect(ticket.clientPayload).not.toContain(sid);
    const ticketExpiry = (JSON.parse(readableBy(ticket)) as { exp: number }).exp;
    expect(ticketExpiry).toBeGreaterThan(Date.now());
    expect(JSON.parse(readableBy(ticket))).toEqual({
      sub: ticketSubject(SECRET, sid),
      pathname: ticket.pathname,
      exp: ticketExpiry,
    });
  });

  it('counts as an upload against the per-session limit (Blob mode), and the archive being busy refuses it', async () => {
    const limited = await blobServer({ UPLOADS_PER_HOUR: '1' });
    const client = limited.started.client();
    expect((await client.request('POST', '/api/uploads/ticket')).statusCode).toBe(200);
    const refused = await client.request('POST', '/api/uploads/ticket');
    expect(refused.statusCode).toBe(429);
    expect(errorOf(refused).code).toBe('RATE_LIMITED');
    expect((await limited.started.client().request('POST', '/api/uploads/ticket')).statusCode).toBe(200);

    await resetCounters(db);
    const busy = await blobServer({ MAX_QUEUED_JOBS: '1', INGEST_CONCURRENCY: '1' });
    for (let i = 0; i < 2; i += 1) {
      const other = busy.started.client();
      const ticket = await ticketOf(other);
      busy.store.upload(ticket.pathname, await readFixture('text-en.pdf'));
      expect((await createFrom(other, ticket)).statusCode).toBe(202);
    }
    const full = await busy.started.client().request('POST', '/api/uploads/ticket');
    expect(full.statusCode).toBe(429);
    expect(errorOf(full).message).toContain('busy');
  }, 60_000);

  it('counts per address too: two sessions on one address share the limit of that address', async () => {
    const { started } = await blobServer({ UPLOADS_PER_HOUR_PER_IP: '1' });
    expect((await started.client().request('POST', '/api/uploads/ticket')).statusCode).toBe(200);
    const second = await started.client().request('POST', '/api/uploads/ticket'); // another session, the same address
    expect(second.statusCode).toBe(429);
    expect(errorOf(second).code).toBe('RATE_LIMITED');
  });
});

describe('the budgets of the Blob store', () => {
  it('refuses a ticket when the bytes the open tickets may bring would pass BLOB_MAX_TOTAL_MB, and counts a used ticket by what the file weighs', async () => {
    const { started, store } = await blobServer({ MAX_UPLOAD_MB: '1', BLOB_MAX_TOTAL_MB: '2' });
    const client = started.client();
    const first = await ticketOf(client);
    const second = await ticketOf(started.client()); // two megabytes are promised now
    const refused = await started.client().request('POST', '/api/uploads/ticket');
    expect(refused.statusCode).toBe(429);
    expect(errorOf(refused).code).toBe('RATE_LIMITED');
    expect(errorOf(refused).message).toContain('full');
    expect(await uploadTicketsRepo.openBytes(db)).toBe(2 * 1024 * 1024);

    // The first ticket is used: its document counts by the file's own size, and the ticket keeps counting too, for as long as its
    // client token could still put a blob under the pathname again (until an hour after it expires).
    const bytes = await readFixture('text-en.pdf');
    store.upload(first.pathname, bytes);
    expect((await createFrom(client, first)).statusCode).toBe(202);
    expect(await uploadTicketsRepo.openBytes(db)).toBe(2 * 1024 * 1024);
    expect(await documentsRepo.totalBytes(db)).toBe(bytes.length);
    expect((await started.client().request('POST', '/api/uploads/ticket')).statusCode).toBe(429);

    // Both tickets are long over (one made a document, the other nobody used): they are settled with the next request, and
    // only the document's own bytes count any more.
    await db.query(
      `UPDATE upload_tickets SET expires_at = now() - interval '2 hours' WHERE pathname = ANY($1)`,
      [[first.pathname, second.pathname]],
    );
    expect((await started.client().request('POST', '/api/uploads/ticket')).statusCode).toBe(200);
    expect(store.blobs.has(first.pathname)).toBe(true); // a document's file is never touched by settling its ticket
  }, 60_000);

  it('charges a ticket two write operations (its put, and the one put more its client token can still make), and refuses when the day’s are used up', async () => {
    const { started } = await blobServer({ BLOB_MAX_WRITES_PER_DAY: '4' });
    expect((await started.client().request('POST', '/api/uploads/ticket')).statusCode).toBe(200);
    expect((await started.client().request('POST', '/api/uploads/ticket')).statusCode).toBe(200);
    const refused = await started.client().request('POST', '/api/uploads/ticket');
    expect(refused.statusCode).toBe(429);
    expect(errorOf(refused).message).toContain('full for today');
    // A refused ticket leaves nothing behind.
    expect((await db.query('SELECT 1 FROM upload_tickets')).rowCount).toBe(2);
    // One operation of budget is less than a ticket costs: refused at once, however much is "left".
    await resetCounters(db);
    const tight = await blobServer({ BLOB_MAX_WRITES_PER_DAY: '1' });
    expect((await tight.started.client().request('POST', '/api/uploads/ticket')).statusCode).toBe(429);
  });

  it('settles a used ticket after its expiry: a blob put again under its pathname after its document was deleted is deleted, one a document has is kept', async () => {
    const { started, store } = await blobServer();
    const client = started.client();
    const ticket = await ticketOf(client);
    store.upload(ticket.pathname, await readFixture('text-en.pdf'));
    const accepted = summaryOf(await createFrom(client, ticket));
    expect((await client.delete(`/api/documents/${accepted.id}`)).statusCode).toBe(204);
    expect(store.blobs.has(ticket.pathname)).toBe(false);
    // The client token the browser still holds puts it again (the pathname is free, and the token is good for ten minutes).
    store.upload(ticket.pathname, await readFixture('text-en.pdf'));
    // The ticket is spent, and its bytes still count while the token could do this.
    expect(await uploadTicketsRepo.openBytes(db)).toBeGreaterThanOrEqual(started.config.maxUploadBytes);
    expect((await createFrom(client, ticket)).statusCode).toBe(400); // and no document can be made of it
    expect(store.blobs.has(ticket.pathname)).toBe(true); // nothing deletes it yet: the ticket has not run out
    // An hour after the ticket expired the next ticket request settles it, and the stray blob goes.
    await db.query(`UPDATE upload_tickets SET expires_at = now() - interval '2 hours' WHERE pathname = $1`, [
      ticket.pathname,
    ]);
    await ticketOf(started.client());
    expect(store.blobs.has(ticket.pathname)).toBe(false);
    expect((await uploadTicketsRepo.find(db, ticket.pathname))?.released_at).not.toBeNull();
  }, 60_000);

  it('turns the same ticket away after a few reads of the store, and a busy line before any', async () => {
    const { started, store } = await blobServer();
    const client = started.client();
    const ticket = await ticketOf(client);
    store.upload(ticket.pathname, await readFixture('text-en.pdf'));
    for (let attempt = 0; attempt < 3; attempt += 1) {
      store.failNext('head', 1); // the store does not answer each time
      expect((await createFrom(client, ticket)).statusCode).toBe(500);
    }
    const heads = store.callsTo('head').length;
    const fourth = await createFrom(client, ticket);
    expect(fourth.statusCode).toBe(429);
    expect(errorOf(fourth).message).toContain('tried too often');
    expect(store.callsTo('head')).toHaveLength(heads); // refused before the store was asked
    expect(store.blobs.has(ticket.pathname)).toBe(true);
  }, 60_000);

  it('allows a limited number of opens of one document’s file a day, reading the store once for each and never asking its size separately', async () => {
    const { started, store } = await blobServer({ FILE_READS_PER_DOC_PER_DAY: '2' });
    const client = started.client();
    const ticket = await ticketOf(client);
    const bytes = await readFixture('text-en.pdf');
    store.upload(ticket.pathname, bytes);
    const accepted = summaryOf(await createFrom(client, ticket));
    expect((await tickUntilDone(client, accepted.id)).at(-1)?.status).toBe('ready');
    const heads = store.callsTo('head').length;
    const gets = store.callsTo('get').length;
    for (let open = 1; open <= 2; open += 1) {
      const file = await client.get(`/api/documents/${accepted.id}/file`);
      expect(file.statusCode, `open ${String(open)}`).toBe(200);
      expect(file.rawPayload.equals(bytes)).toBe(true);
      expect(file.headers['content-length']).toBe(String(bytes.length));
    }
    expect(store.callsTo('get')).toHaveLength(gets + 2); // one read for each open
    expect(store.callsTo('head')).toHaveLength(heads); // and no `head`: the size is the document's own
    const third = await client.get(`/api/documents/${accepted.id}/file`);
    expect(third.statusCode).toBe(429);
    expect(errorOf(third).message).toContain('full for today');
    expect(store.callsTo('get')).toHaveLength(gets + 2); // the refusal did not touch the store
  }, 120_000);

  it('deletes the blob of a ticket nobody used once the ticket has been expired for an hour, when the next ticket is asked for', async () => {
    const { started, store } = await blobServer();
    const abandoned = await ticketOf(started.client());
    const recent = await ticketOf(started.client());
    store.upload(abandoned.pathname, await readFixture('text-en.pdf')); // uploaded, never made into a document
    store.upload(recent.pathname, await readFixture('text-en.pdf'));
    await db.query(`UPDATE upload_tickets SET expires_at = now() - interval '2 hours' WHERE pathname = $1`, [
      abandoned.pathname,
    ]);
    await db.query(
      `UPDATE upload_tickets SET expires_at = now() - interval '10 minutes' WHERE pathname = $1`,
      [recent.pathname],
    );
    await ticketOf(started.client());
    expect(store.blobs.has(abandoned.pathname)).toBe(false);
    expect(store.blobs.has(recent.pathname)).toBe(true); // still within the hour: the browser may be finishing
    expect((await uploadTicketsRepo.find(db, abandoned.pathname))?.released_at).not.toBeNull();
    expect((await uploadTicketsRepo.find(db, recent.pathname))?.released_at).toBeNull();
    // What the open tickets promise no longer counts it.
    expect(await uploadTicketsRepo.openBytes(db)).toBeLessThan(3 * started.config.maxUploadBytes);
  }, 60_000);
});

describe('POST /api/uploads/blob', () => {
  it('hands the Blob SDK a ticket-checked request: this pathname, PDFs only, MAX_UPLOAD_MB, no overwrite, no random suffix, no payload', async () => {
    const { started, tokenRequests } = await blobServer({ MAX_UPLOAD_MB: '3' });
    const client = started.client();
    const ticket = await ticketOf(client);
    const response = await client.postJson('/api/uploads/blob', tokenBody(ticket));
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toEqual({ type: 'blob.generate-client-token', clientToken: 'fake-client-token' });
    expect(response.headers['cache-control']).toBe('no-store');
    const [asked] = tokenRequests;
    expect(asked).toMatchObject({
      pathname: ticket.pathname,
      multipart: false,
      requestHasHeaders: true, // the SDK is given the node request
      token: 'vercel_blob_rw_test',
      options: {
        allowedContentTypes: ['application/pdf'],
        maximumSizeInBytes: 3 * 1024 * 1024,
        addRandomSuffix: false,
        allowOverwrite: false,
      },
    });
    const options = asked?.options as { validUntil: number; tokenPayload?: unknown };
    expect(options.validUntil).toBeGreaterThan(Date.now());
    // Minutes, not the half hour of the ticket: the token is a bearer that can put a blob again once its document is gone.
    expect(options.validUntil).toBeLessThanOrEqual(Date.now() + CLIENT_TOKEN_TTL_MS);
    expect(options.tokenPayload).toBeUndefined(); // nothing of the session goes into the token
  });

  it('refuses a token for a multipart upload (the single put the quota is counted for), with the stand-in and with the real SDK', async () => {
    for (const realHandleUpload of [false, true]) {
      const { started, tokenRequests } = await blobServer({}, { realHandleUpload });
      const client = started.client();
      const ticket = await ticketOf(client);
      const response = await client.postJson('/api/uploads/blob', {
        type: 'blob.generate-client-token',
        payload: { pathname: ticket.pathname, multipart: true, clientPayload: ticket.clientPayload },
      });
      expect([response.statusCode, errorOf(response).code], String(realHandleUpload)).toEqual([
        400,
        'FILE_MISSING',
      ]);
      expect(errorOf(response).message).toContain('multipart upload is not accepted');
      if (!realHandleUpload)
        expect(tokenRequests.every((request) => 'refused' in request.options)).toBe(true);
      // The ticket is still open for the single put it is meant for.
      expect((await client.postJson('/api/uploads/blob', tokenBody(ticket))).statusCode).toBe(200);
    }
  });

  it('puts a short life on the real client token too: ten minutes at most, whatever the ticket allows', async () => {
    const { started } = await blobServer({}, { realHandleUpload: true });
    const client = started.client();
    const ticket = await ticketOf(client);
    const response = await client.postJson('/api/uploads/blob', tokenBody(ticket));
    const { clientToken } = response.json<{ clientToken: string }>();
    const [, , , , encoded] = clientToken.split('_');
    const payload = JSON.parse(
      Buffer.from(
        Buffer.from(encoded ?? '', 'base64')
          .toString()
          .split('.')[1] ?? '',
        'base64',
      ).toString(),
    ) as { validUntil: number };
    expect(payload.validUntil).toBeGreaterThan(Date.now());
    expect(payload.validUntil).toBeLessThanOrEqual(Date.now() + CLIENT_TOKEN_TTL_MS);
  });

  it('works with the real handleUpload of the SDK: a signed client token for this blob, with nothing of the session in it', async () => {
    const { started } = await blobServer({ MAX_UPLOAD_MB: '3' }, { realHandleUpload: true });
    const client = started.client();
    const ticket = await ticketOf(client);
    const response = await client.postJson('/api/uploads/blob', tokenBody(ticket));
    expect(response.statusCode, response.body).toBe(200);
    const { type, clientToken } = response.json<{ type: string; clientToken: string }>();
    expect(type).toBe('blob.generate-client-token');
    expect(clientToken).toMatch(/^vercel_blob_client_teststore_/);
    // What the SDK signed, read the way the SDK reads it.
    const [, , , , encoded] = clientToken.split('_');
    const payload = JSON.parse(
      Buffer.from(
        Buffer.from(encoded ?? '', 'base64')
          .toString()
          .split('.')[1] ?? '',
        'base64',
      ).toString(),
    ) as Record<string, unknown>;
    expect(payload).toMatchObject({
      pathname: ticket.pathname,
      allowedContentTypes: ['application/pdf'],
      maximumSizeInBytes: 3 * 1024 * 1024,
      addRandomSuffix: false,
      allowOverwrite: false,
    });
    expect(JSON.stringify(payload)).not.toContain(await sessionOf(client));
    expect(payload).not.toHaveProperty('onUploadCompleted'); // no webhook: nothing for an unauthenticated caller to forge
    // A request the SDK would sign for somebody else's pathname never gets that far.
    const stranger = await started.client().postJson('/api/uploads/blob', tokenBody(ticket));
    expect(stranger.statusCode).toBe(400);
  });

  it('refuses a pathname the session was not given, a ticket of another session, a forged, an expired and a missing ticket', async () => {
    const { started, tokenRequests } = await blobServer();
    const alice = started.client();
    const bob = started.client();
    const aliceTicket = await ticketOf(alice);
    const bobTicket = await ticketOf(bob);
    const sub = ticketSubject(SECRET, await sessionOf(alice));
    const attempts: [string, { pathname: string; clientPayload: string | null }, Client][] = [
      [
        'a name of her own',
        { pathname: `${randomUUID()}.pdf`, clientPayload: aliceTicket.clientPayload },
        alice,
      ],
      [
        'another document key',
        { pathname: bobTicket.pathname, clientPayload: aliceTicket.clientPayload },
        alice,
      ],
      [
        "somebody else's ticket",
        { pathname: bobTicket.pathname, clientPayload: bobTicket.clientPayload },
        alice,
      ],
      [
        'a forged ticket',
        {
          pathname: aliceTicket.pathname,
          clientPayload: `${aliceTicket.clientPayload.split('.')[0] ?? ''}.AAAA`,
        },
        alice,
      ],
      [
        'a ticket signed with another secret',
        {
          pathname: aliceTicket.pathname,
          clientPayload: signTicket('another-secret-another-secret-12345', {
            sub,
            pathname: aliceTicket.pathname,
            exp: Date.now() + 60_000,
          }),
        },
        alice,
      ],
      [
        'an expired ticket',
        {
          pathname: aliceTicket.pathname,
          clientPayload: signTicket(SECRET, { sub, pathname: aliceTicket.pathname, exp: Date.now() - 1 }),
        },
        alice,
      ],
      [
        'a ticket the server never issued (properly signed, but with no record)',
        (() => {
          const pathname = `${randomUUID()}.pdf`;
          return {
            pathname,
            clientPayload: signTicket(SECRET, { sub, pathname, exp: Date.now() + 60_000 }),
          };
        })(),
        alice,
      ],
      ['no ticket', { pathname: aliceTicket.pathname, clientPayload: null }, alice],
      [
        'a path out of the store',
        { pathname: '../escape.pdf', clientPayload: aliceTicket.clientPayload },
        alice,
      ],
    ];
    for (const [what, { pathname, clientPayload }, who] of attempts) {
      const response = await who.postJson('/api/uploads/blob', {
        type: 'blob.generate-client-token',
        payload: { pathname, multipart: false, clientPayload },
      });
      expect(response.statusCode, what).toBe(400);
      expect(errorOf(response).code, what).toBe('FILE_MISSING');
    }
    expect(tokenRequests.every((request) => 'refused' in request.options)).toBe(true);
  });

  it('gives no token for a ticket that was used, or whose file was refused: the ticket is spent', async () => {
    const { started, store } = await blobServer();
    const client = started.client();
    const used = await ticketOf(client);
    store.upload(used.pathname, await readFixture('text-en.pdf'));
    summaryOf(await createFrom(client, used));
    const afterUse = await client.postJson('/api/uploads/blob', tokenBody(used));
    expect([afterUse.statusCode, errorOf(afterUse).code]).toEqual([400, 'FILE_MISSING']);

    const refused = await ticketOf(client);
    store.upload(refused.pathname, await readFixture('not-a-pdf.pdf'));
    expect((await createFrom(client, refused)).statusCode).toBe(415);
    const afterRefusal = await client.postJson('/api/uploads/blob', tokenBody(refused));
    expect([afterRefusal.statusCode, errorOf(afterRefusal).code]).toEqual([400, 'FILE_MISSING']);
  }, 60_000);

  it('answers only the request for a token: nothing else, and no other shape of body', async () => {
    const { started } = await blobServer();
    const client = started.client();
    for (const body of [
      { type: 'blob.upload-completed', payload: { blob: {}, tokenPayload: null } },
      {
        type: 'blob.generate-presigned-url',
        payload: { pathname: 'x.pdf', multipart: false, clientPayload: null },
      },
      { type: 'blob.generate-client-token' },
      'text',
      [],
    ]) {
      const response = await client.postJson('/api/uploads/blob', body);
      expect(response.statusCode, JSON.stringify(body)).toBe(400);
    }
  });

  it('is not there when the files go to this server', async () => {
    const started = await startServer(db, testConfig());
    servers.push(started);
    const response = await started.client().postJson('/api/uploads/blob', {
      type: 'blob.generate-client-token',
      payload: { pathname: 'a.pdf', multipart: false, clientPayload: null },
    });
    expect(response.statusCode).toBe(400);
    expect(errorOf(response).code).toBe('FILE_MISSING');
  });
});

describe('POST /api/documents with the blob the browser uploaded', () => {
  it('makes the document: checks the blob like any upload, reads it back once for all the ticks, and ends ready', async () => {
    const { started, store } = await blobServer({ INGEST_TICK_BUDGET_MS: '1000' });
    const client = started.client();
    const ticket = await ticketOf(client);
    const bytes = await readFixture('text-en.pdf');
    store.upload(ticket.pathname, bytes); // what the browser's upload() does

    const response = await createFrom(client, ticket, { filename: '../../Quarterly‮txt.pdf' });
    expect(response.statusCode, response.body).toBe(202);
    const accepted = summaryOf(response);
    expect(accepted).toMatchObject({
      id: ticket.pathname.slice(0, -4),
      filename: 'Quarterlytxt.pdf', // the display name is sanitised like for any upload
      pageCount: 5,
      status: 'processing',
      byteSize: bytes.length,
    });
    // The ticket is spent: it made this document.
    expect(await uploadTicketsRepo.find(db, ticket.pathname)).toMatchObject({ document_id: accepted.id });
    const answers = await tickUntilDone(client, accepted.id);
    expect(answers.at(-1)?.status).toBe('ready');
    expect(answers.length).toBeGreaterThan(2); // read over several ticks...
    // ...and the blob was fetched twice in all: once to check it, once for every tick together (a copy in the scratch directory).
    expect(store.callsTo('get')).toHaveLength(2);
    expect(await readdir(path.join(started.config.tmpDir, INGEST_CACHE_DIRECTORY)).catch(() => [])).toEqual(
      [],
    );
    expect(await readdir(path.join(started.config.tmpDir, UPLOAD_SCRATCH_DIRECTORY)).catch(() => [])).toEqual(
      [],
    );

    // The file for the viewer comes through the session check, from the private store; removing the document removes the blob.
    const file = await client.get(`/api/documents/${accepted.id}/file`);
    expect(file.statusCode).toBe(200);
    expect(file.rawPayload.equals(bytes)).toBe(true);
    expect((await started.client().get(`/api/documents/${accepted.id}/file`)).statusCode).toBe(404);
    expect((await client.delete(`/api/documents/${accepted.id}`)).statusCode).toBe(204);
    expect(store.blobs.has(ticket.pathname)).toBe(false);
  }, 120_000);

  it('makes one document of one ticket, ever: not again after a refusal, not again after the document was deleted', async () => {
    const { started, store } = await blobServer();
    const client = started.client();

    // After the document was deleted: the same ticket, with the blob put back (the token was still good), makes nothing.
    const ticket = await ticketOf(client);
    store.upload(ticket.pathname, await readFixture('text-en.pdf'));
    const first = summaryOf(await createFrom(client, ticket));
    expect((await client.delete(`/api/documents/${first.id}`)).statusCode).toBe(204);
    store.upload(ticket.pathname, await readFixture('text-en.pdf'));
    const again = await createFrom(client, ticket);
    expect([again.statusCode, errorOf(again).code]).toEqual([400, 'FILE_MISSING']);
    expect(errorOf(again).detail).toBe('the upload ticket was used already');
    expect((await db.query('SELECT 1 FROM documents WHERE id = $1', [first.id])).rowCount).toBe(0);

    // After a refusal: the file was not a PDF; the same ticket with a good file makes nothing either.
    const refused = await ticketOf(client);
    store.upload(refused.pathname, await readFixture('not-a-pdf.pdf'));
    expect((await createFrom(client, refused)).statusCode).toBe(415);
    store.upload(refused.pathname, await readFixture('text-en.pdf'));
    const retried = await createFrom(client, refused);
    expect([retried.statusCode, errorOf(retried).code]).toEqual([400, 'FILE_MISSING']);
    expect(
      (await db.query('SELECT 1 FROM documents WHERE id = $1', [refused.pathname.slice(0, -4)])).rowCount,
    ).toBe(0);
  }, 60_000);

  it('asks the store nothing for a create without its ticket, with a ticket of another session, or with one that was not issued', async () => {
    const { started, store } = await blobServer();
    const alice = started.client();
    const bob = started.client();
    const ticket = await ticketOf(alice);
    store.upload(ticket.pathname, await readFixture('text-en.pdf'));
    const before = store.calls.length;
    const sub = ticketSubject(SECRET, await sessionOf(bob));
    const unissued = `${randomUUID()}.pdf`;
    const attempts: [string, Client, Record<string, unknown>][] = [
      ['no ticket at all', alice, { blobPathname: ticket.pathname }],
      [
        'a ticket that names another blob',
        alice,
        { blobPathname: `${randomUUID()}.pdf`, ticket: ticket.clientPayload },
      ],
      [
        'Alice’s blob and ticket, from Bob',
        bob,
        { blobPathname: ticket.pathname, ticket: ticket.clientPayload },
      ],
      [
        'a ticket of Bob’s signed for a blob nobody issued',
        bob,
        {
          blobPathname: unissued,
          ticket: signTicket(SECRET, { sub, pathname: unissued, exp: Date.now() + 60_000 }),
        },
      ],
      ['a ticket that does not verify', alice, { blobPathname: ticket.pathname, ticket: 'x.y' }],
    ];
    for (const [what, who, body] of attempts) {
      const response = await who.postJson('/api/documents', body);
      expect(response.statusCode, what).toBe(400);
    }
    expect(store.calls).toHaveLength(before); // not one call to the store
    // Alice's blob was not touched by any of it, and her ticket still works.
    expect(store.blobs.has(ticket.pathname)).toBe(true);
    expect((await createFrom(alice, ticket)).statusCode).toBe(202);
  }, 60_000);

  it('answers the same document when it is told about the same upload again, and gives nobody else’s document away', async () => {
    const { started, store } = await blobServer();
    const client = started.client();
    const ticket = await ticketOf(client);
    store.upload(ticket.pathname, await readFixture('text-en.pdf'));
    const first = summaryOf(await createFrom(client, ticket));
    const again = summaryOf(await createFrom(client, ticket));
    expect(again.id).toBe(first.id);
    const thief = await createFrom(started.client(), ticket);
    expect(thief.statusCode).toBe(400);
    expect(errorOf(thief).code).toBe('FILE_MISSING');
    expect(store.blobs.has(ticket.pathname)).toBe(true); // and the blob is not deleted by the attempt
  }, 60_000);

  it('makes one document of two calls that arrive together for the same ticket (a client that retried), and keeps its file', async () => {
    const { started, store } = await blobServer();
    const client = started.client();
    const ticket = await ticketOf(client);
    store.upload(ticket.pathname, await readFixture('text-en.pdf'));
    const [first, second] = await Promise.all([createFrom(client, ticket), createFrom(client, ticket)]);
    expect([first.statusCode, second.statusCode]).toEqual([202, 202]);
    expect(summaryOf(second).id).toBe(summaryOf(first).id);
    expect(store.blobs.has(ticket.pathname)).toBe(true);
    expect((await db.query('SELECT 1 FROM documents WHERE id = $1', [summaryOf(first).id])).rowCount).toBe(1);
    // And the document goes on to be read.
    expect((await tickUntilDone(client, summaryOf(first).id)).at(-1)?.status).toBe('ready');
  }, 120_000);

  it('does not delete its own blob when another instance made the document while this one was still checking the file', async () => {
    const { started, store } = await blobServer();
    const client = started.client();
    const ticket = await ticketOf(client);
    store.upload(ticket.pathname, await readFixture('text-en.pdf'));
    const id = ticket.pathname.slice(0, -4);
    const sessionId = await sessionOf(client);
    // Another instance (another process: this one's own retries are folded together) gets its document in between this
    // request's look at the ticket and its insert: exactly when the store is asked about the blob.
    let raced = false;
    store.onHead = async () => {
      if (raced) return;
      raced = true;
      await db.transaction(async (tx) => {
        await documentsRepo.insert(tx, {
          id,
          sessionId,
          filename: 'text-en.pdf',
          byteSize: 1,
          sha256: 'x',
          pageCount: 5,
          storageKey: ticket.pathname,
          expiresAt: new Date(Date.now() + 3_600_000),
        });
        await ingestJobsRepo.create(tx, id);
        await uploadTicketsRepo.claim(tx, ticket.pathname, sessionId, id);
      });
    };
    const response = await createFrom(client, ticket);
    expect(response.statusCode, response.body).toBe(202);
    expect(summaryOf(response).id).toBe(id); // the other instance's document is the answer
    expect(store.blobs.has(ticket.pathname)).toBe(true); // and its file is still there
    expect((await db.query('SELECT 1 FROM documents WHERE id = $1', [id])).rowCount).toBe(1);
  }, 60_000);

  it('keeps the blob and the ticket when the archive is busy, so that the same call works a moment later', async () => {
    const { started, store } = await blobServer({ MAX_QUEUED_JOBS: '1', INGEST_CONCURRENCY: '1' });
    const client = started.client();
    const late = await ticketOf(client); // a ticket while the line still has room
    const others: string[] = [];
    for (let i = 0; i < 2; i += 1) {
      const other = started.client();
      const ticket = await ticketOf(other);
      store.upload(ticket.pathname, await readFixture('text-en.pdf'));
      others.push(summaryOf(await createFrom(other, ticket)).id);
    }
    // A ticket is refused too while the line is full.
    const refusedTicket = await client.request('POST', '/api/uploads/ticket');
    expect(refusedTicket.statusCode).toBe(429);
    store.upload(late.pathname, await readFixture('text-en.pdf'));
    const calls = store.calls.length;
    let busy = await createFrom(client, late);
    expect(busy.statusCode).toBe(429);
    expect(errorOf(busy).message).toContain('busy');
    expect(busy.headers['retry-after']).toBe(String(BUSY_RETRY_AFTER_SECONDS)); // when to come back
    // Retrying while busy asks the store nothing at all (no head, no read of up to MAX_UPLOAD_MB), and uses none of the
    // ticket's few turns at the store: a client may wait for its place for as long as the ticket lives.
    for (let retry = 0; retry < 5; retry += 1) {
      busy = await createFrom(client, late);
      expect(busy.statusCode).toBe(429);
    }
    expect(store.calls).toHaveLength(calls);
    expect(store.blobs.has(late.pathname)).toBe(true); // not deleted: nothing was wrong with it
    expect((await uploadTicketsRepo.find(db, late.pathname))?.claimed_at).toBeNull(); // and the ticket is still good
    for (const id of others) await started.app.ingestion.service.removeDocument(id);
    expect((await createFrom(client, late)).statusCode).toBe(202); // and the same call works, with its turns at the store intact
  }, 120_000);

  it('does not delete the blob for a store that did not answer: it says to try again and keeps the blob and the ticket', async () => {
    const { started, store } = await blobServer();
    const client = started.client();
    const ticket = await ticketOf(client);
    store.upload(ticket.pathname, await readFixture('text-en.pdf'));
    store.failNext('get', 1); // the read of the blob drops
    const failed = await createFrom(client, ticket);
    expect(failed.statusCode).toBe(500);
    expect(errorOf(failed).code).toBe('STORAGE_FAILED');
    expect(store.blobs.has(ticket.pathname)).toBe(true);
    expect((await uploadTicketsRepo.find(db, ticket.pathname))?.claimed_at).toBeNull();
    store.failNext('head', 1);
    expect((await createFrom(client, ticket)).statusCode).toBe(500); // asking about it failed this time
    expect(store.blobs.has(ticket.pathname)).toBe(true);
    // The retry finds everything as it was.
    expect((await createFrom(client, ticket)).statusCode).toBe(202);
  }, 60_000);

  it('answers FILE_MISSING when nothing arrived, and 400 for a body that is not a blob of a ticket', async () => {
    const { started } = await blobServer();
    const client = started.client();
    const ticket = await ticketOf(client);
    const nothing = await createFrom(client, ticket); // a ticket, but the browser never uploaded
    expect(nothing.statusCode).toBe(400);
    expect(errorOf(nothing).code).toBe('FILE_MISSING');
    expect((await uploadTicketsRepo.find(db, ticket.pathname))?.claimed_at).toBeNull();
    for (const body of [
      {},
      { blobPathname: '../x.pdf' },
      { blobPathname: 'a/b.pdf' },
      { blobPathname: `${randomUUID()}.png` },
      { blobPathname: `${'-'.repeat(36)}.pdf`, ticket: 'x.y' }, // 36 characters that are no uuid
      { blobPathname: `${'a'.repeat(36)}.pdf`, ticket: 'x.y' },
      'x',
    ]) {
      expect((await client.postJson('/api/documents', body)).statusCode, JSON.stringify(body)).toBe(400);
    }
  });

  it('is refused when the files go to this server', async () => {
    const started = await startServer(db, testConfig());
    servers.push(started);
    const response = await started
      .client()
      .postJson('/api/documents', { blobPathname: `${randomUUID()}.pdf`, ticket: 'x.y' });
    expect(response.statusCode).toBe(400);
    expect(errorOf(response).code).toBe('FILE_MISSING');
  });
});

describe('the same checks for a blob and for a multipart upload', () => {
  const CASES: { fixture: string; env: Record<string, string>; status: number; code: string }[] = [
    { fixture: 'not-a-pdf.pdf', env: {}, status: 415, code: 'FILE_NOT_PDF' },
    { fixture: 'malformed.pdf', env: {}, status: 422, code: 'PDF_MALFORMED' },
    { fixture: 'encrypted.pdf', env: {}, status: 422, code: 'PDF_ENCRYPTED' },
    { fixture: 'twelve-pages.pdf', env: { MAX_PAGES: '10' }, status: 422, code: 'TOO_MANY_PAGES' },
  ];

  it.each(CASES)(
    '$fixture is refused as $status $code either way, and the blob is deleted',
    async ({ fixture, env, status, code }) => {
      const { started, store } = await blobServer(env);
      const bytes = await readFixture(fixture);

      const direct = await started.client().upload(bytes, { filename: fixture });
      expect([direct.statusCode, errorOf(direct).code]).toEqual([status, code]);
      // (The multipart route writes to the same store, once the file has passed: a refused file never got there.)
      expect([...store.blobs.keys()]).toEqual([]);

      const client = started.client();
      const ticket = await ticketOf(client);
      store.upload(ticket.pathname, bytes);
      const blob = await createFrom(client, ticket);
      expect([blob.statusCode, errorOf(blob).code]).toEqual([status, code]);
      expect(errorOf(blob).message).toBe(errorOf(direct).message);

      // Nothing is left: no blob (the failed one was deleted), no row, no scratch file; and the ticket is spent.
      expect([...store.blobs.keys()]).toEqual([]);
      expect(
        (await db.query('SELECT 1 FROM documents WHERE id = $1', [ticket.pathname.slice(0, -4)])).rowCount,
      ).toBe(0);
      expect(
        await readdir(path.join(started.config.tmpDir, UPLOAD_SCRATCH_DIRECTORY)).catch(() => []),
      ).toEqual([]);
      expect((await uploadTicketsRepo.find(db, ticket.pathname))?.claimed_at).not.toBeNull();
    },
    60_000,
  );

  it('refuses an empty blob like an empty file, and a blob over MAX_UPLOAD_MB like a file over it', async () => {
    const { started, store } = await blobServer({ MAX_UPLOAD_MB: '1' });
    const client = started.client();
    const empty = await ticketOf(client);
    store.upload(empty.pathname, new Uint8Array(0));
    const emptyAnswer = await createFrom(client, empty);
    expect([emptyAnswer.statusCode, errorOf(emptyAnswer).code]).toEqual([400, 'FILE_MISSING']);
    expect(store.blobs.has(empty.pathname)).toBe(false);

    const big = await ticketOf(client);
    store.upload(big.pathname, Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(1024 * 1024 + 10)]));
    const bigAnswer = await createFrom(client, big);
    expect([bigAnswer.statusCode, errorOf(bigAnswer).code]).toEqual([413, 'FILE_TOO_LARGE']);
    expect(store.blobs.has(big.pathname)).toBe(false);
  }, 60_000);

  it('replaces the document the session was still reading, like a multipart upload does', async () => {
    const { started, store } = await blobServer();
    const client = started.client();
    const first = await ticketOf(client);
    store.upload(first.pathname, await readFixture('text-en.pdf'));
    const firstSummary = summaryOf(await createFrom(client, first));
    const second = await ticketOf(client);
    store.upload(second.pathname, await readFixture('arabic.pdf'));
    summaryOf(await createFrom(client, second));
    expect((await client.get(`/api/documents/${firstSummary.id}`)).statusCode).toBe(404);
    expect(store.blobs.has(first.pathname)).toBe(false); // its blob went with it
  }, 60_000);

  it('keeps one active document for a session whose uploads arrive together (a double click, two tabs)', async () => {
    const { started, store } = await blobServer();
    const client = started.client();
    const tickets: Ticket[] = [];
    for (let i = 0; i < 4; i += 1) {
      const ticket = await ticketOf(client);
      store.upload(ticket.pathname, await readFixture('text-en.pdf'));
      tickets.push(ticket);
    }
    const answers = await Promise.all(tickets.map((ticket) => createFrom(client, ticket)));
    expect(answers.every((answer) => answer.statusCode === 202)).toBe(true);
    // Each replaced the one before in turn (whatever the order): exactly one is left that is still being read.
    expect((await documentsRepo.listProcessingForSession(db, await sessionOf(client))).length).toBe(1);
  }, 60_000);
});

describe('the multipart upload in Blob mode, and the allowances of a visitor', () => {
  const blobWrites = async (): Promise<number> =>
    Number(
      (
        await db.query<{ total: string | null }>(
          `SELECT SUM(count) AS total FROM rate_counters WHERE key = 'blob:writes'`,
        )
      ).rows[0]?.total ?? 0,
    );

  it('records the file the server itself wrote as a ticket, claimed by the document it made, and counts the write', async () => {
    const { started, store } = await blobServer();
    const response = await started.client().uploadFixture('text-en.pdf');
    expect(response.statusCode, response.body).toBe(202);
    const document = summaryOf(response);
    const record = await uploadTicketsRepo.find(db, `${document.id}.pdf`);
    expect(record?.document_id).toBe(document.id);
    expect(record?.claimed_at).not.toBeNull();
    expect(store.callsTo('put')).toHaveLength(1);
    expect(await blobWrites()).toBe(1); // one write operation, against the same budget as a ticket
  }, 60_000);

  it('refuses it over the byte budget before the store is written, and gives the visitor’s allowance back', async () => {
    const { started, store } = await blobServer({
      BLOB_MAX_TOTAL_MB: '1',
      MAX_UPLOAD_MB: '1',
      UPLOADS_PER_HOUR: '2',
    });
    const client = started.client();
    await ticketOf(client); // promises the whole megabyte
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const refused = await client.uploadFixture('text-en.pdf');
      expect([refused.statusCode, errorOf(refused).code]).toEqual([429, 'RATE_LIMITED']);
      expect(errorOf(refused).message).toContain('archive is full'); // never "too many requests": the allowance is given back
    }
    expect(store.calls).toHaveLength(0);
    expect((await db.query('SELECT 1 FROM documents')).rowCount).toBe(0);
    expect((await db.query('SELECT 1 FROM upload_tickets')).rowCount).toBe(1); // only the ticket
  }, 60_000);

  it('gives the allowances back for a ticket the day’s budget turned away, and for an upload the busy line turned away', async () => {
    const full = await blobServer({ BLOB_MAX_WRITES_PER_DAY: '1', UPLOADS_PER_HOUR: '1' });
    const client = full.started.client();
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const refused = await client.request('POST', '/api/uploads/ticket');
      expect(refused.statusCode).toBe(429);
      expect(errorOf(refused).message).toContain('archive is full');
    }

    await resetCounters(db);
    const busy = await blobServer({
      MAX_QUEUED_JOBS: '1',
      INGEST_CONCURRENCY: '1',
      UPLOADS_PER_HOUR: '2',
      UPLOADS_PER_HOUR_PER_IP: '4',
    });
    expect((await busy.started.client().uploadFixture('text-en.pdf')).statusCode).toBe(202);
    expect((await busy.started.client().uploadFixture('text-en.pdf')).statusCode).toBe(202);
    const waiting = busy.started.client();
    const puts = busy.store.callsTo('put').length;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const refused = await waiting.uploadFixture('text-en.pdf');
      expect(refused.statusCode).toBe(429);
      expect(errorOf(refused).message).toContain('busy'); // and never the address's or the session's allowance
      expect(refused.headers['retry-after']).toBe(String(BUSY_RETRY_AFTER_SECONDS));
    }
    expect(busy.store.callsTo('put')).toHaveLength(puts);
  }, 60_000);

  it('lets a session whose own document is still waiting upload again when the line is full, and turns a newcomer away', async () => {
    for (const mode of ['direct', 'blob'] as const) {
      const { started } =
        mode === 'blob'
          ? await blobServer({ MAX_QUEUED_JOBS: '1', INGEST_CONCURRENCY: '1', UPLOADS_PER_HOUR_PER_IP: '20' })
          : {
              started: await startServer(
                db,
                testConfig({ MAX_QUEUED_JOBS: '1', INGEST_CONCURRENCY: '1', UPLOADS_PER_HOUR_PER_IP: '20' }),
              ),
            };
      if (mode === 'direct') servers.push(started);
      const mine = started.client();
      expect((await mine.uploadFixture('text-en.pdf')).statusCode, mode).toBe(202);
      expect((await started.client().uploadFixture('text-en.pdf')).statusCode, mode).toBe(202);
      const newcomer = await started.client().uploadFixture('text-en.pdf');
      expect([newcomer.statusCode, newcomer.headers['retry-after']], mode).toEqual([
        429,
        String(BUSY_RETRY_AFTER_SECONDS),
      ]);
      // Its own waiting document is replaced by the new upload (a place in the line that is already its own).
      expect((await mine.uploadFixture('text-en.pdf')).statusCode, mode).toBe(202);
      await resetCounters(db);
      await db.query('TRUNCATE documents CASCADE');
    }
  }, 120_000);
});

describe('one document from a ticket whose requests come and go', () => {
  const bodyOf = (ticket: Ticket) => ({ blobPathname: ticket.pathname, ticket: ticket.clientPayload });

  it('goes on for the retry when the first request of the same ticket has gone away', async () => {
    const { started, store } = await blobServer();
    const client = started.client();
    const ticket = await ticketOf(client);
    store.upload(ticket.pathname, await readFixture('text-en.pdf'));
    const sessionId = await sessionOf(client);
    let entered = false;
    let open!: () => void;
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    store.onHead = async () => {
      entered = true;
      await gate;
    };
    const deps = { db, ingestion: started.app.ingestion };
    const first = new AbortController();
    const second = new AbortController();
    const one = createDocumentFromBlob(
      started.config,
      deps,
      { body: bodyOf(ticket), sessionId },
      first.signal,
    );
    await vi.waitFor(() => expect(entered).toBe(true));
    const two = createDocumentFromBlob(
      started.config,
      deps,
      { body: bodyOf(ticket), sessionId },
      second.signal,
    );
    first.abort(); // the first client timed out and closed its connection; the retry is still waiting
    open();
    const made = await two;
    expect((await one).id).toBe(made.id);
    expect(store.blobs.has(ticket.pathname)).toBe(true);
    expect((await db.query('SELECT 1 FROM documents WHERE id = $1', [made.id])).rowCount).toBe(1);
  }, 60_000);

  it('stops the work only when every request that joined it has gone, and keeps the blob and the ticket', async () => {
    const { started, store } = await blobServer();
    const client = started.client();
    const ticket = await ticketOf(client);
    store.upload(ticket.pathname, await readFixture('text-en.pdf'));
    const sessionId = await sessionOf(client);
    let entered = false;
    let open!: () => void;
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    store.onHead = async () => {
      entered = true;
      await gate;
    };
    const deps = { db, ingestion: started.app.ingestion };
    const first = new AbortController();
    const second = new AbortController();
    const one = createDocumentFromBlob(
      started.config,
      deps,
      { body: bodyOf(ticket), sessionId },
      first.signal,
    );
    await vi.waitFor(() => expect(entered).toBe(true));
    const two = createDocumentFromBlob(
      started.config,
      deps,
      { body: bodyOf(ticket), sessionId },
      second.signal,
    );
    first.abort();
    second.abort();
    open();
    const outcomes = await Promise.allSettled([one, two]);
    expect(outcomes.map((outcome) => outcome.status)).toEqual(['rejected', 'rejected']);
    expect(store.blobs.has(ticket.pathname)).toBe(true); // nothing wrong with the file: it stays, for the retry
    expect((await uploadTicketsRepo.find(db, ticket.pathname))?.claimed_at).toBeNull();
    expect((await db.query('SELECT 1 FROM documents')).rowCount).toBe(0);
    // A later request starts the work again, and makes the document.
    store.onHead = undefined;
    expect((await createFrom(client, ticket)).statusCode).toBe(202);
  }, 60_000);
});
