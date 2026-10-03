import { geminiPacerBuffer } from '../../src/gemini/index.js';
import type { OcrStageConfig } from '../../src/ingest/ocr-stage.js';
import type { OcrSettings } from '../../src/ingest/worker/protocol.js';

/** OCR settings for a test, Tesseract by default (what the fake engines of these tests stand in for). Test code only. */
export const ocrSettings = (overrides: Partial<OcrSettings> = {}): OcrSettings => ({
  provider: 'tesseract',
  model: 'gemini-3.5-flash-lite',
  pagesPerRequest: 8,
  geminiApiKey: null,
  geminiMaxRpm: 0,
  pacerBuffer: geminiPacerBuffer(),
  cacheDir: '/nonexistent/tessdata', // a fake engine never looks
  languages: ['eng', 'ara'],
  extraLanguages: [],
  dpi: 72,
  ...overrides,
});

/** The configuration of the OCR stage for a test. Test code only. */
export const ocrStageConfig = (overrides: Partial<OcrStageConfig> = {}): OcrStageConfig => ({
  ocrProvider: 'tesseract',
  ocrModel: 'gemini-3.5-flash-lite',
  ocrPagesPerRequest: 8,
  geminiApiKey: null,
  geminiMaxRpm: 0,
  ocrLanguages: ['eng'],
  ocrExtraLanguages: [],
  ocrMaxPages: 60,
  ocrMaxSeconds: 600,
  ocrCacheDir: '/nonexistent',
  ocrDpi: 72,
  ocrMinChars: 25,
  ...overrides,
});
