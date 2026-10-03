import type { Readable } from 'node:stream';

/** Server-generated key of an uploaded PDF: a UUID plus ".pdf". Nothing else is ever a valid key. */
export const STORAGE_KEY_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.pdf$/;

export function isStorageKey(value: string): boolean {
  return STORAGE_KEY_PATTERN.test(value);
}

export interface StoredObject {
  key: string;
  size: number;
  /** Last modification time: orphan detection uses it. */
  mtime: Date;
  /** A half-written file left by a crashed upload (never a valid key). */
  temporary: boolean;
}

export type StorageErrorKind = 'INVALID_KEY' | 'NOT_FOUND' | 'IO';

/** A storage failure. `message` is safe to log; callers map it to STORAGE_FAILED for clients. */
export class StorageError extends Error {
  readonly kind: StorageErrorKind;

  constructor(kind: StorageErrorKind, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'StorageError';
    this.kind = kind;
  }
}

/**
 * Where uploaded PDFs live. The local-disk implementation is the only one today; the interface is what an
 * object store (S3, R2) would implement. Keys are opaque server-generated names, never user input.
 */
export interface StorageProvider {
  readonly name: string;
  /** Stores `data` under `key`, atomically: readers see the complete file or none. Returns the size in bytes. */
  put(key: string, data: Readable | Uint8Array): Promise<{ size: number }>;
  /**
   * The whole object. Throws StorageError('NOT_FOUND') when there is none. `signal` stops a read that is under way (a store
   * that does not answer); a store on the local disk has nothing to wait for and ignores it.
   */
  get(key: string, options?: { signal?: AbortSignal }): Promise<Buffer>;
  /** A stream of the object; it errors with a StorageError when the object does not exist. */
  createReadStream(key: string): Readable;
  /** Size and modification time, or null when there is no such object. */
  stat(key: string): Promise<{ size: number; mtime: Date } | null>;
  /** Removes the object; removing one that does not exist is not an error. */
  delete(key: string): Promise<void>;
  /** Every object, with its modification time. */
  list(): Promise<StoredObject[]>;
  /** Removes a half-written file that `list()` reported as temporary. A store without such files does nothing. */
  deleteTemporary(name: string): Promise<void>;
}
