import { createHash, randomBytes } from 'node:crypto';
import { mkdir, open, rename, rm, stat, utimes, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { ReadableStreamDefaultReader } from 'node:stream/web';
import { OcrUnavailableError } from './types.js';

/*
 * Tesseract language packs on disk. `npm run models:fetch` fills OCR_CACHE_DIR with `<code>.traineddata.gz`; a pack
 * that is missing there is fetched once, on first use, from the jsDelivr copy of the @tesseract.js-data packages (the
 * `best_int` models, the ones tesseract.js itself would fetch), so a fresh checkout works with a network. The engine is
 * always given a local directory, never a URL: tesseract.js cannot be told to stop waiting for a download, and a failed
 * pack would leave its worker hanging.
 *
 * What is fetched at run time is checked: the URL names an exact version of the package (an unpinned URL follows
 * whatever is published next), the packs of the default configuration have a size and a sha256 that must match, any
 * other pack must be a gzip file of a sane size, the body is read with a limit even when the server gives no
 * Content-Length, and a pack that could not be fetched is not asked for again for ten minutes (the marker is a file, so
 * that every OCR thread of every job sees it).
 */

export const TESSDATA_BASE_URL = 'https://cdn.jsdelivr.net/npm/@tesseract.js-data';
/** The version of each `@tesseract.js-data/<code>` package the URL names. */
export const TESSDATA_PACKAGE_VERSION = '1.0.0';
export const TESSDATA_MODEL_DIR = '4.0.0_best_int';

export interface PackFacts {
  bytes: number;
  sha256: string;
}

/** Size and checksum of the packs OCR_LANGUAGES and OCR_EXTRA_LANGUAGES name by default (version 1.0.0, best_int). */
export const KNOWN_PACKS: Readonly<Record<string, PackFacts>> = {
  ara: { bytes: 1_661_906, sha256: 'f4746c44b02342dd5b3d4f0198000f47d7c49f1a229e63e0f436c0592dcd9639' },
  deu: { bytes: 1_333_102, sha256: '306c4280d0cbed46fbff727486bd43b92730181bae80f56941a091f363bdf28b' },
  eng: { bytes: 2_952_873, sha256: '45b4cb346724ac1774f1c36f42f182b887bcdb28ebe63e6fff90ac41f3fcff91' },
  fas: { bytes: 424_507, sha256: 'b5847360e25f646c55449f1fe93eee57d53e406a265ead2374e7320bf0b82025' },
  fra: { bytes: 707_406, sha256: 'd611139672b3752c7097e671e4a1d9209dfd37f2aeb081ef6487fba3351e9255' },
  ita: { bytes: 1_660_998, sha256: 'f702fcfad297ce028ede3626d1467b67939f23ff23595f9badd54681cf25a4d3' },
  por: { bytes: 1_392_239, sha256: 'dacebc1386ddaaf8389f81094236cca0d690897cde693d48cbdaa881c86e2b4c' },
  spa: { bytes: 2_100_190, sha256: '40be52f97b5d4eb7460073dc1f94cd546b27150333c0bf854ed7e7132db6bceb' },
  tur: { bytes: 2_141_291, sha256: '384ba0dc28040451b7818d7d60e0a88df0d3003fa5a01d713a468779bc3d8c04' },
  urd: { bytes: 1_023_740, sha256: '9e1860440339543c935fca7cee2ce5ac742b1d1249c4ba5982385ce19d23096f' },
};

/** The smallest real pack is far above this; anything below is an error page or a truncated download. */
const MIN_PACK_BYTES = 100_000;
/** The largest of the language packs (Chinese, Japanese) is far below this. */
const MAX_PACK_BYTES = 64 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 60_000;
/** How long a pack that could not be fetched is left alone. */
const DEFAULT_NEGATIVE_CACHE_MS = 10 * 60_000;

const PACK_CODE = /^[a-z]{3}(_[a-z]+)?$/u;
/** Downloads in progress, so that two callers asking for the same pack cause one request. */
const inFlight = new Map<string, Promise<void>>();

export const isValidPackCode = (code: string): boolean => PACK_CODE.test(code);

export const packPath = (dir: string, code: string): string => path.join(dir, `${code}.traineddata.gz`);
const failureMarker = (dir: string, code: string): string => path.join(dir, `${code}.fetch-failed`);

export interface EnsureOptions {
  /** Where packs are fetched from (tests point it at a local server). */
  baseUrl?: string;
  /** Per pack, for the whole download. */
  timeoutMs?: number;
  /** Size and checksum of the packs that are known (tests). */
  known?: Readonly<Record<string, PackFacts>>;
  /** The largest body accepted. */
  maxBytes?: number;
  /** How long a failed fetch is remembered. */
  negativeCacheMs?: number;
}

/** True for a file that starts with the gzip magic bytes and is not tiny. */
async function isUsable(file: string): Promise<boolean> {
  let handle;
  try {
    handle = await open(file, 'r');
    const { size } = await handle.stat();
    if (size < MIN_PACK_BYTES) return false;
    const head = Buffer.alloc(2);
    await handle.read(head, 0, 2, 0);
    return head[0] === 0x1f && head[1] === 0x8b;
  } catch {
    return false;
  } finally {
    await handle?.close();
  }
}

/** Reads a response body into a buffer, giving up at once when it grows past `limit` whatever the headers said. */
async function readBounded(response: Response, limit: number): Promise<Buffer | null> {
  const reader = response.body?.getReader() as ReadableStreamDefaultReader<Uint8Array> | undefined;
  if (reader === undefined) return null;
  const parts: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    parts.push(value);
  }
  return Buffer.concat(parts);
}

