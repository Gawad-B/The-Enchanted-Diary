import { Readable } from 'node:stream';
import { BlobError, BlobNotFoundError } from '@vercel/blob';
import type { BlobClient } from '../../src/storage/vercel-blob.js';

/** What the stand-in for the Blob SDK was asked, for a test to look at. */
export interface BlobCall {
  method: 'get' | 'head' | 'put' | 'del' | 'list';
  /** The pathname, or the prefix of a listing. */
  target: string;
  options: Record<string, unknown>;
}

interface StoredBlob {
  bytes: Buffer;
  contentType: string;
  uploadedAt: Date;
}

/**
 * An in-memory stand-in for the `@vercel/blob` SDK (the boundary of VercelBlobStorage): a private store that keeps what is put
 * in it, answers like the real SDK (the SDK's own `BlobNotFoundError` class, whose instances are named "Error", for a missing
 * blob in `head`; `null` from `get`; a `BlobError` for a `put` over an existing blob without `allowOverwrite`), pages its
 * listings, and remembers every call and its options. It refuses anything that is not `access: 'private'`. Test code only.
 */
export class FakeBlobStore {
  readonly blobs = new Map<string, StoredBlob>();
  readonly calls: BlobCall[] = [];
  /** Listings return this many blobs a page (to test pagination). */
  pageSize = 1000;
  /** Runs when `head` is called, before it answers (a test makes something happen in the middle of a request). */
  onHead: (() => Promise<void>) | undefined;
  private readonly failures = new Map<BlobCall['method'], number>();

  /** The next `times` calls of `method` fail the way a dropped connection does (an error that is not the SDK's). */
  failNext(method: BlobCall['method'], times = 1): void {
    this.failures.set(method, times);
  }

  private maybeFail(method: BlobCall['method']): void {
    const left = this.failures.get(method) ?? 0;
    if (left <= 0) return;
    this.failures.set(method, left - 1);
    throw new Error('fetch failed');
  }

  /** What a browser's `upload()` does once it has a token: the blob is in the store under its pathname. */
  upload(pathname: string, bytes: Uint8Array, contentType = 'application/pdf'): void {
    this.blobs.set(pathname, { bytes: Buffer.from(bytes), contentType, uploadedAt: new Date() });
  }

  callsTo(method: BlobCall['method']): BlobCall[] {
    return this.calls.filter((call) => call.method === method);
  }

  private notFound(): Error {
    return new BlobNotFoundError();
  }

  private record(
    method: BlobCall['method'],
    target: string,
    options: Record<string, unknown> | undefined,
  ): void {
    this.calls.push({ method, target, options: options ?? {} });
  }

  private requirePrivate(options: Record<string, unknown> | undefined): void {
    if (options?.access !== 'private') throw new Error('the fake store only holds private blobs');
  }

  readonly client = {
    put: async (pathname: string, body: unknown, options: Record<string, unknown>) => {
      this.record('put', pathname, options);
      this.requirePrivate(options);
      this.maybeFail('put');
      if (this.blobs.has(pathname) && options.allowOverwrite !== true) {
        throw new BlobError('This blob already exists, use `allowOverwrite: true` option to overwrite it');
      }
      const chunks: Buffer[] = [];
      if (body instanceof Readable) for await (const chunk of body) chunks.push(Buffer.from(chunk as Buffer));
      else chunks.push(Buffer.from(body as Uint8Array));
      const bytes = Buffer.concat(chunks);
      this.blobs.set(pathname, {
        bytes,
        contentType:
          typeof options.contentType === 'string' ? options.contentType : 'application/octet-stream',
        uploadedAt: new Date(),
      });
      return { pathname, url: `https://store.private.blob.vercel-storage.com/${pathname}` };
    },
    head: async (pathname: string, options?: Record<string, unknown>) => {
      this.record('head', pathname, options);
      await this.onHead?.();
      this.maybeFail('head');
      const stored = this.blobs.get(pathname);
      if (stored === undefined) throw this.notFound();
      return {
        size: stored.bytes.length,
        uploadedAt: stored.uploadedAt,
        pathname,
        contentType: stored.contentType,
      };
    },
    get: (pathname: string, options: Record<string, unknown>) => {
      this.record('get', pathname, options);
      this.requirePrivate(options);
      try {
        this.maybeFail('get');
      } catch (error) {
        return Promise.reject(error instanceof Error ? error : new Error('fetch failed'));
      }
      const stored = this.blobs.get(pathname);
      if (stored === undefined) return Promise.resolve(null);
      return Promise.resolve({
        statusCode: 200 as const,
        stream: new Blob([stored.bytes]).stream(),
        headers: new Headers(),
        blob: {
          pathname,
          size: stored.bytes.length,
          contentType: stored.contentType,
          uploadedAt: stored.uploadedAt,
        },
      });
    },
    BlobNotFoundError,
    del: (pathname: string | string[], options?: Record<string, unknown>) => {
      for (const one of Array.isArray(pathname) ? pathname : [pathname]) {
        this.record('del', one, options);
        this.blobs.delete(one);
      }
      return Promise.resolve();
    },
    list: (options: { prefix?: string; cursor?: string; limit?: number } & Record<string, unknown> = {}) => {
      this.record('list', options.prefix ?? '', options);
      const all = [...this.blobs.entries()].sort(([a], [b]) => a.localeCompare(b));
      const start = options.cursor === undefined ? 0 : Number(options.cursor);
      const page = all.slice(start, start + Math.min(this.pageSize, options.limit ?? 1000));
      const next = start + page.length;
      return Promise.resolve({
        blobs: page.map(([pathname, stored]) => ({
          pathname,
          url: `https://store.private.blob.vercel-storage.com/${pathname}`,
          downloadUrl: '',
          size: stored.bytes.length,
          uploadedAt: stored.uploadedAt,
          etag: '',
        })),
        hasMore: next < all.length,
        ...(next < all.length ? { cursor: String(next) } : {}),
      });
    },
  } as unknown as BlobClient;
}
