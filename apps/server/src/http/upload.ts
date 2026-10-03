import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, open, unlink } from 'node:fs/promises';
import path from 'node:path';
import { Transform, type Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { AppError } from './errors.js';

/** How far into the file `%PDF-` may appear (the PDF specification allows junk before the header). */
const MAGIC_WINDOW_BYTES = 1024;

export interface ScratchUpload {
  path: string;
  size: number;
  sha256: string;
}

/**
 * Streams an upload into a scratch file while counting its bytes and hashing it (sha256). Nothing is held in
 * memory. A stream longer than `limitBytes` aborts with FILE_TOO_LARGE; the partial file is removed on any
 * failure, and the caller removes the finished one when it is done with it.
 */
export async function streamToScratch(
  source: Readable,
  directory: string,
  name: string,
  limitBytes: number,
): Promise<ScratchUpload> {
  await mkdir(directory, { recursive: true });
  const target = path.join(directory, name);
  const hash = createHash('sha256');
  let size = 0;
  const meter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      size += chunk.length;
      if (size > limitBytes) {
        callback(
          new AppError(
            'FILE_TOO_LARGE',
            'The file is larger than the maximum upload size.',
            `limit is ${String(limitBytes)} bytes`,
          ),
        );
        return;
      }
      hash.update(chunk);
      callback(null, chunk);
    },
  });
  try {
    await pipeline(source, meter, createWriteStream(target, { flags: 'wx', mode: 0o600 }));
  } catch (error) {
    await unlink(target).catch(() => undefined);
    throw error;
  }
  return { path: target, size, sha256: hash.digest('hex') };
}

/** True when `%PDF-` appears within the first 1024 bytes of the file. */
export async function hasPdfHeader(file: string): Promise<boolean> {
  const handle = await open(file, 'r');
  try {
    const buffer = Buffer.alloc(MAGIC_WINDOW_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, MAGIC_WINDOW_BYTES, 0);
    return buffer.subarray(0, bytesRead).includes('%PDF-', 0, 'latin1');
  } finally {
    await handle.close();
  }
}