/** The marker of a recent failed fetch, if there is one younger than `negativeCacheMs`. */
async function failedRecently(dir: string, code: string, negativeCacheMs: number): Promise<boolean> {
  try {
    return Date.now() - (await stat(failureMarker(dir, code))).mtimeMs < negativeCacheMs;
  } catch {
    return false;
  }
}

async function download(dir: string, code: string, options: EnsureOptions): Promise<void> {
  const base = options.baseUrl ?? TESSDATA_BASE_URL;
  const url = `${base}/${code}@${TESSDATA_PACKAGE_VERSION}/${TESSDATA_MODEL_DIR}/${code}.traineddata.gz`;
  const facts = (options.known ?? KNOWN_PACKS)[code];
  const limit = Math.min(options.maxBytes ?? MAX_PACK_BYTES, facts === undefined ? Infinity : facts.bytes);
  const reason = (why: string): OcrUnavailableError =>
    new OcrUnavailableError(
      `The OCR language pack "${code}" is missing and could not be downloaded (${why}).`,
    );

  const negativeCacheMs = options.negativeCacheMs ?? DEFAULT_NEGATIVE_CACHE_MS;
  if (await failedRecently(dir, code, negativeCacheMs)) throw reason('it failed a moment ago');

  const fail = async (why: string): Promise<never> => {
    await mkdir(dir, { recursive: true }).catch(() => undefined);
    const now = new Date();
    await writeFile(failureMarker(dir, code), '').catch(() => undefined);
    await utimes(failureMarker(dir, code), now, now).catch(() => undefined);
    throw reason(why);
  };

  let bytes: Buffer | null;
  try {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    });
    if (!response.ok) return await fail(`HTTP ${String(response.status)}`);
    bytes = await readBounded(response, limit);
  } catch (error) {
    return fail(error instanceof Error && error.name === 'TimeoutError' ? 'timed out' : 'network error');
  }
  if (bytes === null) return fail('too large');
  if (bytes.length < MIN_PACK_BYTES || bytes[0] !== 0x1f || bytes[1] !== 0x8b)
    return fail('not a language pack');
  if (
    facts !== undefined &&
    (bytes.length !== facts.bytes || createHash('sha256').update(bytes).digest('hex') !== facts.sha256)
  ) {
    return fail('it is not the expected pack');
  }

  await mkdir(dir, { recursive: true });
  const target = packPath(dir, code);
  const partial = `${target}.${randomBytes(4).toString('hex')}.part`;
  try {
    await writeFile(partial, bytes);
    await rename(partial, target);
  } catch (error) {
    await rm(partial, { force: true });
    throw new OcrUnavailableError(`The OCR language pack "${code}" could not be stored.`, { cause: error });
  }
  await rm(failureMarker(dir, code), { force: true });
}

/**
 * Makes sure every pack is in `dir` as `<code>.traineddata.gz`, fetching the missing ones. Throws OcrUnavailableError
 * (naming the pack) when one cannot be had.
 */
export async function ensureLanguagePacks(
  dir: string,
  languages: readonly string[],
  options: EnsureOptions = {},
): Promise<void> {
  for (const code of languages) {
    if (!isValidPackCode(code)) throw new OcrUnavailableError(`"${code}" is not an OCR language pack code.`);
  }
  for (const code of new Set(languages)) {
    if (await isUsable(packPath(dir, code))) continue;
    const key = packPath(dir, code);
    let pending = inFlight.get(key);
    if (pending === undefined) {
      pending = download(dir, code, options).finally(() => inFlight.delete(key));
      inFlight.set(key, pending);
    }
    await pending;
  }
}
