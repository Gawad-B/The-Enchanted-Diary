import { randomBytes } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, open, readFile, readdir, rename, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Readable } from 'node:stream';
import { PassThrough } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { StorageError, isStorageKey, type StorageProvider, type StoredObject } from './provider.js';

const TEMP_PREFIX = '.';
const TEMP_SUFFIX = '.tmp';
const FILE_MODE = 0o600;

const isTemporaryName = (name: string): boolean => name.startsWith(TEMP_PREFIX) && name.endsWith(TEMP_SUFFIX);

/**
 * Stores objects as files in one directory. Keys must be `<uuid>.pdf`; the resolved path is checked to be inside
 * the directory as well, so a path-traversal key (`../x.pdf`, an absolute path, a NUL byte) can never reach the
 * disk. Writes go to a temporary file in the same directory and are renamed into place.
 */
export class LocalDiskStorage implements StorageProvider {
  readonly name = 'local';
  readonly directory: string;
  private ready: Promise<void> | null = null;

  constructor(directory: string) {
    this.directory = path.resolve(directory);
  }

  private ensureDirectory(): Promise<void> {
    this.ready ??= mkdir(this.directory, { recursive: true }).then(() => undefined);
    return this.ready;
  }

  /** The absolute path of a key. Throws StorageError('INVALID_KEY') for anything that is not a plain key. */
  private resolveKey(key: string): string {
    if (!isStorageKey(key)) throw new StorageError('INVALID_KEY', 'The storage key is not valid');
    const resolved = path.resolve(this.directory, key);
    if (path.dirname(resolved) !== this.directory)
      throw new StorageError('INVALID_KEY', 'The storage key leaves the storage directory');
    return resolved;
  }

  async put(key: string, data: Readable | Uint8Array): Promise<{ size: number }> {
    const target = this.resolveKey(key);
    await this.ensureDirectory();
    const temporary = path.join(
      this.directory,
      `${TEMP_PREFIX}${key}.${randomBytes(6).toString('hex')}${TEMP_SUFFIX}`,
    );
    try {
      if (data instanceof Uint8Array) {
        await writeFile(temporary, data, { flag: 'wx', mode: FILE_MODE });
      } else {
        await pipeline(data, createWriteStream(temporary, { flags: 'wx', mode: FILE_MODE }));
      }
      const handle = await open(temporary, 'r');
      try {
        await handle.sync();
      } finally {
        await handle.close();
      }
      const { size } = await stat(temporary);
      await rename(temporary, target);
      return { size };
    } catch (error) {
      await unlink(temporary).catch(() => undefined);
      throw new StorageError('IO', 'The file could not be written', { cause: error });
    }
  }

  async get(key: string): Promise<Buffer> {
    const target = this.resolveKey(key);
    try {
      return await readFile(target);
    } catch (error) {
      throw toStorageError(error);
    }
  }

  createReadStream(key: string): Readable {
    const target = this.resolveKey(key);
    // A missing file surfaces as a StorageError on the returned stream, not as a raw ENOENT with a path in it.
    const output = new PassThrough();
    const source = createReadStream(target);
    source.on('error', (error) => output.destroy(toStorageError(error)));
    output.on('close', () => source.destroy());
    source.pipe(output);
    return output;
  }

  async stat(key: string): Promise<{ size: number; mtime: Date } | null> {
    const target = this.resolveKey(key);
    try {
      const info = await stat(target);
      return { size: info.size, mtime: info.mtime };
    } catch (error) {
      if (isNotFound(error)) return null;
      throw toStorageError(error);
    }
  }

  async delete(key: string): Promise<void> {
    const target = this.resolveKey(key);
    try {
      await unlink(target);
    } catch (error) {
      if (!isNotFound(error)) throw toStorageError(error);
    }
  }

  async list(): Promise<StoredObject[]> {
    await this.ensureDirectory();
    const objects: StoredObject[] = [];
    for (const entry of await readdir(this.directory, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      const temporary = isTemporaryName(entry.name);
      if (!temporary && !isStorageKey(entry.name)) continue; // never touch files this storage did not write
      try {
        const info = await stat(path.join(this.directory, entry.name));
        objects.push({ key: entry.name, size: info.size, mtime: info.mtime, temporary });
      } catch (error) {
        if (!isNotFound(error)) throw toStorageError(error);
      }
    }
    return objects;
  }

  /** Removes a half-written file by its name (used by the retention sweep). Only names `list()` reported. */
  async deleteTemporary(name: string): Promise<void> {
    if (!isTemporaryName(name) || name.includes('/') || name.includes('\\') || name.includes('\0')) {
      throw new StorageError('INVALID_KEY', 'Not a temporary file name');
    }
    await unlink(path.join(this.directory, name)).catch((error: unknown) => {
      if (!isNotFound(error)) throw toStorageError(error);
    });
  }
}

function isNotFound(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}

function toStorageError(error: unknown): StorageError {
  if (error instanceof StorageError) return error;
  if (isNotFound(error))
    return new StorageError('NOT_FOUND', 'The stored file does not exist', { cause: error });
  return new StorageError('IO', 'The stored file could not be read', { cause: error });
}
