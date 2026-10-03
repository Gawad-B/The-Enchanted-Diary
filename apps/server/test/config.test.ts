import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ConfigError,
  REPO_ROOT,
  defaultEmbeddingModelFor,
  defaultLlmAuxModelFor,
  defaultLlmModelFor,
  isLlmConfigured,
  loadConfig,
  mayDeleteData,
  BLOB_MIN_HARD_LIMIT_MS,
  OCR_MIN_HARD_LIMIT_MS,
} from '../src/config.js';
import { HARD_LIMIT_MARGIN_MS } from '../src/ingest/tick/context.js';
import { MIN_CALL_MS } from '../src/ingest/tick/step-ocr.js';
import { BATCH_TIMEOUT_MS } from '../src/ingest/worker/ocr-task.js';

function issuesOf(env: Record<string, string>): string {
  try {
    loadConfig(env);
  } catch (error) {
    expect(error).toBeInstanceOf(ConfigError);
    return (error as ConfigError).message;
  }
  throw new Error('loadConfig did not throw');
}

describe('loadConfig defaults', () => {
  it('uses the documented defaults for an empty environment', () => {
    const config = loadConfig({});
    expect(config).toMatchObject({
      nodeEnv: 'development',
      isProduction: false,
      host: '127.0.0.1',
      port: 8787,
      trustProxy: false,
      databaseUrl: null,
      storageProvider: 'local',
      documentRetentionHours: 24,
      documentMaxRetentionHours: 72,
      cleanupIntervalMinutes: 30,
      maxUploadMb: 50,
      maxUploadBytes: 50 * 1024 * 1024,
      maxPages: 300,
      maxQueuedJobs: 3,
      ingestConcurrency: 1,
      ingestPageTimeoutMs: 20_000,
      ingestJobTimeoutMs: 1_800_000,
      ingestWorkerMaxOldMb: 768,
      ingestWorkerMaxRssGrowthMb: 512,
      ingestTickBudgetMs: 45_000,
      ingestLeaseMs: 60_000,
      ingestTickHardLimitMs: 240_000,
      ingestMaxAttempts: 3,
      onVercel: false,
      databaseUrlUnpooled: null,
      databasePoolMax: 3,
      blobReadWriteToken: null,
      cronSecret: null,
      ticksPerMinute: 60,
      geminiDailyBudgetLlm: 300,
      geminiDailyBudgetEmbed: 800,
      geminiDailyBudgetOcr: 100,
      geminiDailyBudgetAux: 400,
      vercelEnv: null,
      allowPreviewData: false,
      blobMaxTotalBytes: 800 * 1024 * 1024,
      blobMaxWritesPerDay: 60,
      fileReadsPerDocumentPerDay: 20,
      ocrProvider: 'gemini',
      ocrLanguages: ['eng', 'ara'],
      ocrExtraLanguages: ['fra', 'spa', 'deu', 'ita', 'por', 'tur', 'fas', 'urd'],
      ocrMaxPages: 60,
      ocrMaxSeconds: 600,
      ocrDpi: 200,
      ocrMinChars: 25,
      embeddingProvider: 'gemini',
      embeddingModel: 'gemini-embedding-2',
      embeddingDimensions: 768,
      embeddingBatchSize: 16,
      llmProvider: 'gemini',
      llmModel: 'gemini-3.5-flash-lite',
      llmAuxModel: 'gemini-3.1-flash-lite',
      llmMaxTokens: 900,
      llmTemperature: 0.2,
      geminiApiKey: null,
      geminiMaxRpm: 10,
      geminiFreeTier: true,
      anthropicApiKey: null,
      openaiApiKey: null,
      openaiBaseUrl: 'https://api.openai.com/v1',
      ragTopK: 6,
      ragCandidates: 24,
      ragContextCharBudget: 16_000,
      ragHistoryMessages: 6,
      ragGroundingCheck: true,
      chunkTargetChars: 2000,
      chunkMaxChars: 3000,
      chunkMinChars: 400,
      chunkOverlapChars: 200,
      rateLimitPerMinute: 120,
      uploadsPerHour: 20,
      uploadsPerHourPerIp: 10,
      questionsPerMinute: 20,
      logLevel: 'info',
    });
  });

  it('treats blank variables as unset', () => {
    expect(loadConfig({ PORT: '', LLM_MODEL: '  ', DATABASE_URL: '' })).toMatchObject({
      port: 8787,
      llmModel: 'gemini-3.5-flash-lite',
      databaseUrl: null,
    });
  });

  it('reads overrides', () => {
    const config = loadConfig({
      PORT: '9000',
      HOST: '0.0.0.0',
      TRUST_PROXY: 'true',
      MAX_UPLOAD_MB: '5',
      MAX_PAGES: '10',
      OCR_LANGUAGES: 'fra',
      DATABASE_URL: 'postgres://diary:diary@localhost:5433/diary',
      LLM_TEMPERATURE: '0.7',
      LOG_LEVEL: 'debug',
    });
    expect(config).toMatchObject({
      port: 9000,
      host: '0.0.0.0',
      trustProxy: true,
      maxUploadBytes: 5 * 1024 * 1024,
      maxPages: 10,
      ocrLanguages: ['fra'],
      databaseUrl: 'postgres://diary:diary@localhost:5433/diary',
      llmTemperature: 0.7,
      logLevel: 'debug',
    });
  });
});

