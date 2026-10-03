import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { AppError } from '../http/errors.js';
import type { StorageProvider } from '../storage/provider.js';

/** Where the copies of documents fetched from a remote store are kept between ticks, inside TMP_DIR. */
export const INGEST_CACHE_DIRECTORY = 'ingest';
export const INGEST_CACHE_SUFFIX = '.pdf';

export interface StoredDocument {
  id: string;
  storage_key: string;
  sha256: string;
  byte_size: number;
}

const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

/** The cache of this instance is looked through at most this often (by the ticks it serves). */
const SWEEP_EVERY_MS = 60_000;
/** A half-written copy older than this is left over from a tick that died. */
const STALE_TEMPORARY_MS = 3_600_000;
const COPY_NAME = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.pdf$/u;

/**
 * The bytes of a document for the ticks of its job. Every tick needs the file again, and a tick is a separate request: a
 * remote store (Vercel Blob) is read once per instance and kept in the scratch directory (`/tmp` on Vercel: 500 MB, per
 * instance, gone when the instance is), the local disk is simply read. What comes from the store is checked against the hash
 * taken when it was uploaded.
 */
export class DocumentBytes {
  private lastSweep = 0;

  constructor(
    private readonly storage: StorageProvider,
    private readonly tmpDir: string,
  ) {}

  private cachePath(documentId: string): string {
    return path.join(this.tmpDir, INGEST_CACHE_DIRECTORY, `${documentId}${INGEST_CACHE_SUFFIX}`);
  }

  /** `signal` stops the read of the store (a store that does not answer within the time a tick has). */
  async load(document: StoredDocument, signal?: AbortSignal): Promise<Uint8Array> {
    const cacheable = this.storage.name !== 'local';
    if (cacheable) {
      const cached = await this.readCache(document);
      if (cached !== null) return cached;
    }
    const bytes = new Uint8Array(
      await this.storage.get(document.storage_key, signal === undefined ? {} : { signal }),
    );
    if (sha256(bytes) !== document.sha256) {
      throw new AppError('STORAGE_FAILED', 'The stored document does not match what was uploaded.');
    }
    if (cacheable) await this.writeCache(document.id, bytes);
    return bytes;
  }

  /** Drops the copy of a document that is done with (ready, failed or removed). */
  async forget(documentId: string): Promise<void> {
    await rm(this.cachePath(documentId), { force: true });
  }

  /**
   * The copy of the document this instance kept, when it is the file that was uploaded: the hash is checked, not only the
   * size (a document that was deleted and made again under the same id must not be served an old copy of the same size).
   */
  private async readCache(document: StoredDocument): Promise<Uint8Array | null> {
    const file = this.cachePath(document.id);
    try {
      if ((await stat(file)).size !== document.byte_size) return null;
      const bytes = new Uint8Array(await readFile(file));
      if (sha256(bytes) === document.sha256) return bytes;
      await rm(file, { force: true });
      return null;
    } catch {
      return null;
    }
  }

  /**
   * Looks through the copies this instance holds and removes those of documents that no longer exist (deleted, replaced or
   * expired on another instance, which could not reach this one's disk), and half-written ones left by a tick that died.
   * `existing` says which of the given ids still have a row. At most once a minute; never throws.
   */
  async sweep(existing: (ids: string[]) => Promise<Set<string>>, now: number = Date.now()): Promise<number> {
    if (now - this.lastSweep < SWEEP_EVERY_MS) return 0;
    this.lastSweep = now;
    const directory = path.join(this.tmpDir, INGEST_CACHE_DIRECTORY);
    let removed = 0;
    try {
      const names = await readdir(directory);
      const copies = names.flatMap((name) => {
        const id = COPY_NAME.exec(name)?.[1];
        return id === undefined ? [] : [{ id, name }];
      });
      const alive = copies.length === 0 ? new Set<string>() : await existing(copies.map((copy) => copy.id));
      for (const copy of copies) {
        if (alive.has(copy.id)) continue;
        await rm(path.join(directory, copy.name), { force: true });
        removed += 1;
      }
      for (const name of names.filter((candidate) => candidate.endsWith('.tmp'))) {
        const file = path.join(directory, name);
        if (now - (await stat(file)).mtimeMs > STALE_TEMPORARY_MS) {
          await rm(file, { force: true });
          removed += 1;
        }
      }
    } catch {
      // A directory that is not there, a file that went meanwhile: nothing to clean.
    }
    return removed;
  }

  /** A failure to cache is no failure: the next tick fetches the file again. */
  private async writeCache(documentId: string, bytes: Uint8Array): Promise<void> {
    const file = this.cachePath(documentId);
    const temporary = `${file}.${randomBytes(6).toString('hex')}.tmp`;
    try {
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(temporary, bytes, { mode: 0o600 });
      await rename(temporary, file);
    } catch {
      await rm(temporary, { force: true });
    }
  }
}
