import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from '../src/config.js';

/* The OCR variables of the configuration: Gemini is the default engine, Tesseract and `none` are chosen. */

function issuesOf(env: Record<string, string>): string[] {
  try {
    loadConfig(env);
  } catch (error) {
    if (error instanceof ConfigError) return error.issues.map((issue) => issue.variable);
    throw error;
  }
  throw new Error('loadConfig did not throw');
}

describe('OCR configuration', () => {
  it('reads pages with Gemini by default: gemini-3.5-flash-lite, eight pages a request', () => {
    expect(loadConfig({})).toMatchObject({
      ocrProvider: 'gemini',
      ocrModel: 'gemini-3.5-flash-lite',
      ocrPagesPerRequest: 8,
      ocrMaxPages: 60,
      ocrMaxSeconds: 600,
    });
  });

  it('chooses the engine: gemini, tesseract or none', () => {
    for (const provider of ['gemini', 'tesseract', 'none'] as const) {
      expect(loadConfig({ OCR_PROVIDER: provider }).ocrProvider).toBe(provider);
    }
    expect(issuesOf({ OCR_PROVIDER: 'cloud-vision' })).toContain('OCR_PROVIDER');
  });

  it('takes the model and the pages per request, within bounds', () => {
    expect(loadConfig({ OCR_MODEL: 'gemini-test', OCR_PAGES_PER_REQUEST: '3' })).toMatchObject({
      ocrModel: 'gemini-test',
      ocrPagesPerRequest: 3,
    });
    expect(issuesOf({ OCR_PAGES_PER_REQUEST: '0' })).toContain('OCR_PAGES_PER_REQUEST');
    expect(issuesOf({ OCR_PAGES_PER_REQUEST: 'many' })).toContain('OCR_PAGES_PER_REQUEST');
    expect(loadConfig({ OCR_MODEL: '  ' }).ocrModel).toBe('gemini-3.5-flash-lite'); // blank means unset
  });

  it('shares the Gemini key and the request pacing with the other Gemini-backed providers', () => {
    expect(loadConfig({})).toMatchObject({ geminiApiKey: null, geminiMaxRpm: 10 });
    expect(loadConfig({ GEMINI_API_KEY: 'test-key-not-real', GEMINI_MAX_RPM: '5' })).toMatchObject({
      geminiApiKey: 'test-key-not-real',
      geminiMaxRpm: 5,
    });
  });
});
