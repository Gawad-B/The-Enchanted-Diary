import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, stat, utimes, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { documentsRepo } from '../src/db/repositories/documents.js';
import { LocalDiskStorage } from '../src/storage/local-disk.js';
import { StorageError, isStorageKey } from '../src/storage/provider.js';
import { UPLOAD_SCRATCH_DIRECTORY, startRetentionTimer, sweepRetention } from '../src/storage/retention.js';
import { createMigratedPgliteTestDb, insertSession, nextTestDirectory, type TestDb } from './helpers.js';

const HOUR = 3_600_000;
const key = (): string => `${randomUUID()}.pdf`;

describe('LocalDiskStorage', () => {
  let directory: string;
  let storage: LocalDiskStorage;
  beforeEach(() => {
    directory = nextTestDirectory('storage');
    storage = new LocalDiskStorage(directory);
  });

  it('stores buffers and streams, reads them back and lists them with their modification time', async () => {
    const first = key();
    const second = key();
    expect(await storage.put(first, new Uint8Array([1, 2, 3, 4]))).toEqual({ size: 4 });
    expect(
      await storage.put(second, Readable.from([Buffer.from('%PDF-1.7 '), Buffer.from('streamed')])),
    ).toEqual({ size: 17 });
    expect([...(await storage.get(first))]).toEqual([1, 2, 3, 4]);
    expect((await storage.get(second)).toString()).toBe('%PDF-1.7 streamed');
    const chunks: Buffer[] = [];
    for await (const chunk of storage.createReadStream(second)) chunks.push(chunk as Buffer);
    expect(Buffer.concat(chunks).toString()).toBe('%PDF-1.7 streamed');
    expect(await storage.stat(first)).toMatchObject({ size: 4 });
    const listed = (await storage.list()).sort((a, b) => a.key.localeCompare(b.key));
    expect(listed.map((o) => o.key)).toEqual([first, second].sort());
    expect(listed.every((o) => o.mtime instanceof Date && !o.temporary)).toBe(true);
  });

  it('writes atomically: a failing stream leaves no file and no temporary file behind', async () => {
    const target = key();
    const failing = new Readable({
      read() {
        this.push(Buffer.from('partial'));
        this.destroy(new Error('connection reset'));
      },
    });
    await expect(storage.put(target, failing)).rejects.toMatchObject({ name: 'StorageError', kind: 'IO' });
    expect(await storage.stat(target)).toBeNull();
    expect(await readdir(directory)).toEqual([]);
  });

  it('removes files idempotently and reports a missing file as NOT_FOUND', async () => {
    const target = key();
    await storage.put(target, new Uint8Array([9]));
    await storage.delete(target);
    await storage.delete(target); // not an error
    expect(await storage.stat(target)).toBeNull();
    await expect(storage.get(target)).rejects.toMatchObject({ kind: 'NOT_FOUND' });
    const stream = storage.createReadStream(target);
    await expect(
      (async () => {
        for await (const chunk of stream) expect(chunk).toBeDefined();
      })(),
    ).rejects.toMatchObject({ name: 'StorageError', kind: 'NOT_FOUND' });
  });

  it('cannot be tricked into leaving its directory: only <uuid>.pdf keys are accepted', async () => {
    const outside = path.join(path.dirname(directory), `outside-${randomUUID()}.pdf`);
    await mkdir(path.dirname(directory), { recursive: true });
    await writeFile(outside, 'secret');
    const bad = [
      '../outside.pdf',
      `../${path.basename(outside)}`,
      outside,
      '..\\..\\windows.pdf',
      'a/b.pdf',
      `${randomUUID()}.pdf/../../x`,
      `${randomUUID()}.PDF`,
      `${randomUUID()}.pdf\0.png`,
      `${randomUUID()}.pdf.exe`,
      '',
      '.',
      '..',
      randomUUID(),
      'x'.repeat(36) + '.pdf',
      '%2e%2e%2f%2e%2e%2fetc%2fpasswd.pdf',
    ];
    for (const candidate of bad) {
      expect(isStorageKey(candidate), JSON.stringify(candidate)).toBe(false);
      await expect(storage.put(candidate, new Uint8Array([1]))).rejects.toBeInstanceOf(StorageError);
      await expect(storage.get(candidate)).rejects.toMatchObject({ kind: 'INVALID_KEY' });
      await expect(storage.delete(candidate)).rejects.toMatchObject({ kind: 'INVALID_KEY' });
      await expect(storage.stat(candidate)).rejects.toMatchObject({ kind: 'INVALID_KEY' });
      expect(() => storage.createReadStream(candidate)).toThrow(StorageError);
    }
    expect(await readFile(outside, 'utf8')).toBe('secret'); // untouched
    expect(await readdir(directory).catch(() => [])).toEqual([]); // nothing was written
  });

  it('lists only its own files and flags half-written ones', async () => {
    const target = key();
    await storage.put(target, new Uint8Array([1]));
    await writeFile(path.join(directory, 'notes.txt'), 'not ours');
    await writeFile(path.join(directory, `.${key()}.abc123.tmp`), 'half');
    const listed = await storage.list();
    expect(listed.filter((o) => !o.temporary).map((o) => o.key)).toEqual([target]);
    expect(listed.filter((o) => o.temporary)).toHaveLength(1);
    expect(listed.some((o) => o.key === 'notes.txt')).toBe(false);
    await expect(storage.deleteTemporary('../x.tmp')).rejects.toBeInstanceOf(StorageError);
    await expect(storage.deleteTemporary(target)).rejects.toBeInstanceOf(StorageError);
  });
});

