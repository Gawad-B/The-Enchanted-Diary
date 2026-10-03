import { describe, expect, it } from 'vitest';
import { geminiPacerBuffer } from '../src/gemini/index.js';
import { ocrSettingsOf } from '../src/ingest/ocr-settings.js';
import { CachedAvailability } from '../src/ocr/availability.js';
import { testConfig } from './helpers.js';

function probe(answers: (boolean | Error)[]): { run: () => Promise<boolean>; calls: () => number } {
  let calls = 0;
  return {
    calls: () => calls,
    run: () => {
      const answer = answers[Math.min(calls, answers.length - 1)] ?? false;
      calls += 1;
      return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer);
    },
  };
}

describe('CachedAvailability', () => {
  it('asks once while the engine is available, however often it is asked', async () => {
    const p = probe([true]);
    const availability = new CachedAvailability(p.run, { failureCacheMs: 1000 });
    expect(await Promise.all([availability.isAvailable(), availability.isAvailable()])).toEqual([true, true]);
    expect(await availability.isAvailable()).toBe(true);
    expect(p.calls()).toBe(1);
  });

  it('remembers a failure for a while, then asks again (a language pack may have arrived)', async () => {
    let now = 0;
    const p = probe([false, true]);
    const availability = new CachedAvailability(p.run, { failureCacheMs: 1000, now: () => now });
    expect(await availability.isAvailable()).toBe(false);
    now = 999;
    expect(await availability.isAvailable()).toBe(false);
    expect(p.calls()).toBe(1);
    now = 1000;
    expect(await availability.isAvailable()).toBe(true);
    expect(p.calls()).toBe(2);
    now = 10_000_000;
    expect(await availability.isAvailable()).toBe(true);
    expect(p.calls()).toBe(2); // a success is kept
  });

  it('peeks without starting anything: unknown until the check is done, then the answer', async () => {
    let finish: (ok: boolean) => void = () => undefined;
    let calls = 0;
    const availability = new CachedAvailability(() => {
      calls += 1;
      return new Promise<boolean>((resolve) => {
        finish = resolve;
      });
    });
    expect(availability.peek()).toBeNull();
    expect(calls).toBe(0); // peeking is not asking
    const asking = availability.isAvailable();
    expect(availability.peek()).toBeNull(); // the check is running
    finish(true);
    await asking;
    expect(availability.peek()).toBe(true);
    const failing = new CachedAvailability(probe([false]).run);
    await failing.isAvailable();
    expect(failing.peek()).toBe(false);
  });

  it('treats a probe that throws as unavailable and reports why', async () => {
    const reasons: unknown[] = [];
    const availability = new CachedAvailability(probe([new Error('boom')]).run, {
      failureCacheMs: 1000,
      onFailure: (error) => reasons.push(error),
    });
    expect(await availability.isAvailable()).toBe(false);
    expect((reasons[0] as Error).message).toBe('boom');
  });
});

describe('ocrSettingsOf', () => {
  it('takes the OCR settings from the configuration', () => {
    const config = testConfig({
      OCR_PROVIDER: 'tesseract',
      OCR_LANGUAGES: 'eng+fra',
      OCR_EXTRA_LANGUAGES: 'deu',
      OCR_DPI: '150',
      OCR_CACHE_DIR: '/data/tessdata',
    });
    expect(ocrSettingsOf(config)).toEqual({
      provider: 'tesseract',
      model: 'gemini-3.5-flash-lite',
      pagesPerRequest: 8,
      geminiApiKey: null,
      geminiMaxRpm: 10,
      pacerBuffer: geminiPacerBuffer(), // the window of requests per minute that the OCR threads share with this one
      cacheDir: '/data/tessdata',
      languages: ['eng', 'fra'],
      extraLanguages: ['deu'],
      dpi: 150,
    });
  });

  it('carries what the Gemini provider needs into the worker thread', () => {
    const config = testConfig({
      OCR_PROVIDER: 'gemini',
      OCR_MODEL: 'gemini-test-model',
      OCR_PAGES_PER_REQUEST: '4',
      GEMINI_API_KEY: 'test-key-not-real',
      GEMINI_MAX_RPM: '6',
    });
    expect(ocrSettingsOf(config)).toMatchObject({
      provider: 'gemini',
      model: 'gemini-test-model',
      pagesPerRequest: 4,
      geminiApiKey: 'test-key-not-real',
      geminiMaxRpm: 6,
    });
  });
});
