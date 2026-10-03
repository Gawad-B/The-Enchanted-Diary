import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '../src/db/client.js';
import { documentsRepo } from '../src/db/repositories/documents.js';
import { uploadTicketsRepo } from '../src/db/repositories/upload-tickets.js';
import { StorageError, type StoredObject } from '../src/storage/provider.js';
import { sweepRetention } from '../src/storage/retention.js';
import { createStorage } from '../src/storage/index.js';
import { VercelBlobStorage, type BlobClient } from '../src/storage/vercel-blob.js';
import { FakeBlobStore } from './doubles/fake-blob.js';
import {
  createMigratedPgliteTestDb,
  insertSession,
  nextTestDirectory,
  testConfig,
  type TestDb,
} from './helpers.js';

const key = (): string => `${randomUUID()}.pdf`;
const PDF = Buffer.from('%PDF-1.7\n% a few bytes of a pretend file\n');

async function readAll(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

let store: FakeBlobStore;
let storage: VercelBlobStorage;
beforeEach(() => {
  store = new FakeBlobStore();
  storage = new VercelBlobStorage({ token: 'vercel_blob_rw_test', client: store.client });
});

describe('VercelBlobStorage', () => {
  it('stores a PDF in the PRIVATE store under its key, as a PDF, and reads it back whole or as a stream', async () => {
    const id = key();
    expect(await storage.put(id, PDF)).toEqual({ size: PDF.length });
    const [put] = store.callsTo('put');
    expect(put?.target).toBe(id);
    expect(put?.options).toMatchObject({
      access: 'private',
      contentType: 'application/pdf',
      addRandomSuffix: false,
      allowOverwrite: false, // a key is a fresh uuid: nothing is ever overwritten
      multipart: false, // one operation of a small quota, not three or more
      token: 'vercel_blob_rw_test',
    });
    expect((await storage.get(id)).equals(PDF)).toBe(true);
    expect((await readAll(storage.createReadStream(id))).equals(PDF)).toBe(true);
    // Every read goes through the SDK with the credentials, privately, and past the CDN cache.
    for (const call of store.callsTo('get')) {
      expect(call.options).toMatchObject({
        access: 'private',
        useCache: false,
        token: 'vercel_blob_rw_test',
      });
    }
  });

  it('accepts a stream as well as bytes', async () => {
    const id = key();
    await storage.put(id, Readable.from([PDF.subarray(0, 10), PDF.subarray(10)]));
    expect((await storage.get(id)).equals(PDF)).toBe(true);
  });

  it('reports size and time, and null for a blob that is not there', async () => {
    const id = key();
    await storage.put(id, PDF);
    expect(await storage.stat(id)).toMatchObject({ size: PDF.length, mtime: expect.any(Date) as Date });
    expect(await storage.stat(key())).toBeNull();
  });

  it('fails with NOT_FOUND for a missing blob, on get and on the stream', async () => {
    await expect(storage.get(key())).rejects.toMatchObject({ name: 'StorageError', kind: 'NOT_FOUND' });
    const stream = storage.createReadStream(key());
    await expect(readAll(stream)).rejects.toMatchObject({ name: 'StorageError', kind: 'NOT_FOUND' });
  });

  it('recognises a missing blob by the SDK’s own class (whose instances are named "Error"), and by nothing else', async () => {
    // The real thing: `BlobNotFoundError` of the SDK, whose name is "Error" (the SDK sets none).
    expect(new store.client.BlobNotFoundError().name).toBe('Error');
    expect(await storage.stat(key())).toBeNull();
    const id = key();
    await storage.put(id, PDF);
    await storage.delete(id);
    await expect(storage.delete(id)).resolves.toBeUndefined();
    // An error that merely calls itself that is not it: that is a store that failed.
    const lookalike = new VercelBlobStorage({
      client: {
        ...store.client,
        head: () => Promise.reject(Object.assign(new Error('x'), { name: 'BlobNotFoundError' })),
      },
    });
    await expect(lookalike.stat(key())).rejects.toMatchObject({ kind: 'IO' });
  });

  it('does not put over a blob that is there: nothing of anyone else’s is overwritten', async () => {
    const id = key();
    await storage.put(id, PDF);
    await expect(storage.put(id, Buffer.from('%PDF-other'))).rejects.toMatchObject({ kind: 'IO' });
    expect((await storage.get(id)).equals(PDF)).toBe(true);
  });

  it('asks for nothing until the stream is read, so that an error cannot come before its reader is listening', async () => {
    const id = key();
    await storage.put(id, PDF);
    store.failNext('get', 1);
    const stream = storage.createReadStream(id);
    await new Promise((resolve) => setTimeout(resolve, 30)); // nobody has attached anything yet: nothing may have happened
    expect(store.callsTo('get')).toHaveLength(0);
    await expect(readAll(stream)).rejects.toMatchObject({ name: 'StorageError', kind: 'IO' });
    // And a reader that stops early cancels the request.
    const second = storage.createReadStream(id);
    for await (const _chunk of second) break; // the first chunk is enough
    await new Promise((resolve) => setTimeout(resolve, 20));
    const options = store.callsTo('get').at(-1)?.options as { abortSignal?: AbortSignal };
    expect(options.abortSignal?.aborted).toBe(true);
  });

  it('stops a read that is under way when the caller’s signal fires (a read of the store is bounded by the tick that asked)', async () => {
    const hanging = new VercelBlobStorage({
      token: 'vercel_blob_rw_test',
      client: {
        ...store.client,
        // A store that never answers, until the request is cancelled.
        get: ((_pathname: string, options: { abortSignal?: AbortSignal }) =>
          new Promise((_resolve, reject) => {
            const abort = (): void => {
              reject(new DOMException('This operation was aborted', 'AbortError'));
            };
            // (Like fetch: a signal that has fired already ends the request at once.)
            if (options.abortSignal?.aborted === true) abort();
            options.abortSignal?.addEventListener('abort', abort, { once: true });
          })) as unknown as BlobClient['get'],
      },
    });
    const caller = new AbortController();
    const read = hanging.get(key(), { signal: caller.signal });
    setTimeout(() => {
      caller.abort();
    }, 20);
    await expect(read).rejects.toMatchObject({ name: 'StorageError', kind: 'IO' });
    // A signal that has fired already ends the read before it waits for anything.
    await expect(hanging.get(key(), { signal: AbortSignal.abort() })).rejects.toMatchObject({
      name: 'StorageError',
      kind: 'IO',
    });
  });

  it('wraps what the SDK throws, without its text', async () => {
    const broken = new VercelBlobStorage({
      client: {
        ...store.client,
        head: () => Promise.reject(new Error('token vercel_blob_rw_secret rejected')),
      },
    });
    const failure = await broken.stat(key()).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(StorageError);
    expect((failure as StorageError).kind).toBe('IO');
    expect((failure as StorageError).message).not.toContain('vercel_blob_rw_secret');
  });

  it('deletes, and does not mind deleting what is not there', async () => {
    const id = key();
    await storage.put(id, PDF);
    await storage.delete(id);
    expect(await storage.stat(id)).toBeNull();
    await expect(storage.delete(id)).resolves.toBeUndefined();
  });

  it('never lets anything but a server-made key reach the store', async () => {
    for (const bad of [
      '../x.pdf',
      'a/b.pdf',
      `${randomUUID()}.txt`,
      '',
      'x',
      `${randomUUID()}.pdf/../../y.pdf`,
    ]) {
      await expect(storage.put(bad, PDF), bad).rejects.toMatchObject({ kind: 'INVALID_KEY' });
      await expect(storage.get(bad), bad).rejects.toMatchObject({ kind: 'INVALID_KEY' });
      await expect(storage.stat(bad), bad).rejects.toMatchObject({ kind: 'INVALID_KEY' });
      await expect(storage.delete(bad), bad).rejects.toMatchObject({ kind: 'INVALID_KEY' });
      expect(() => storage.createReadStream(bad), bad).toThrow(StorageError);
    }
    expect(store.calls).toEqual([]);
  });

  it('lists the blobs it could have written, across pages, and no others', async () => {
    store.pageSize = 2;
    const mine = [key(), key(), key(), key(), key()];
    for (const id of mine) store.upload(id, PDF);
    store.upload('someone-elses/file.pdf', PDF);
    store.upload('notes.txt', PDF);
    const listed: StoredObject[] = await storage.list();
    expect(listed.map((object) => object.key).sort()).toEqual([...mine].sort());
    expect(listed.every((object) => object.size === PDF.length && !object.temporary)).toBe(true);
    expect(store.callsTo('list')).toHaveLength(4); // seven blobs, two to a page
    await expect(storage.deleteTemporary()).resolves.toBeUndefined();
  });

  it('is what the configuration builds for STORAGE_PROVIDER=vercel-blob, with the token', async () => {
    const config = testConfig({ STORAGE_PROVIDER: 'vercel-blob', BLOB_READ_WRITE_TOKEN: 'tok' });
    const built = await createStorage(config, store.client);
    expect(built).toBeInstanceOf(VercelBlobStorage);
    await built.put(key(), PDF);
    expect(store.callsTo('put')[0]?.options).toMatchObject({ token: 'tok' });
    expect((await createStorage(testConfig({ STORAGE_DIR: nextTestDirectory('s') }))).name).toBe('local');
  });
});

describe('the retention pass over a Blob store', () => {
  let test: TestDb;
  let db: Db;
  beforeAll(async () => {
    test = await createMigratedPgliteTestDb();
    db = test.db;
  });
  afterAll(async () => {
    await test.dispose();
  });

  /** The database made an upload ticket for this blob (so that it is its to clean up). */
  async function issued(
    pathname: string,
    options: { expiresAt: Date; claimed: boolean } = {
      expiresAt: new Date(Date.now() - 48 * 3_600_000),
      claimed: true,
    },
  ): Promise<void> {
    const sessionId = await insertSession(db);
    await uploadTicketsRepo.issue(db, { pathname, sessionId, maxBytes: 1024, expiresAt: options.expiresAt });
    // (A ticket that was used, for a document that is gone and whose blob could not be deleted then: an orphan of this database.)
    if (options.claimed) await uploadTicketsRepo.claim(db, pathname, sessionId, randomUUID());
  }

  async function document(expiresAt: Date): Promise<string> {
    const sessionId = await insertSession(db);
    const id = randomUUID();
    await documentsRepo.insert(db, {
      id,
      sessionId,
      filename: 'a.pdf',
      byteSize: PDF.length,
      sha256: 'x',
      pageCount: 1,
      storageKey: `${id}.pdf`,
      expiresAt,
    });
    store.upload(`${id}.pdf`, PDF);
    return id;
  }

  it('deletes the blobs of expired documents and of orphans this database issued a ticket for, and keeps the rest', async () => {
    const expired = await document(new Date(Date.now() - 60_000));
    const live = await document(new Date(Date.now() + 3_600_000));
    const orphan = key();
    store.upload(orphan, PDF);
    store.blobs.get(orphan)!.uploadedAt = new Date(Date.now() - 48 * 3_600_000); // older than the retention window
    await issued(orphan); // ... and this database made a ticket for it
    const foreign = key();
    store.upload(foreign, PDF); // the same age, but nobody here ever issued a ticket for it: another environment's
    store.blobs.get(foreign)!.uploadedAt = new Date(Date.now() - 48 * 3_600_000);
    const fresh = key();
    store.upload(fresh, PDF); // an upload that may still be on its way to becoming a document: left alone
    await issued(fresh, { expiresAt: new Date(Date.now() + 600_000), claimed: false });

    const result = await sweepRetention({
      db,
      storage,
      retentionHours: 24,
      tmpDir: nextTestDirectory('sweep'),
    });
    expect(result).toMatchObject({ expiredDocuments: 1, orphanFiles: 1 });
    expect([...store.blobs.keys()].sort()).toEqual([`${live}.pdf`, foreign, fresh].sort());
    expect(store.blobs.has(`${expired}.pdf`)).toBe(false);
    expect(await documentsRepo.findById(db, expired)).toBeNull();
  });

  it('does not stop at a blob it cannot delete: it is told, and the rest of the pass is done', async () => {
    const stuck = await document(new Date(Date.now() - 60_000));
    const other = await document(new Date(Date.now() - 60_000));
    const realDelete = store.client.del;
    const warnings: object[] = [];
    store.client.del = (pathname, options) => {
      if (pathname === `${stuck}.pdf`) return Promise.reject(new Error('the store did not answer'));
      return realDelete(pathname, options);
    };
    try {
      const result = await sweepRetention({
        db,
        storage,
        retentionHours: 24,
        tmpDir: nextTestDirectory('sweep'),
        log: { warn: (object) => warnings.push(object) },
      });
      expect(result.expiredDocuments).toBe(2);
      expect(store.blobs.has(`${other}.pdf`)).toBe(false);
      expect(store.blobs.has(`${stuck}.pdf`)).toBe(true); // it could not be deleted: it stays, and is told
      expect(warnings).toHaveLength(1);
    } finally {
      store.client.del = realDelete;
    }
  });

  it('deletes nothing in an environment that has not been told it has data of its own', async () => {
    const expired = await document(new Date(Date.now() - 60_000));
    const result = await sweepRetention({
      db,
      storage,
      retentionHours: 24,
      tmpDir: nextTestDirectory('sweep'),
      mayDelete: false,
    });
    expect(result).toMatchObject({ refused: true, expiredDocuments: 0, orphanFiles: 0 });
    expect(await documentsRepo.findById(db, expired)).not.toBeNull();
    expect(store.blobs.has(`${expired}.pdf`)).toBe(true);
  });
});
