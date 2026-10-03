import type { Config } from '../config.js';
import { geminiPacerBuffer } from '../gemini/index.js';
import type { OcrSettings } from './worker/protocol.js';

/** The configuration an OCR worker thread needs. */
export function ocrSettingsOf(
  config: Pick<
    Config,
    | 'ocrProvider'
    | 'ocrModel'
    | 'ocrPagesPerRequest'
    | 'geminiApiKey'
    | 'geminiMaxRpm'
    | 'ocrCacheDir'
    | 'ocrLanguages'
    | 'ocrExtraLanguages'
    | 'ocrDpi'
  >,
): OcrSettings {
  return {
    provider: config.ocrProvider,
    model: config.ocrModel,
    pagesPerRequest: config.ocrPagesPerRequest,
    geminiApiKey: config.geminiApiKey,
    geminiMaxRpm: config.geminiMaxRpm,
    // The window of requests per minute that this process shares between the main thread and the OCR threads.
    pacerBuffer: geminiPacerBuffer(),
    cacheDir: config.ocrCacheDir,
    languages: config.ocrLanguages,
    extraLanguages: config.ocrExtraLanguages,
    dpi: config.ocrDpi,
  };
}