describe('retention sweep', () => {
  let test: TestDb;
  let storage: LocalDiskStorage;
  let tmpDir: string;
  beforeEach(async () => {
    test = await createMigratedPgliteTestDb();
    storage = new LocalDiskStorage(nextTestDirectory('storage'));
    tmpDir = nextTestDirectory('tmp');
  });
  afterEach(async () => {
    await test.dispose();
  });

  const document = async (sessionId: string, expiresAt: Date, options: { createChild?: boolean } = {}) => {
    const id = randomUUID();
    const storageKey = `${id}.pdf`;
    await storage.put(storageKey, new Uint8Array([37, 80, 68, 70]));
    await documentsRepo.insert(test.db, {
      id,
      sessionId,
      filename: 'a.pdf',
      byteSize: 4,
      sha256: 'x',
      pageCount: 1,
      storageKey,
      expiresAt,
    });
    if (options.createChild === true) {
      await test.db.query(
        `INSERT INTO document_pages (document_id, page_number, width, height, extraction) VALUES ($1, 1, 1, 1, 'text')`,
        [id],
      );
    }
    return { id, storageKey };
  };

  const age = async (file: string, hours: number): Promise<void> => {
    const past = new Date(Date.now() - hours * HOUR);
    await utimes(file, past, past);
  };

  const sweep = (retentionHours = 24, onExpired?: (id: string) => void) =>
    sweepRetention({
      db: test.db,
      storage,
      retentionHours,
      tmpDir,
      ...(onExpired === undefined ? {} : { onExpired }),
    });

  it('removes expired documents with their rows (cascade) and files, and keeps the others', async () => {
    const session = await insertSession(test.db);
    const expired = await document(session, new Date(Date.now() - 1000), { createChild: true });
    const alive = await document(session, new Date(Date.now() + HOUR), { createChild: true });
    const seen: string[] = [];
    const result = await sweep(24, (id) => seen.push(id));
    expect(result).toMatchObject({ expiredDocuments: 1, orphanFiles: 0 });
    expect(seen).toEqual([expired.id]);
    expect(await documentsRepo.findById(test.db, expired.id)).toBeNull();
    expect(await storage.stat(expired.storageKey)).toBeNull();
    expect(
      (await test.db.query('SELECT 1 FROM document_pages WHERE document_id = $1', [expired.id])).rowCount,
    ).toBe(0);
    expect(await documentsRepo.findById(test.db, alive.id)).not.toBeNull();
    expect(await storage.stat(alive.storageKey)).not.toBeNull();
    expect(
      (await test.db.query('SELECT 1 FROM document_pages WHERE document_id = $1', [alive.id])).rowCount,
    ).toBe(1);
  });

  it('cancels the job of an expired document BEFORE its rows and file go (a running job must not meet missing rows)', async () => {
    const session = await insertSession(test.db);
    const expired = await document(session, new Date(Date.now() - 1000), { createChild: true });
    const atCancel: { row: boolean; file: boolean; pages: number }[] = [];
    await sweepRetention({
      db: test.db,
      storage,
      retentionHours: 24,
      tmpDir,
      onExpired: async (id) => {
        expect(id).toBe(expired.id);
        // The callback awaits (as cancelling a worker does) and the document is still whole until it returns.
        await new Promise((resolve) => setTimeout(resolve, 20));
        atCancel.push({
          row: (await documentsRepo.findById(test.db, id)) !== null,
          file: (await storage.stat(expired.storageKey)) !== null,
          pages: (await test.db.query('SELECT 1 FROM document_pages WHERE document_id = $1', [id])).rowCount,
        });
      },
    });
    expect(atCancel).toEqual([{ row: true, file: true, pages: 1 }]);
    expect(await documentsRepo.findById(test.db, expired.id)).toBeNull();
    expect(await storage.stat(expired.storageKey)).toBeNull();
  });

  it('removes orphan files older than the retention window, never newer ones or files with a row', async () => {
    const session = await insertSession(test.db);
    const owned = await document(session, new Date(Date.now() + HOUR));
    const oldOrphan = key();
    const newOrphan = key();
    await storage.put(oldOrphan, new Uint8Array([1]));
    await storage.put(newOrphan, new Uint8Array([1]));
    await age(path.join(storage.directory, oldOrphan), 30);
    await age(path.join(storage.directory, owned.storageKey), 30);
    const result = await sweep(24);
    expect(result.orphanFiles).toBe(1);
    expect(await storage.stat(oldOrphan)).toBeNull();
    expect(await storage.stat(newOrphan)).not.toBeNull(); // maybe an upload that has not got its row yet
    expect(await storage.stat(owned.storageKey)).not.toBeNull(); // old, but it has a row
  });

  it('removes abandoned half-written files in storage and in the upload scratch directory', async () => {
    const root = storage.directory;
    await mkdir(root, { recursive: true });
    const staleStorage = path.join(root, `.${key()}.aaaaaa.tmp`);
    const freshStorage = path.join(root, `.${key()}.bbbbbb.tmp`);
    await writeFile(staleStorage, 'x');
    await writeFile(freshStorage, 'x');
    await age(staleStorage, 3);
    const scratch = path.join(tmpDir, UPLOAD_SCRATCH_DIRECTORY);
    await mkdir(scratch, { recursive: true });
    const staleUpload = path.join(scratch, `${randomUUID()}.part`);
    const freshUpload = path.join(scratch, `${randomUUID()}.part`);
    const unrelated = path.join(scratch, 'keep.txt');
    for (const file of [staleUpload, freshUpload, unrelated]) await writeFile(file, 'x');
    await age(staleUpload, 3);
    await age(unrelated, 3);
    const result = await sweep();
    expect(result.staleTemporaryFiles).toBe(2);
    await expect(stat(staleStorage)).rejects.toThrow();
    await expect(stat(staleUpload)).rejects.toThrow();
    await stat(freshStorage);
    await stat(freshUpload);
    await stat(unrelated); // only *.part files are ours
  });

  it('removes stale sessions without documents, keeps the ones with documents or seen recently', async () => {
    const old = new Date(Date.now() - 30 * HOUR);
    const emptyOld = await insertSession(test.db, { lastSeenAt: old });
    const withDocument = await insertSession(test.db, { lastSeenAt: old });
    const recent = await insertSession(test.db);
    await document(withDocument, new Date(Date.now() + HOUR));
    const result = await sweep(24);
    expect(result.staleSessions).toBe(1);
    const left = (await test.db.query<{ id: string }>('SELECT id FROM sessions')).rows
      .map((row) => row.id)
      .sort();
    expect(left).toEqual([withDocument, recent].sort());
    expect(left).not.toContain(emptyOld);
  });

  it('is repeatable and does nothing when there is nothing to remove', async () => {
    expect(await sweep()).toEqual({
      expiredDocuments: 0,
      orphanFiles: 0,
      staleTemporaryFiles: 0,
      staleSessions: 0,
      ticketBlobs: 0,
    });
  });

  it('runs at start and on an unref-ed timer, never overlapping, and survives a failing pass', async () => {
    const logged: string[] = [];
    let calls = 0;
    const timer = startRetentionTimer(
      () => {
        calls += 1;
        if (calls === 2) return Promise.reject(new Error('database unavailable'));
        return Promise.resolve({
          expiredDocuments: 1,
          orphanFiles: 0,
          staleTemporaryFiles: 0,
          staleSessions: 0,
        });
      },
      30,
      {
        info: (_o, message) => logged.push(`info:${message}`),
        error: (_o, message) => logged.push(`error:${message}`),
      },
    );
    await timer.runNow();
    expect(calls).toBe(1); // the pass started by start-up is the one that ran: runNow joined it
    const failed = await timer.runNow();
    expect(failed).toBeNull();
    expect(logged).toEqual(['info:retention sweep removed expired data', 'error:retention sweep failed']);
    timer.stop();
  });
});