describe('data paths', () => {
  const originalCwd = process.cwd();
  afterEach(() => {
    process.chdir(originalCwd);
  });

  it('derives the repository root from the module location', () => {
    expect(existsSync(path.join(REPO_ROOT, 'package.json'))).toBe(true);
    const manifest = JSON.parse(readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8')) as {
      name: string;
    };
    expect(manifest.name).toBe('enchanted-diary');
  });

  it('resolves relative paths against the repository root, whatever the working directory is', () => {
    process.chdir(path.join(REPO_ROOT, 'apps', 'server'));
    const config = loadConfig({});
    expect(config.pgliteDataDir).toBe(path.join(REPO_ROOT, '.data', 'pglite'));
    expect(config.tmpDir).toBe(path.join(REPO_ROOT, '.data', 'tmp'));
    expect(config.storageDir).toBe(path.join(REPO_ROOT, '.data', 'uploads'));
    expect(config.ocrCacheDir).toBe(path.join(REPO_ROOT, '.data', 'tessdata'));
    expect(config.modelCacheDir).toBe(path.join(REPO_ROOT, '.data', 'models'));
  });

  it('keeps absolute paths and memory://', () => {
    const config = loadConfig({
      PGLITE_DATA_DIR: 'memory://',
      TMP_DIR: '/var/diary/tmp',
      STORAGE_DIR: './elsewhere/uploads',
    });
    expect(config.pgliteDataDir).toBe('memory://');
    expect(config.tmpDir).toBe('/var/diary/tmp');
    expect(config.storageDir).toBe(path.join(REPO_ROOT, 'elsewhere', 'uploads'));
  });
});

