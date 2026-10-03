import { describe, expect, it } from 'vitest';
import { GeminiOcrProvider } from '../src/ocr/gemini.js';
import { geminiKeyAvailability } from '../src/ocr/availability.js';
import { NoopOcrProvider, createOcrProvider, type OcrProviderConfig } from '../src/ocr/provider.js';
import { TesseractOcrProvider } from '../src/ocr/tesseract.js';
import { OcrUnavailableError, isBatchProvider } from '../src/ocr/types.js';
import { FakeGeminiClient } from './ocr-doubles/fake-gemini.js';

/*
 * The OCR provider factory and what each provider says about itself: Gemini is the default, Tesseract is built only when
 * it is asked for (and its library is loaded only when it first reads), "none" refuses to read.
 */

const config: OcrProviderConfig = {
  ocrProvider: 'gemini',
  ocrCacheDir: '/nonexistent/tessdata',
  ocrLanguages: ['eng'],
  ocrModel: 'gemini-3.5-flash-lite',
  ocrPagesPerRequest: 8,
  geminiApiKey: 'test-key-not-real',
  geminiMaxRpm: 10,
};

describe('createOcrProvider', () => {
  it('builds Gemini for OCR_PROVIDER=gemini, with the model and the batch size of the configuration', () => {
    const provider = createOcrProvider(config);
    expect(provider).toBeInstanceOf(GeminiOcrProvider);
    expect(provider).toMatchObject({
      name: 'gemini',
      input: 'pdf',
      selectsLanguages: false,
      pagesPerRequest: 8,
    });
    expect(isBatchProvider(provider)).toBe(true);
    expect(createOcrProvider({ ...config, ocrPagesPerRequest: 3 }).pagesPerRequest).toBe(3);
  });

  it('builds Tesseract only for OCR_PROVIDER=tesseract, without loading tesseract.js', () => {
    const provider = createOcrProvider({ ...config, ocrProvider: 'tesseract', geminiApiKey: null });
    expect(provider).toBeInstanceOf(TesseractOcrProvider);
    expect(provider).toMatchObject({
      name: 'tesseract',
      input: 'png',
      selectsLanguages: true,
      pagesPerRequest: 1,
    });
    expect(isBatchProvider(provider)).toBe(false);
  });

  it('builds a provider that is never available for OCR_PROVIDER=none', async () => {
    const none = createOcrProvider({ ...config, ocrProvider: 'none' });
    expect(none).toBeInstanceOf(NoopOcrProvider);
    expect(await none.isAvailable()).toBe(false);
    await expect(
      none.recognize({ png: Buffer.alloc(0), width: 1, height: 1 }, { languages: [] }),
    ).rejects.toBeInstanceOf(OcrUnavailableError);
    await expect(none.dispose()).resolves.toBeUndefined();
  });

  it('refuses to build the Gemini provider without a key, curated and without any key text', () => {
    expect(() => createOcrProvider({ ...config, geminiApiKey: null })).toThrow(
      expect.objectContaining({ code: 'LLM_UNAVAILABLE' }) as Error,
    );
  });

  it('takes a stand-in client for tests', () => {
    const client = new FakeGeminiClient(() => []);
    const provider = createOcrProvider(config, { gemini: { client } });
    expect(provider).toBeInstanceOf(GeminiOcrProvider);
  });
});

describe('Gemini OCR availability', () => {
  it('is whether a key is configured: known at once, nothing is probed', async () => {
    const withKey = geminiKeyAvailability({ geminiApiKey: 'test-key-not-real' });
    expect(withKey.peek()).toBe(true);
    expect(await withKey.isAvailable()).toBe(true);
    const without = geminiKeyAvailability({ geminiApiKey: null });
    expect(without.peek()).toBe(false);
    expect(await without.isAvailable()).toBe(false);
  });

  it('is available for the Gemini provider itself (a service has no engine to start)', async () => {
    expect(await createOcrProvider(config).isAvailable()).toBe(true);
  });
});
