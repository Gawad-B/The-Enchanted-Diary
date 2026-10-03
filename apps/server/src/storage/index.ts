import type { Config } from '../config.js';
import { LocalDiskStorage } from './local-disk.js';
import type { StorageProvider } from './provider.js';
import { VercelBlobStorage, type BlobClient } from './vercel-blob.js';

export type { StorageProvider } from './provider.js';

/**
 * The storage the configuration asks for: the local disk (development, tests, a server of your own) or a private Vercel
 * Blob store. The Blob SDK is loaded only when it is used, and `blob` replaces it (tests).
 */
export async function createStorage(
  config: Pick<Config, 'storageProvider' | 'storageDir' | 'blobReadWriteToken'>,
  blob?: BlobClient,
): Promise<StorageProvider> {
  if (config.storageProvider === 'local') return new LocalDiskStorage(config.storageDir);
  return new VercelBlobStorage({
    token: config.blobReadWriteToken,
    client: blob ?? (await import('@vercel/blob')),
  });
}
