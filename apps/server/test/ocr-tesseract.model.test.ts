import { copyFile, mkdir, readdir } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { REPO_ROOT } from '../src/config.js';
import { TesseractOcrProvider, type CreateWorker } from '../src/ocr/tesseract.js';
import { OcrUnavailableError, type OcrImage } from '../src/ocr/types.js';
import { closePdf, loadPdf } from '../src/pdf/load.js';
import { rasterizePage } from '../src/pdf/rasterize.js';
import { readFixture } from './fixtures.js';
import { nextTestDirectory } from './helpers.js';

/*
 * The optional self-hosted engine (OCR_PROVIDER=tesseract): the real tesseract.js, the WebAssembly engine, offline from
 * the prefetched packs. It needs about 0.3 GB and a minute of CPU, so it runs only where that is wanted (Kaggle, a CI
 * job): set RUN_LOCAL_OCR_TESTS=1 (and fetch the packs with `npm run models:fetch`). The default OCR is Gemini
 * (ocr-gemini.test.ts and the pipeline tests); nothing in the normal test run starts this engine.
 */
const RUN = process.env.RUN_LOCAL_OCR_TESTS === '1';
const CACHE = path.join(REPO_ROOT, '.data', 'tessdata');

let page: OcrImage;
beforeAll(async () => {
  if (!RUN) return;
  const doc = await loadPdf(new Uint8Array(await readFixture('text-en.pdf')));
  try {
    page = await rasterizePage(doc, 2, { dpi: 200 });
  } finally {
    await closePdf(doc);
  }
}, 60_000);

/** The real tesseract.js, with a record of how it was used. */
function counting(): {
  create: CreateWorker;
  created: Parameters<CreateWorker>[];
  reinitialized: string[][];
  terminated: () => number;
} {
  const created: Parameters<CreateWorker>[] = [];
  const reinitialized: string[][] = [];
  let terminated = 0;
  const create: CreateWorker = async (...args) => {
    created.push(args);
    const { createWorker } = await import('tesseract.js');
    const worker = await createWorker(...args);
    const reinitialize = worker.reinitialize.bind(worker);
    worker.reinitialize = (languages, ...rest) => {
      reinitialized.push(typeof languages === 'string' ? languages.split('+') : []);
      return reinitialize(languages, ...rest);
    };
    const terminate = worker.terminate.bind(worker);
    worker.terminate = () => {
      terminated += 1;
      return terminate();
    };
    return worker;
  };
  return { create, created, reinitialized, terminated: () => terminated };
}

const providers: TesseractOcrProvider[] = [];
const provider = (options: Partial<ConstructorParameters<typeof TesseractOcrProvider>[0]> = {}) => {
  const made = new TesseractOcrProvider({ cacheDir: CACHE, ...options });
  providers.push(made);
  return made;
};
afterEach(async () => {
  await Promise.all(providers.splice(0).map((p) => p.dispose()));
});

