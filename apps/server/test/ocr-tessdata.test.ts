import { randomBytes } from 'node:crypto';
import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, utimes, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { OcrUnavailableError } from '../src/ocr/types.js';
import {
  KNOWN_PACKS,
  TESSDATA_PACKAGE_VERSION,
  ensureLanguagePacks,
  isValidPackCode,
} from '../src/ocr/tessdata.js';
import { REPO_ROOT } from '../src/config.js';
import { nextTestDirectory } from './helpers.js';

/** Random bytes do not compress: this "pack" is about 120 kB, above the size a real pack can be smaller than. */
const PACK = gzipSync(randomBytes(120_000));
/** The expected size and checksum of PACK, for tests of the verification (the real table is for the real packs). */
const PACK_FACTS = { bytes: PACK.length, sha256: createHash('sha256').update(PACK).digest('hex') };

let server: Server;
let baseUrl: string;
const requests: string[] = [];
let mode: 'ok' | 'not-found' | 'not-gzip' | 'silent' | 'endless' = 'ok';

beforeAll(async () => {
  server = createServer((request, response) => {
    requests.push(request.url ?? '');
    if (mode === 'silent') return; // never answers
    if (mode === 'endless') {
      // No Content-Length: a body of unknown size that never stops (until the client does).
      const chunk = Buffer.alloc(64 * 1024, 0x1f);
      const timer = setInterval(() => response.write(chunk), 1);
      response.on('close', () => clearInterval(timer));
      return;
    }
    if (mode === 'not-found') {
      response.statusCode = 404;
      response.end('nope');
    } else if (mode === 'not-gzip') {
      response.end(Buffer.alloc(200_000, 0x41));
    } else {
      response.end(PACK);
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const freshDirectory = (): string => nextTestDirectory('tessdata');
/** The pack files (and half-written ones) in a directory: the markers of failed fetches are not among them. */
const packFiles = async (dir: string): Promise<string[]> =>
  (await readdir(dir).catch(() => [] as string[])).filter((name) => name.includes('.traineddata.gz'));

describe('ensureLanguagePacks', () => {
  it('accepts only Tesseract pack codes (no path can be smuggled in)', () => {
    expect(['eng', 'ara', 'chi_sim', 'srp_latn'].map(isValidPackCode)).toEqual([true, true, true, true]);
    expect(['', '../eng', 'eng/../x', 'en', 'ENG', 'eng.gz', 'eng ara'].map(isValidPackCode)).toEqual(
      new Array<boolean>(7).fill(false),
    );
  });

  it('does nothing when the pack is already in the directory', async () => {
    const dir = freshDirectory();
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'eng.traineddata.gz'), PACK);
    requests.length = 0;
    await ensureLanguagePacks(dir, ['eng'], { baseUrl });
    expect(requests).toEqual([]);
  });

  it('downloads a missing pack once, however many callers ask, and leaves no partial file', async () => {
    const dir = freshDirectory();
    requests.length = 0;
    mode = 'ok';
    await Promise.all([
      ensureLanguagePacks(dir, ['ara'], { baseUrl, known: { ara: PACK_FACTS } }),
      ensureLanguagePacks(dir, ['ara'], { baseUrl, known: { ara: PACK_FACTS } }),
    ]);
    expect(requests).toEqual([`/ara@${TESSDATA_PACKAGE_VERSION}/4.0.0_best_int/ara.traineddata.gz`]);
    expect(await readdir(dir)).toEqual(['ara.traineddata.gz']);
    expect((await readFile(path.join(dir, 'ara.traineddata.gz'))).equals(PACK)).toBe(true);
  });

  it('says which pack is missing when the download fails, and stores nothing', async () => {
    const dir = freshDirectory();
    mode = 'not-found';
    const error = await ensureLanguagePacks(dir, ['fra'], { baseUrl }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(OcrUnavailableError);
    expect((error as Error).message).toContain('fra');
    expect(await packFiles(dir)).toEqual([]);
  });

  it('refuses a download that is not a gzip file', async () => {
    const dir = freshDirectory();
    mode = 'not-gzip';
    await expect(ensureLanguagePacks(dir, ['spa'], { baseUrl })).rejects.toBeInstanceOf(OcrUnavailableError);
    expect(await packFiles(dir)).toEqual([]);
  });

  it('gives up on a server that never answers', async () => {
    const dir = freshDirectory();
    mode = 'silent';
    const started = Date.now();
    await expect(ensureLanguagePacks(dir, ['deu'], { baseUrl, timeoutMs: 300 })).rejects.toBeInstanceOf(
      OcrUnavailableError,
    );
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it('rejects a bad code before touching the disk or the network', async () => {
    const dir = freshDirectory();
    requests.length = 0;
    await expect(ensureLanguagePacks(dir, ['../../etc/passwd'], { baseUrl })).rejects.toBeInstanceOf(
      OcrUnavailableError,
    );
    expect(requests).toEqual([]);
    expect(await readdir(dir).catch(() => 'absent')).toBe('absent');
  });

  it('pins the package version in the URL, so a new release of the data cannot change what is fetched', () => {
    expect(TESSDATA_PACKAGE_VERSION).toMatch(/^\d+\.\d+\.\d+$/u);
  });

  it('knows the size and checksum of the packs of the default configuration', () => {
    expect(Object.keys(KNOWN_PACKS).sort()).toEqual([
      'ara',
      'deu',
      'eng',
      'fas',
      'fra',
      'ita',
      'por',
      'spa',
      'tur',
      'urd',
    ]);
    for (const facts of Object.values(KNOWN_PACKS)) {
      expect(facts.sha256).toMatch(/^[0-9a-f]{64}$/u);
      expect(facts.bytes).toBeGreaterThan(100_000);
    }
  });

  it('has the real size and checksum of every pack that `npm run models:fetch` put in OCR_CACHE_DIR', async () => {
    for (const [code, facts] of Object.entries(KNOWN_PACKS)) {
      const file = path.join(REPO_ROOT, '.data', 'tessdata', `${code}.traineddata.gz`);
      const bytes = await readFile(file).catch(() => null);
      if (bytes === null) continue; // not fetched on this machine
      expect({ code, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }).toEqual(
        {
          code,
          ...facts,
        },
      );
    }
  });

  it('refuses a download whose checksum is not the one it knows, however well it looks like a pack', async () => {
    const dir = freshDirectory();
    mode = 'ok';
    // PACK is a valid gzip file of the right order of size, but not the pack the table says "fra" is.
    await expect(ensureLanguagePacks(dir, ['fra'], { baseUrl })).rejects.toBeInstanceOf(OcrUnavailableError);
    expect(await packFiles(dir)).toEqual([]);
  });

  it('accepts a download that matches what is known about it, and one of an unknown pack within the size bounds', async () => {
    const known = freshDirectory();
    mode = 'ok';
    await ensureLanguagePacks(known, ['fra'], { baseUrl, known: { fra: PACK_FACTS } });
    expect((await readFile(path.join(known, 'fra.traineddata.gz'))).equals(PACK)).toBe(true);
    const unknown = freshDirectory();
    await ensureLanguagePacks(unknown, ['rus'], { baseUrl, known: {} });
    expect((await readdir(unknown)).sort()).toEqual(['rus.traineddata.gz']);
  });

  it('stops reading a body that has no Content-Length and never ends, at the size limit', async () => {
    const dir = freshDirectory();
    mode = 'endless';
    const started = Date.now();
    await expect(
      ensureLanguagePacks(dir, ['rus'], { baseUrl, known: {}, maxBytes: 300_000, timeoutMs: 20_000 }),
    ).rejects.toBeInstanceOf(OcrUnavailableError);
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(await packFiles(dir)).toEqual([]);
  });

  it('does not ask again for a pack that could not be fetched until a while has passed', async () => {
    const dir = freshDirectory();
    mode = 'not-found';
    requests.length = 0;
    await expect(ensureLanguagePacks(dir, ['fra'], { baseUrl, known: {} })).rejects.toBeInstanceOf(
      OcrUnavailableError,
    );
    expect(requests).toHaveLength(1);
    // The next caller (another OCR thread, a minute later) is told so without a request.
    const again = await ensureLanguagePacks(dir, ['fra'], { baseUrl, known: {} }).catch((e: unknown) => e);
    expect((again as Error).message).toContain('fra');
    expect(requests).toHaveLength(1);
    // After the pause it tries again, and succeeds when the pack is there.
    const marker = path.join(dir, 'fra.fetch-failed');
    const old = new Date(Date.now() - 3_600_000);
    await utimes(marker, old, old);
    mode = 'ok';
    await ensureLanguagePacks(dir, ['fra'], { baseUrl, known: { fra: PACK_FACTS } });
    expect(requests).toHaveLength(2);
    expect(await readdir(dir)).toEqual(['fra.traineddata.gz']); // the marker is gone
  });
});