describe('invalid configuration', () => {
  it('names the variable and the received value for an invalid number', () => {
    const message = issuesOf({ PORT: 'abc' });
    expect(message).toContain('PORT');
    expect(message).toContain('integer between 1 and 65535');
    expect(message).toContain('"abc"');
  });

  it('lists every invalid variable at once', () => {
    const message = issuesOf({
      PORT: '99999',
      MAX_PAGES: '-1',
      TRUST_PROXY: 'yes',
      LOG_LEVEL: 'loud',
      OCR_LANGUAGES: 'english',
    });
    for (const variable of ['PORT', 'MAX_PAGES', 'TRUST_PROXY', 'LOG_LEVEL', 'OCR_LANGUAGES']) {
      expect(message).toContain(variable);
    }
    expect(message).toContain('must be one of: fatal, error, warn, info, debug, trace, silent');
  });

  it('rejects fractional values for integers and non-URLs for the OpenAI base URL', () => {
    expect(issuesOf({ MAX_PAGES: '1.5' })).toContain('MAX_PAGES');
    expect(issuesOf({ OPENAI_BASE_URL: 'not a url' })).toContain('OPENAI_BASE_URL');
  });

  it('bounds the OCR time budget of a document', () => {
    expect(loadConfig({ OCR_MAX_SECONDS: '90' }).ocrMaxSeconds).toBe(90);
    expect(issuesOf({ OCR_MAX_SECONDS: '0' })).toContain('OCR_MAX_SECONDS');
    // Never above what the host's watchdog gives one request: the budget must be what stops OCR, not the watchdog.
    expect(loadConfig({ OCR_MAX_SECONDS: String(BATCH_TIMEOUT_MS / 1000) }).ocrMaxSeconds).toBe(
      BATCH_TIMEOUT_MS / 1000,
    );
    expect(issuesOf({ OCR_MAX_SECONDS: String(BATCH_TIMEOUT_MS / 1000 + 1) })).toContain('OCR_MAX_SECONDS');
    expect(issuesOf({ OCR_MAX_SECONDS: 'a while' })).toContain('OCR_MAX_SECONDS');
  });

  it('bounds the worker memory limits', () => {
    expect(loadConfig({ INGEST_WORKER_MAX_RSS_GROWTH_MB: '1024' }).ingestWorkerMaxRssGrowthMb).toBe(1024);
    expect(issuesOf({ INGEST_WORKER_MAX_RSS_GROWTH_MB: '10' })).toContain('INGEST_WORKER_MAX_RSS_GROWTH_MB');
    expect(issuesOf({ INGEST_WORKER_MAX_RSS_GROWTH_MB: '99999' })).toContain(
      'INGEST_WORKER_MAX_RSS_GROWTH_MB',
    );
    expect(issuesOf({ INGEST_WORKER_MAX_OLD_MB: '8' })).toContain('INGEST_WORKER_MAX_OLD_MB');
  });

  it('checks relations between variables', () => {
    expect(issuesOf({ CHUNK_MAX_CHARS: '500' })).toContain('CHUNK_MAX_CHARS');
    expect(issuesOf({ CHUNK_MIN_CHARS: '5000' })).toContain('CHUNK_MIN_CHARS');
    expect(issuesOf({ RAG_CANDIDATES: '2' })).toContain('RAG_CANDIDATES');
    expect(issuesOf({ DOCUMENT_RETENTION_HOURS: '100' })).toContain('DOCUMENT_MAX_RETENTION_HOURS');
  });
});

describe('session secret', () => {
  it('is required in production', () => {
    const message = issuesOf({ NODE_ENV: 'production' });
    expect(message).toContain('SESSION_SECRET');
    expect(message).toContain('production');
  });

  it('must be at least 32 characters when given, without echoing it', () => {
    const message = issuesOf({ NODE_ENV: 'production', SESSION_SECRET: 'too-short-secret' });
    expect(message).toContain('at least 32 characters');
    expect(message).not.toContain('too-short-secret');
  });

  it('is accepted in production when long enough', () => {
    const config = loadConfig({ NODE_ENV: 'production', SESSION_SECRET: 'x'.repeat(32) });
    expect(config).toMatchObject({
      isProduction: true,
      sessionSecret: 'x'.repeat(32),
      sessionSecretGenerated: false,
    });
  });

  it('is generated in development and flagged', () => {
    const first = loadConfig({});
    const second = loadConfig({});
    expect(first.sessionSecretGenerated).toBe(true);
    expect(first.sessionSecret).toHaveLength(64);
    expect(first.sessionSecret).not.toBe(second.sessionSecret);
  });
});