describe.skipIf(!RUN)('TesseractOcrProvider (real tesseract.js, offline from the prefetched packs)', () => {
  it('reads a page: text, a mean confidence, and line boxes in the pixels of the image', async () => {
    const result = await provider().recognize(page, { languages: ['eng'] });
    expect(result.languagesUsed).toEqual(['eng']);
    expect(result.confidence).toBeGreaterThan(85);
    expect(result.text).toContain('The Founding');
    expect(result.text).toContain('Alaric Thornquist');
    expect(result.lines.length).toBeGreaterThanOrEqual(8); // heading + 3 + 2 + 2 lines of paragraphs
    for (const line of result.lines) {
      expect(line.text.trim()).not.toBe('');
      expect(line.bbox.x0).toBeGreaterThanOrEqual(0);
      expect(line.bbox.y0).toBeGreaterThanOrEqual(0);
      expect(line.bbox.x1).toBeLessThanOrEqual(page.width);
      expect(line.bbox.y1).toBeLessThanOrEqual(page.height);
      expect(line.bbox.x1).toBeGreaterThan(line.bbox.x0);
      expect(line.bbox.y1).toBeGreaterThan(line.bbox.y0);
      expect(line.confidence).toBeGreaterThan(0);
    }
    // The heading "The Founding" is the first line, near the top left of the 1700 x 2200 page.
    const first = result.lines[0];
    expect(first?.text).toContain('The Founding');
    expect(first?.bbox.y0).toBeGreaterThan(150);
    expect(first?.bbox.y0).toBeLessThan(260);
    expect(first?.bbox.x0).toBeGreaterThan(150);
    expect(first?.bbox.x0).toBeLessThan(220);
  }, 60_000);

  it('creates one worker and reuses it across pages and calls', async () => {
    const spy = counting();
    const ocr = provider({ createWorker: spy.create });
    await ocr.recognize(page, { languages: ['eng'] });
    await ocr.recognize(page, { languages: ['eng'] });
    expect(spy.created).toHaveLength(1);
    expect(spy.reinitialized).toEqual([]);
  }, 60_000);

  it('points tesseract at OCR_CACHE_DIR for both language data and its cache, never at the working directory', async () => {
    const spy = counting();
    await provider({ createWorker: spy.create }).recognize(page, { languages: ['eng'] });
    const options = spy.created[0]?.[2];
    expect(options?.langPath).toBe(CACHE);
    expect(options?.cachePath).toBe(CACHE);
    expect(options?.cachePath).not.toBe('.');
    const inWorkingDirectory = (await readdir(process.cwd())).filter((name) => name.endsWith('.traineddata'));
    expect(inWorkingDirectory).toEqual([]);
  }, 60_000);

  it('re-initialises the same worker when the languages change', async () => {
    const spy = counting();
    const ocr = provider({ createWorker: spy.create });
    await ocr.recognize(page, { languages: ['eng'] });
    const arabic = await ocr.recognize(page, { languages: ['ara'] });
    await ocr.recognize(page, { languages: ['ara', 'eng'] });
    expect(spy.created).toHaveLength(1);
    expect(spy.reinitialized).toEqual([['ara'], ['ara', 'eng']]);
    expect(arabic.languagesUsed).toEqual(['ara']);
    // The wrong language reads an English page with far less confidence: this is what the language trial relies on.
    expect(arabic.confidence).toBeLessThan(60);
  }, 60_000);

  it('terminates its worker when idle and starts a new one on the next page', async () => {
    const spy = counting();
    const ocr = provider({ createWorker: spy.create, idleTimeoutMs: 300 });
    await ocr.recognize(page, { languages: ['eng'] });
    expect(spy.terminated()).toBe(0);
    await new Promise((resolve) => setTimeout(resolve, 900));
    expect(spy.terminated()).toBe(1);
    const again = await ocr.recognize(page, { languages: ['eng'] });
    expect(again.text).toContain('Founding');
    expect(spy.created).toHaveLength(2);
  }, 60_000);

  it('terminates its worker on dispose, and can be used again afterwards', async () => {
    const spy = counting();
    const ocr = provider({ createWorker: spy.create });
    await ocr.recognize(page, { languages: ['eng'] });
    await ocr.dispose();
    expect(spy.terminated()).toBe(1);
    expect((await ocr.recognize(page, { languages: ['eng'] })).text).toContain('Founding');
    expect(spy.created).toHaveLength(2);
  }, 60_000);

  it('stops at once when aborted, drops the worker, and recovers on the next call', async () => {
    const spy = counting();
    const ocr = provider({ createWorker: spy.create });
    await ocr.recognize(page, { languages: ['eng'] });
    const controller = new AbortController();
    const reading = ocr.recognize(page, { languages: ['eng'], signal: controller.signal });
    setTimeout(() => controller.abort(), 20);
    await expect(reading).rejects.toMatchObject({ name: 'AbortError' });
    expect(spy.terminated()).toBe(1);
    expect((await ocr.recognize(page, { languages: ['eng'] })).text).toContain('Founding');
    expect(spy.created).toHaveLength(2);
  }, 60_000);

  it('is available when the engine starts, and says so from a cache afterwards', async () => {
    const spy = counting();
    const ocr = provider({ createWorker: spy.create });
    expect(await ocr.isAvailable()).toBe(true);
    const started = performance.now();
    expect(await ocr.isAvailable()).toBe(true);
    expect(performance.now() - started).toBeLessThan(20);
    expect(spy.created).toHaveLength(1); // the probe's worker is the one the pages use
    await ocr.recognize(page, { languages: ['eng'] });
    expect(spy.created).toHaveLength(1);
  }, 60_000);

  it('is not available when a language pack is missing and cannot be fetched, and does not retry at once', async () => {
    const spy = counting();
    const ocr = provider({
      cacheDir: nextTestDirectory('empty-tessdata'),
      tessdataBaseUrl: 'http://127.0.0.1:9', // nothing listens here
      createWorker: spy.create,
    });
    expect(await ocr.isAvailable()).toBe(false);
    expect(await ocr.isAvailable()).toBe(false);
    expect(spy.created).toHaveLength(0);
    await expect(ocr.recognize(page, { languages: ['eng'] })).rejects.toBeInstanceOf(OcrUnavailableError);
  }, 60_000);

  it('keeps the engine it has started when one language pack is missing, so the next candidate does not pay a cold start', async () => {
    const spy = counting();
    // A scratch copy of the pack: a pack that cannot be fetched leaves a marker (`<code>.fetch-failed`) beside the
    // others, and that must never be written into the real, prefetched OCR_CACHE_DIR.
    const scratch = nextTestDirectory('tessdata-copy');
    await mkdir(scratch, { recursive: true });
    await copyFile(path.join(CACHE, 'eng.traineddata.gz'), path.join(scratch, 'eng.traineddata.gz'));
    const ocr = provider({
      cacheDir: scratch,
      createWorker: spy.create,
      tessdataBaseUrl: 'http://127.0.0.1:9', // nothing listens here: a missing pack cannot be fetched
    });
    await ocr.recognize(page, { languages: ['eng'] });
    await expect(ocr.recognize(page, { languages: ['xyz'] })).rejects.toBeInstanceOf(OcrUnavailableError);
    expect(spy.terminated()).toBe(0);
    expect((await ocr.recognize(page, { languages: ['eng'] })).text).toContain('Founding');
    expect(spy.created).toHaveLength(1);
    expect(spy.reinitialized).toEqual([]);
    expect(await readdir(CACHE)).not.toContain('xyz.fetch-failed'); // the marker went to the scratch copy
    expect(await readdir(scratch)).toContain('xyz.fetch-failed');
  }, 60_000);

  it('refuses a language that is not a pack code before starting anything', async () => {
    const spy = counting();
    await expect(
      provider({ createWorker: spy.create }).recognize(page, { languages: ['../eng'] }),
    ).rejects.toBeInstanceOf(OcrUnavailableError);
    expect(spy.created).toHaveLength(0);
  });
});
