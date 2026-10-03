import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, stat, utimes, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { DocumentBytes, INGEST_CACHE_DIRECTORY } from '../src/ingest/bytes.js';
import { LocalDiskStorage } from '../src/storage/local-disk.js';
import { VercelBlobStorage } from '../src/storage/vercel-blob.js';
import { FakeBlobStore } from './doubles/fake-blob.js';
import { nextTestDirectory } from './helpers.js';

const BYTES = Buffer.from('%PDF-1.7\nthe bytes of a pretend document\n');
const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

function setup(): {
  store: FakeBlobStore;
  bytes: DocumentBytes;
  tmpDir: string;
  document: { id: string; storage_key: string; sha256: string; byte_size: number };
} {
  const store = new FakeBlobStore();
  const tmpDir = nextTestDirectory('bytes');
  const id = randomUUID();
  store.upload(`${id}.pdf`, BYTES);
  const storage = new VercelBlobStorage({ client: store.client });
  return {
    store,
    tmpDir,
    bytes: new DocumentBytes(storage, tmpDir),
    document: { id, storage_key: `${id}.pdf`, sha256: sha256(BYTES), byte_size: BYTES.length },
  };
}

describe('DocumentBytes', () => {
  it('reads a document from a remote store once and keeps a copy for the ticks that follow', async () => {
    const { store, bytes, tmpDir, document } = setup();
    expect(Buffer.from(await bytes.load(document)).equals(BYTES)).toBe(true);
    expect(Buffer.from(await bytes.load(document)).equals(BYTES)).toBe(true);
    expect(Buffer.from(await bytes.load(document)).equals(BYTES)).toBe(true);
    expect(store.callsTo('get')).toHaveLength(1);
    expect(await readdir(path.join(tmpDir, INGEST_CACHE_DIRECTORY))).toEqual([`${document.id}.pdf`]);
    expect(
      (await readFile(path.join(tmpDir, INGEST_CACHE_DIRECTORY, `${document.id}.pdf`))).equals(BYTES),
    ).toBe(true);
  });

  it('forgets the copy when the document is done with, and fetches again if it is needed after all', async () => {
    const { store, bytes, tmpDir, document } = setup();
    await bytes.load(document);
    await bytes.forget(document.id);
    expect(await readdir(path.join(tmpDir, INGEST_CACHE_DIRECTORY))).toEqual([]);
    await bytes.forget(document.id); // forgetting what is not there is nothing
    await bytes.load(document);
    expect(store.callsTo('get')).toHaveLength(2);
  });

  it('does not trust a copy of the wrong size (a partial write, a leftover): the store is asked again', async () => {
    const { store, bytes, tmpDir, document } = setup();
    await mkdir(path.join(tmpDir, INGEST_CACHE_DIRECTORY), { recursive: true });
    await writeFile(path.join(tmpDir, INGEST_CACHE_DIRECTORY, `${document.id}.pdf`), BYTES.subarray(0, 5));
    expect(Buffer.from(await bytes.load(document)).equals(BYTES)).toBe(true);
    expect(store.callsTo('get')).toHaveLength(1);
    expect((await stat(path.join(tmpDir, INGEST_CACHE_DIRECTORY, `${document.id}.pdf`))).size).toBe(
      BYTES.length,
    );
  });

  it('does not serve a copy of the same size that is not the document (made again under the same id): the hash is checked, not only the size', async () => {
    const { store, bytes, tmpDir, document } = setup();
    await mkdir(path.join(tmpDir, INGEST_CACHE_DIRECTORY), { recursive: true });
    const stale = Buffer.from('%PDF-1.7\nan old copy, same length, other text\n'.slice(0, BYTES.length));
    expect(stale.length).toBe(BYTES.length);
    await writeFile(path.join(tmpDir, INGEST_CACHE_DIRECTORY, `${document.id}.pdf`), stale);
    expect(Buffer.from(await bytes.load(document)).equals(BYTES)).toBe(true); // what the store has, not the old copy
    expect(store.callsTo('get')).toHaveLength(1);
    expect(
      (await readFile(path.join(tmpDir, INGEST_CACHE_DIRECTORY, `${document.id}.pdf`))).equals(BYTES),
    ).toBe(true);
  });

  it('sweeps the copies of documents that are gone (deleted on another instance) and half-written ones, at most once a minute', async () => {
    const { bytes, tmpDir, document } = setup();
    const directory = path.join(tmpDir, INGEST_CACHE_DIRECTORY);
    await mkdir(directory, { recursive: true });
    const gone = randomUUID();
    const kept = randomUUID();
    await writeFile(path.join(directory, `${gone}.pdf`), BYTES);
    await writeFile(path.join(directory, `${kept}.pdf`), BYTES);
    await writeFile(path.join(directory, `${document.id}.pdf`), BYTES);
    await writeFile(path.join(directory, 'notes.txt'), 'not ours'); // never touched
    const old = path.join(directory, `${randomUUID()}.pdf.abc123.tmp`);
    await writeFile(old, 'half');
    const past = new Date(Date.now() - 2 * 3_600_000);
    await utimes(old, past, past);

    const exists = (ids: string[]): Promise<Set<string>> =>
      Promise.resolve(new Set(ids.filter((id) => id !== gone)));
    const now = Date.now();
    expect(await bytes.sweep(exists, now)).toBe(2); // the copy of the document that is gone, and the old half-written one
    expect((await readdir(directory)).sort()).toEqual(
      [`${document.id}.pdf`, `${kept}.pdf`, 'notes.txt'].sort(),
    );
    // Looked at a moment ago: not again for a minute.
    await writeFile(path.join(directory, `${gone}.pdf`), BYTES);
    expect(await bytes.sweep(exists, now + 10_000)).toBe(0);
    expect(await bytes.sweep(exists, now + 61_000)).toBe(1);
  });

  it('checks what the store gives against the hash taken at upload, and keeps nothing that does not match', async () => {
    const { store, bytes, tmpDir, document } = setup();
    store.upload(
      document.storage_key,
      Buffer.from('%PDF-1.7\nsomething else of the very same length!\n'.slice(0, BYTES.length)),
    );
    await expect(bytes.load(document)).rejects.toMatchObject({
      code: 'STORAGE_FAILED',
      message: 'The stored document does not match what was uploaded.',
    });
    expect(await readdir(path.join(tmpDir, INGEST_CACHE_DIRECTORY)).catch(() => [])).toEqual([]);
  });

  it('reads the local disk directly, with the same check, and makes no copy', async () => {
    const directory = nextTestDirectory('local-storage');
    const storage = new LocalDiskStorage(directory);
    const id = randomUUID();
    await storage.put(`${id}.pdf`, BYTES);
    const tmpDir = nextTestDirectory('bytes-local');
    const bytes = new DocumentBytes(storage, tmpDir);
    const document = { id, storage_key: `${id}.pdf`, sha256: sha256(BYTES), byte_size: BYTES.length };
    expect(Buffer.from(await bytes.load(document)).equals(BYTES)).toBe(true);
    expect(await readdir(tmpDir).catch(() => [])).toEqual([]);
    await expect(bytes.load({ ...document, sha256: 'f'.repeat(64) })).rejects.toMatchObject({
      code: 'STORAGE_FAILED',
    });
  });
});