describe('per-provider defaults', () => {
  it('has default models for the providers that have one', () => {
    expect(defaultLlmModelFor('gemini')).toBe('gemini-3.5-flash-lite');
    expect(defaultLlmModelFor('anthropic')).toBe('claude-sonnet-5-5');
    expect(defaultLlmModelFor('openai')).toBeNull();
    expect(defaultLlmModelFor('none')).toBeNull();
    expect(defaultEmbeddingModelFor('gemini')).toBe('gemini-embedding-2');
    expect(defaultEmbeddingModelFor('openai')).toBeNull();
  });

  it('gives Gemini its own model for the small calls and every other provider none (the answer model)', () => {
    expect(defaultLlmAuxModelFor('gemini')).toBe('gemini-3.1-flash-lite');
    expect(defaultLlmAuxModelFor('anthropic')).toBe('');
    expect(defaultLlmAuxModelFor('openai')).toBe('');
    expect(loadConfig({}).llmAuxModel).toBe('gemini-3.1-flash-lite');
    expect(loadConfig({ LLM_AUX_MODEL: 'gemini-x' }).llmAuxModel).toBe('gemini-x');
  });

  it('applies them when the model variable is unset', () => {
    expect(loadConfig({ LLM_PROVIDER: 'anthropic' }).llmModel).toBe('claude-sonnet-5-5');
    expect(loadConfig({ LLM_PROVIDER: 'none' }).llmModel).toBe('');
    expect(loadConfig({ LLM_PROVIDER: 'anthropic', LLM_MODEL: 'claude-custom' }).llmModel).toBe(
      'claude-custom',
    );
  });

  it('requires a model for an OpenAI-compatible chat endpoint', () => {
    const message = issuesOf({ LLM_PROVIDER: 'openai' });
    expect(message).toContain('LLM_MODEL');
    expect(message).toContain('LLM_PROVIDER=openai');
    expect(loadConfig({ LLM_PROVIDER: 'openai', LLM_MODEL: 'gpt-4.1-mini' }).llmModel).toBe('gpt-4.1-mini');
  });

  it('requires a model for OpenAI-compatible embeddings', () => {
    expect(issuesOf({ EMBEDDING_PROVIDER: 'openai' })).toContain('EMBEDDING_MODEL');
    expect(
      loadConfig({ EMBEDDING_PROVIDER: 'openai', EMBEDDING_MODEL: 'text-embedding-3-small' }).embeddingModel,
    ).toBe('text-embedding-3-small');
  });

  it('no longer knows the local providers or the small profile', () => {
    expect(issuesOf({ LLM_PROVIDER: 'local' })).toContain('LLM_PROVIDER');
    expect(issuesOf({ EMBEDDING_PROVIDER: 'local' })).toContain('EMBEDDING_PROVIDER');
    expect(loadConfig({ LLM_PROFILE: 'small' })).not.toHaveProperty('llmProfile');
  });
});

describe('free-tier chunking', () => {
  it('sizes chunks so that a book fits the free daily embedding quota', () => {
    const config = loadConfig({});
    // ~2,000 characters is 600 to 900 tokens; a 300-page book is a few hundred chunks, under 1,000 a day.
    expect(config.chunkTargetChars).toBe(2000);
    expect(config.chunkMaxChars).toBe(3000);
    expect(config.ragContextCharBudget).toBe(16_000);
  });

  it('keeps the chunk limits consistent', () => {
    expect(issuesOf({ CHUNK_TARGET_CHARS: '2000', CHUNK_MAX_CHARS: '1500' })).toContain('CHUNK_MAX_CHARS');
    expect(issuesOf({ CHUNK_TARGET_CHARS: '300', CHUNK_MIN_CHARS: '400' })).toContain('CHUNK_MIN_CHARS');
  });
});

