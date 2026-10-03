import type { Config } from '../config.js';
import { getGeminiClient, getGeminiPacer } from '../gemini/index.js';
import { GeminiOcrProvider, type GeminiOcrOptions } from './gemini.js';
import { TesseractOcrProvider, type TesseractOptions } from './tesseract.js';
import {
  OcrUnavailableError,
  type OCRProvider,
  type OcrPage,
  type OcrRecognizeOptions,
  type OcrResult,
} from './types.js';

/** OCR_PROVIDER=none: there is no engine. Pages that need OCR are reported as such (OCR_UNAVAILABLE). */
export class NoopOcrProvider implements OCRProvider {
  readonly name = 'none';
  readonly input = 'png';
  readonly selectsLanguages = false;
  readonly pagesPerRequest = 1;

  isAvailable(): Promise<boolean> {
    return Promise.resolve(false);
  }

  recognize(_page: OcrPage, _options: OcrRecognizeOptions): Promise<OcrResult> {
    return Promise.reject(new OcrUnavailableError('OCR is switched off (OCR_PROVIDER=none).'));
  }

  dispose(): Promise<void> {
    return Promise.resolve();
  }
}

/** What building a provider needs from the configuration. */
export type OcrProviderConfig = Pick<
  Config,
  | 'ocrProvider'
  | 'ocrCacheDir'
  | 'ocrLanguages'
  | 'ocrModel'
  | 'ocrPagesPerRequest'
  | 'geminiApiKey'
  | 'geminiMaxRpm'
>;

/** Replacements for tests: a fake Gemini client, a counting tesseract.js. */
export interface OcrProviderOverrides {
  gemini?: Partial<GeminiOcrOptions>;
  tesseract?: Partial<TesseractOptions>;
}

/**
 * The provider OCR_PROVIDER names. Gemini (the default) reads pages through the shared Gemini module with OCR_MODEL;
 * Tesseract (optional, self-hosted) starts with the first of OCR_LANGUAGES and loads tesseract.js only when it is first
 * used.
 */
export function createOcrProvider(
  config: OcrProviderConfig,
  overrides: OcrProviderOverrides = {},
): OCRProvider {
  switch (config.ocrProvider) {
    case 'none':
      return new NoopOcrProvider();
    case 'gemini':
      return new GeminiOcrProvider({
        client: overrides.gemini?.client ?? getGeminiClient(config),
        model: config.ocrModel,
        pagesPerRequest: config.ocrPagesPerRequest,
        pacer: getGeminiPacer(config),
        ...overrides.gemini,
      });
    case 'tesseract':
      return new TesseractOcrProvider({
        cacheDir: config.ocrCacheDir,
        probeLanguages: config.ocrLanguages.slice(0, 1),
        ...overrides.tesseract,
      });
  }
}
