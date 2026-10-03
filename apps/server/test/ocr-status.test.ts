import { describe, expect, it } from 'vitest';
import { describeProviders, describePublicConfig, type ProviderReadiness } from '../src/http/status.js';
import { testConfig } from './helpers.js';

/* What /api/health and /api/config say about OCR, without a server: the functions that describe the providers. */

const ready = (ocr: ProviderReadiness['ocr']): ProviderReadiness => ({ embeddings: true, ocr });

describe('the OCR entry of /api/health', () => {
  it('names the Gemini model once there is a key, so the operator sees what reads the pages', () => {
    const config = testConfig({ OCR_PROVIDER: 'gemini', GEMINI_API_KEY: 'test-key-not-real' });
    expect(describeProviders(config, ready(true)).ocr).toBe('gemini:gemini-3.5-flash-lite');
    expect(
      describeProviders(
        testConfig({ OCR_PROVIDER: 'gemini', OCR_MODEL: 'gemini-other', GEMINI_API_KEY: 'k' }),
        ready(true),
      ).ocr,
    ).toBe('gemini:gemini-other');
  });

  it('says unconfigured without a key, checking while it is not known, none when OCR is off', () => {
    const config = testConfig({ OCR_PROVIDER: 'gemini' });
    expect(describeProviders(config, ready(false)).ocr).toBe('unconfigured');
    expect(
      describeProviders(
        config,
        ready(() => null),
      ).ocr,
    ).toBe('checking');
    expect(describeProviders(testConfig({ OCR_PROVIDER: 'none' }), ready(true)).ocr).toBe('none');
  });

  it('still says tesseract for the self-hosted engine', () => {
    expect(describeProviders(testConfig({ OCR_PROVIDER: 'tesseract' }), ready(true)).ocr).toBe('tesseract');
  });
});

describe('the OCR entry of /api/config', () => {
  it('reports the provider and whether it can read', () => {
    const config = testConfig({ OCR_PROVIDER: 'gemini', GEMINI_API_KEY: 'test-key-not-real' });
    expect(describePublicConfig(config, ready(true)).ocr).toEqual({ provider: 'gemini', available: true });
    expect(describePublicConfig(config, ready(false)).ocr).toEqual({ provider: 'gemini', available: false });
  });

  it('counts Gemini OCR among the things that send the documents of a visitor to a free-tier key', () => {
    const base = {
      LLM_PROVIDER: 'none',
      EMBEDDING_PROVIDER: 'openai',
      EMBEDDING_MODEL: 'text-embedding-3-small',
    };
    const onGemini = testConfig({ ...base, OCR_PROVIDER: 'gemini', GEMINI_API_KEY: 'k' });
    expect(describePublicConfig(onGemini, ready(true)).llm.freeTierNotice).toBe(true);
    const off = testConfig({ ...base, OCR_PROVIDER: 'none' });
    expect(describePublicConfig(off, ready(false)).llm.freeTierNotice).toBe(false);
  });
});