describe('isLlmConfigured', () => {
  it('needs a key for Gemini and Anthropic, and never for none', () => {
    expect(isLlmConfigured(loadConfig({}))).toBe(false);
    expect(isLlmConfigured(loadConfig({ GEMINI_API_KEY: 'k' }))).toBe(true);
    expect(isLlmConfigured(loadConfig({ LLM_PROVIDER: 'anthropic' }))).toBe(false);
    expect(isLlmConfigured(loadConfig({ LLM_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: 'k' }))).toBe(true);
    expect(isLlmConfigured(loadConfig({ LLM_PROVIDER: 'none', GEMINI_API_KEY: 'k' }))).toBe(false);
  });

  it('needs a key or a custom base URL for an OpenAI-compatible endpoint', () => {
    const base = { LLM_PROVIDER: 'openai', LLM_MODEL: 'm' };
    expect(isLlmConfigured(loadConfig(base))).toBe(false);
    expect(isLlmConfigured(loadConfig({ ...base, OPENAI_API_KEY: 'k' }))).toBe(true);
    expect(isLlmConfigured(loadConfig({ ...base, OPENAI_BASE_URL: 'http://127.0.0.1:11434/v1' }))).toBe(true);
  });
});

describe('the serverless settings', () => {
  /** What a deployment on Vercel has to set: a database, the Blob store, and a secret every instance shares. */
  const ON_VERCEL = {
    VERCEL: '1',
    DATABASE_URL: 'postgres://u:p@ep-x-pooler.neon.tech/db?sslmode=require',
    STORAGE_PROVIDER: 'vercel-blob',
    BLOB_READ_WRITE_TOKEN: 'vercel_blob_rw_x',
    SESSION_SECRET: 'x'.repeat(40),
  };

  it('on Vercel trusts the proxy and keeps scratch files in /tmp unless told otherwise', () => {
    const config = loadConfig(ON_VERCEL);
    expect(config).toMatchObject({ onVercel: true, trustProxy: true, tmpDir: '/tmp/enchanted-diary' });
    expect(loadConfig({ ...ON_VERCEL, TRUST_PROXY: 'false', TMP_DIR: '/tmp/x' })).toMatchObject({
      trustProxy: false,
      tmpDir: '/tmp/x',
    });
  });

  it('keeps scratch files of a Vercel function under /tmp: any other TMP_DIR is refused there, and anywhere else is fine', () => {
    for (const tmp of ['/var/task/tmp', './.data/tmp', '/home/sbx_user/tmp', '/tmpfoo']) {
      expect(issuesOf({ ...ON_VERCEL, TMP_DIR: tmp }), tmp).toContain(
        'TMP_DIR: must be under /tmp on Vercel',
      );
    }
    for (const tmp of ['/tmp', '/tmp/diary']) {
      expect(loadConfig({ ...ON_VERCEL, TMP_DIR: tmp }).tmpDir, tmp).toBe(tmp);
    }
    expect(loadConfig({ TMP_DIR: './.data/elsewhere' }).onVercel).toBe(false); // off Vercel any directory will do
  });

  it('requires a database on Vercel (the embedded one needs a writable disk)', () => {
    expect(issuesOf({ ...ON_VERCEL, DATABASE_URL: '' })).toContain('DATABASE_URL: is required on Vercel');
  });

  it('refuses on Vercel what cannot work there: the local disk, a secret that is not shared, a tick limit past the function’s', () => {
    expect(issuesOf({ ...ON_VERCEL, STORAGE_PROVIDER: 'local' })).toContain(
      'STORAGE_PROVIDER: must be vercel-blob on Vercel',
    );
    // Without a secret every instance would sign sessions (and upload tickets) with a secret of its own.
    expect(issuesOf({ ...ON_VERCEL, SESSION_SECRET: '' })).toContain('SESSION_SECRET: is required on Vercel');
    // The function is stopped at 300 s: a tick limit that is not under it (with a margin to answer in) is refused.
    expect(issuesOf({ ...ON_VERCEL, INGEST_TICK_HARD_LIMIT_MS: '290000' })).toContain(
      'INGEST_TICK_HARD_LIMIT_MS: must be at most 285000 on Vercel',
    );
    expect(loadConfig({ ...ON_VERCEL, INGEST_TICK_HARD_LIMIT_MS: '285000' }).ingestTickHardLimitMs).toBe(
      285_000,
    );
    // Off Vercel none of it applies.
    expect(loadConfig({ INGEST_TICK_HARD_LIMIT_MS: '290000' }).ingestTickHardLimitMs).toBe(290_000);
    expect(loadConfig({}).storageProvider).toBe('local');
  });

  it('requires the Blob token when the Blob store is the storage', () => {
    expect(issuesOf({ STORAGE_PROVIDER: 'vercel-blob' })).toContain('BLOB_READ_WRITE_TOKEN: is required');
    expect(
      loadConfig({ STORAGE_PROVIDER: 'vercel-blob', BLOB_READ_WRITE_TOKEN: 'vercel_blob_rw_x' }),
    ).toMatchObject({ storageProvider: 'vercel-blob', blobReadWriteToken: 'vercel_blob_rw_x' });
  });

  it('makes uploads 20 MB by default into a Blob store (one write operation of a small quota) and 50 MB otherwise, unless told', () => {
    const blob = { STORAGE_PROVIDER: 'vercel-blob', BLOB_READ_WRITE_TOKEN: 'vercel_blob_rw_x' };
    expect(loadConfig(blob)).toMatchObject({ maxUploadMb: 20, maxUploadBytes: 20 * 1024 * 1024 });
    expect(loadConfig({})).toMatchObject({ maxUploadMb: 50 });
    expect(loadConfig({ ...blob, MAX_UPLOAD_MB: '35' }).maxUploadMb).toBe(35);
    expect(issuesOf({ MAX_UPLOAD_MB: '0' })).toContain(
      'MAX_UPLOAD_MB: must be an integer between 1 and 2048',
    );
  });

  it('reads the budgets of the Blob store, the environment Vercel runs it in, and whether a preview may delete data', () => {
    expect(
      loadConfig({
        BLOB_MAX_TOTAL_MB: '500',
        BLOB_MAX_WRITES_PER_DAY: '0',
        FILE_READS_PER_DOC_PER_DAY: '5',
        VERCEL_ENV: 'preview',
        ALLOW_PREVIEW_DATA: 'true',
      }),
    ).toMatchObject({
      blobMaxTotalBytes: 500 * 1024 * 1024,
      blobMaxWritesPerDay: 0,
      fileReadsPerDocumentPerDay: 5,
      vercelEnv: 'preview',
      allowPreviewData: true,
    });
  });

  it('lets production, and anything that is not on Vercel, delete data; a preview only when it was told it has its own', () => {
    expect(mayDeleteData(loadConfig({}))).toBe(true);
    expect(mayDeleteData(loadConfig({ VERCEL_ENV: 'production' }))).toBe(true);
    expect(mayDeleteData(loadConfig({ VERCEL_ENV: 'preview' }))).toBe(false);
    expect(mayDeleteData(loadConfig({ VERCEL_ENV: 'development' }))).toBe(false);
    expect(mayDeleteData(loadConfig({ VERCEL_ENV: 'preview', ALLOW_PREVIEW_DATA: 'true' }))).toBe(true);
  });

  it('keeps the hard limit of a tick where an OCR call can still start while OCR is on (5 s to wind down, 3 s for a call)', () => {
    // A hard limit under 8 s would leave every tick "no time to call the OCR service": the document would wait for ever.
    const ocr = { INGEST_TICK_BUDGET_MS: '2000' };
    for (const provider of ['gemini', 'tesseract']) {
      expect(
        issuesOf({ ...ocr, OCR_PROVIDER: provider, INGEST_TICK_HARD_LIMIT_MS: '7999' }),
        provider,
      ).toContain(
        `INGEST_TICK_HARD_LIMIT_MS: must be at least ${String(OCR_MIN_HARD_LIMIT_MS)} while OCR is on`,
      );
      expect(
        loadConfig({
          ...ocr,
          OCR_PROVIDER: provider,
          INGEST_TICK_HARD_LIMIT_MS: String(OCR_MIN_HARD_LIMIT_MS),
        }).ingestTickHardLimitMs,
      ).toBe(OCR_MIN_HARD_LIMIT_MS);
    }
    // Without OCR any limit above the budget will do.
    expect(
      loadConfig({ ...ocr, OCR_PROVIDER: 'none', INGEST_TICK_HARD_LIMIT_MS: '5000' }).ingestTickHardLimitMs,
    ).toBe(5000);
  });

  it('keeps the hard limit of a tick where a read of a Blob store can fit in what the tick keeps free, whatever the OCR setting', () => {
    // A tick bounds its read of the store by what is left of the hard limit after 5 s; with 5 s of hard limit nothing is left, and
    // every document would end as a store that does not answer.
    const blob = {
      STORAGE_PROVIDER: 'vercel-blob',
      BLOB_READ_WRITE_TOKEN: 'vercel_blob_rw_x',
      OCR_PROVIDER: 'none',
    };
    expect(issuesOf({ ...blob, INGEST_TICK_BUDGET_MS: '2000', INGEST_TICK_HARD_LIMIT_MS: '5000' })).toContain(
      `INGEST_TICK_HARD_LIMIT_MS: must be at least ${String(BLOB_MIN_HARD_LIMIT_MS)} with STORAGE_PROVIDER=vercel-blob`,
    );
    expect(
      loadConfig({
        ...blob,
        INGEST_TICK_BUDGET_MS: '2000',
        INGEST_TICK_HARD_LIMIT_MS: String(BLOB_MIN_HARD_LIMIT_MS),
      }).ingestTickHardLimitMs,
    ).toBe(BLOB_MIN_HARD_LIMIT_MS);
    // The local disk does not need it.
    expect(
      loadConfig({ OCR_PROVIDER: 'none', INGEST_TICK_BUDGET_MS: '2000', INGEST_TICK_HARD_LIMIT_MS: '5000' })
        .ingestTickHardLimitMs,
    ).toBe(5000);
    expect(BLOB_MIN_HARD_LIMIT_MS).toBe(HARD_LIMIT_MARGIN_MS + 3000);
  });

  it('keeps the constant behind that rule equal to what the tick does: its margin plus the shortest call', () => {
    expect(OCR_MIN_HARD_LIMIT_MS).toBe(HARD_LIMIT_MARGIN_MS + MIN_CALL_MS);
  });

  it('keeps the hard limit of a tick above its budget, and reads the budgets and the cron secret', () => {
    expect(issuesOf({ INGEST_TICK_BUDGET_MS: '60000', INGEST_TICK_HARD_LIMIT_MS: '60000' })).toContain(
      'INGEST_TICK_HARD_LIMIT_MS: must be larger',
    );
    expect(
      loadConfig({
        GEMINI_DAILY_BUDGET_LLM: '0',
        GEMINI_DAILY_BUDGET_EMBED: '500',
        GEMINI_DAILY_BUDGET_OCR: '50',
        GEMINI_DAILY_BUDGET_AUX: '10',
        CRON_SECRET: 'abc',
        DATABASE_POOL_MAX: '5',
        DATABASE_URL_UNPOOLED: 'postgres://direct',
      }),
    ).toMatchObject({
      geminiDailyBudgetLlm: 0,
      geminiDailyBudgetEmbed: 500,
      geminiDailyBudgetOcr: 50,
      geminiDailyBudgetAux: 10,
      cronSecret: 'abc',
      databasePoolMax: 5,
      databaseUrlUnpooled: 'postgres://direct',
    });
  });

  it('keeps the tick limit of a session under the limit of an address, so that it limits something', () => {
    const config = loadConfig({});
    expect(config.ticksPerMinute).toBeLessThan(config.rateLimitPerMinute);
  });
});
