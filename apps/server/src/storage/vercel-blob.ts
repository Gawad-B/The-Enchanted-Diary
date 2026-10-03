import { Readable } from 'node:stream';
import type * as BlobSdk from '@vercel/blob';
import { StorageError, isStorageKey, type StorageProvider, type StoredObject } from './provider.js';

/**
 * The part of `@vercel/blob` this provider uses: the boundary a test replaces. `BlobNotFoundError` is the SDK's own class:
 * its instances all have the name "Error" (the SDK sets no name), so a missing blob is recognised by `instanceof`, never by name.
 */
export type BlobClient = Pick<typeof BlobSdk, 'get' | 'head' | 'put' | 'del' | 'list' | 'BlobNotFoundError'>;

export interface VercelBlobOptions {
  /** BLOB_READ_WRITE_TOKEN. Without it the SDK looks for the credentials of the Vercel runtime itself. */
  token?: string | null;
  client: BlobClient;
}

/** Page size of a listing (the SDK's own default is 1000). */
const LIST_PAGE = 1000;

/**
 * PDFs in a PRIVATE Vercel Blob store: nothing here has a public URL, every read goes through the server (and so through the
 * session check). Keys are the same `<uuid>.pdf` names the local disk uses; they are the pathnames of the blobs (a browser
 * uploads straight to the store under the pathname the server chose, so `put` is only used by the direct upload path).
 */
export class VercelBlobStorage implements StorageProvider {
  readonly name = 'vercel-blob';
  private readonly client: BlobClient;
  private readonly token: { token: string } | Record<string, never>;

  constructor(options: VercelBlobOptions) {
    this.client = options.client;
    this.token = options.token ? { token: options.token } : {};
  }

  private checked(key: string): string {
    if (!isStorageKey(key)) throw new StorageError('INVALID_KEY', 'The storage key is not valid');
    return key;
  }

  private isNotFound(error: unknown): boolean {
    return error instanceof this.client.BlobNotFoundError;
  }

  private toStorageError(error: unknown): StorageError {
    if (error instanceof StorageError) return error;
    if (this.isNotFound(error)) {
      return new StorageError('NOT_FOUND', 'The stored file does not exist', { cause: error });
    }
    return new StorageError('IO', 'The stored file could not be read', { cause: error });
  }

  async put(key: string, data: Readable | Uint8Array): Promise<{ size: number }> {
    const pathname = this.checked(key);
    try {
      const body = data instanceof Uint8Array ? Buffer.from(data) : data;
      await this.client.put(pathname, body, {
        access: 'private',
        contentType: 'application/pdf',
        addRandomSuffix: false,
        // A key is a fresh uuid: nothing of anyone else's is ever overwritten.
        allowOverwrite: false,
        // One operation, not the three or more of a multipart upload: a file is at most MAX_UPLOAD_MB (20 by default).
        multipart: false,
        ...this.token,
      });
      const stored = await this.client.head(pathname, this.token);
      return { size: stored.size };
    } catch (error) {
      throw new StorageError('IO', 'The file could not be written', { cause: error });
    }
  }

  async get(key: string, options: { signal?: AbortSignal } = {}): Promise<Buffer> {
    const stream = this.createReadStream(key, options);
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(chunk as Buffer);
    return Buffer.concat(chunks);
  }

  /**
   * A stream of the blob. Nothing is requested until the consumer starts to read (so an error can never be raised before the
   * consumer has attached its listener), a missing blob is a StorageError('NOT_FOUND') on the stream, like with the local disk,
   * and the request is cancelled when the stream is closed early.
   */
  createReadStream(key: string, options: { signal?: AbortSignal } = {}): Readable {
    const pathname = this.checked(key);
    const abort = new AbortController();
    const signal =
      options.signal === undefined ? abort.signal : AbortSignal.any([abort.signal, options.signal]);
    const stream = Readable.from(this.chunksOf(pathname, signal), { objectMode: false });
    stream.once('close', () => {
      abort.abort();
    });
    return stream;
  }

  private async *chunksOf(pathname: string, signal: AbortSignal): AsyncGenerator<Buffer> {
    let result: Awaited<ReturnType<BlobClient['get']>>;
    try {
      result = await this.client.get(pathname, {
        access: 'private',
        useCache: false,
        abortSignal: signal,
        ...this.token,
      });
    } catch (error) {
      throw this.toStorageError(error);
    }
    if (result?.statusCode !== 200) throw new StorageError('NOT_FOUND', 'The stored file does not exist');
    try {
      for await (const chunk of Readable.fromWeb(result.stream as Parameters<typeof Readable.fromWeb>[0])) {
        yield chunk as Buffer;
      }
    } catch (error) {
      throw this.toStorageError(error);
    }
  }

  async stat(key: string): Promise<{ size: number; mtime: Date } | null> {
    const pathname = this.checked(key);
    try {
      const info = await this.client.head(pathname, this.token);
      return { size: info.size, mtime: info.uploadedAt };
    } catch (error) {
      if (this.isNotFound(error)) return null;
      throw this.toStorageError(error);
    }
  }

  async delete(key: string): Promise<void> {
    const pathname = this.checked(key);
    try {
      await this.client.del(pathname, this.token);
    } catch (error) {
      if (!this.isNotFound(error)) throw this.toStorageError(error);
    }
  }

  /** Every blob this server could have written (a `<uuid>.pdf` pathname); other pathnames are never reported, never touched. */
  async list(): Promise<StoredObject[]> {
    const objects: StoredObject[] = [];
    let cursor: string | undefined;
    try {
      do {
        const page = await this.client.list({
          limit: LIST_PAGE,
          ...(cursor === undefined ? {} : { cursor }),
          ...this.token,
        });
        for (const blob of page.blobs) {
          if (isStorageKey(blob.pathname)) {
            objects.push({ key: blob.pathname, size: blob.size, mtime: blob.uploadedAt, temporary: false });
          }
        }
        cursor = page.hasMore ? page.cursor : undefined;
      } while (cursor !== undefined);
    } catch (error) {
      throw this.toStorageError(error);
    }
    return objects;
  }

  /** A blob store has no half-written files. */
  deleteTemporary(): Promise<void> {
    return Promise.resolve();
  }
}
