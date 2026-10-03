import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

/**
 * The single source of truth for server configuration: zod-parsed environment variables, resolved once
 * into a typed object. Nothing else in the server reads `process.env`.
 */

/**
 * Repository root, derived from this module's location (apps/server/{src,dist}/config.*). Relative paths in
 * the environment resolve against it, never against the process CWD: npm workspace scripts run with the
 * workspace directory as CWD.
 */
export const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));

export type LlmProvider = 'gemini' | 'anthropic' | 'openai' | 'none';
export type EmbeddingProvider = 'gemini' | 'openai';

export const ACCEPTED_MIME_TYPES = ['application/pdf', 'application/x-pdf'] as const;

const DEFAULT_OPENAI_BASE_URL = 'https://api.openai.com/v1';
const MIN_SESSION_SECRET_CHARS = 32;
const MEMORY_DATA_DIR = 'memory://';
/** `maxDuration` of the function in vercel.json (the Hobby maximum), in milliseconds. */
const VERCEL_MAX_DURATION_MS = 300_000;
/** What a tick leaves free before the function is killed, to answer and give its lease back. */
const VERCEL_DURATION_MARGIN_MS = 15_000;
/**
 * The least `INGEST_TICK_HARD_LIMIT_MS` with which an OCR call can ever start: a unit leaves `HARD_LIMIT_MARGIN_MS` (5 s) of the
 * tick free to wind down, and a call is not started with less than `MIN_CALL_MS` (3 s) left (ingest/tick/context.ts and
 * step-ocr.ts, which a test keeps equal to this). Below it every tick would find "no time" and the document would wait for ever.
 */
export const OCR_MIN_HARD_LIMIT_MS = 8000;
/**
 * The least `INGEST_TICK_HARD_LIMIT_MS` with a Blob store: a tick bounds its read of the store by what is left of the hard limit
 * after `HARD_LIMIT_MARGIN_MS` (5 s), and the read of a file of up to MAX_UPLOAD_MB needs a few seconds of that.
 */
export const BLOB_MIN_HARD_LIMIT_MS = 8000;
/** The largest upload by default: 50 MB on a server of one's own, 20 MB into a Blob store (one write each, a store of 1 GB). */
const DEFAULT_MAX_UPLOAD_MB = 50;
const DEFAULT_MAX_UPLOAD_MB_BLOB = 20;
/** The only writable directory of a Vercel function. */
const VERCEL_TMP_DIR = '/tmp/enchanted-diary';

/** Default chat model for a provider, or null when the operator must choose one (openai) or there is none. */
export function defaultLlmModelFor(provider: LlmProvider): string | null {
  switch (provider) {
    case 'gemini':
      // The free tier gives this model a usable daily quota; the full Flash models only a few requests a day. A paid key
      // can name a stronger one (LLM_MODEL=gemini-3.8-flash).
      return 'gemini-3.5-flash-lite';
    case 'anthropic':
      return 'claude-sonnet-5-5';
    case 'openai':
    case 'none':
      return null;
  }
}

/**
 * The model for the small calls around an answer (rewriting a follow-up, the yes/no grounding check). Empty means "the
 * same model as the answers" (every provider but Gemini). For Gemini it is the previous lite model: it has its own quota
 * bucket, so those calls do not use up the answers' requests.
 */
export function defaultLlmAuxModelFor(provider: LlmProvider): string {
  return provider === 'gemini' ? 'gemini-3.1-flash-lite' : '';
}

/** Default embedding model for a provider, or null when the operator must choose one (openai). */
export function defaultEmbeddingModelFor(provider: EmbeddingProvider): string | null {
  return provider === 'gemini' ? 'gemini-embedding-2' : null;
}

export interface Config {
  nodeEnv: 'development' | 'test' | 'production';
  isProduction: boolean;
  host: string;
  port: number;
  trustProxy: boolean;
  /** Running as a Vercel function (`VERCEL` is set): no listening server, no timers, a read-only disk except /tmp. */
  onVercel: boolean;
  /**
   * Where on Vercel this runs (`VERCEL_ENV`: production, preview or development); null off Vercel. Anything but production
   * must not do destructive work on data that may be production's (see `allowPreviewData`).
   */
  vercelEnv: string | null;
  /**
   * `ALLOW_PREVIEW_DATA=true`: this preview or development environment has a database and a Blob store of its own, so the
   * migrations and the retention sweep (which delete things) may run here. Without it they refuse outside production.
   */
  allowPreviewData: boolean;
  sessionSecret: string;
  /** True when no SESSION_SECRET was given (development and test only): sessions do not survive a restart. */
  sessionSecretGenerated: boolean;
  /** Null selects the embedded PGlite database. */
  databaseUrl: string | null;
  /** The direct (not pooled) connection, preferred for migrations (`DATABASE_URL_UNPOOLED` of the Neon integration). */
  databaseUrlUnpooled: string | null;
  /** Connections of the pool of this process (a serverless instance needs few). */
  databasePoolMax: number;
  /** Absolute directory, or `memory://`. Only used without DATABASE_URL. */
  pgliteDataDir: string;
  /** Scratch space for uploads in flight and test runs. Never os.tmpdir(): tmpfs is RAM. */
  tmpDir: string;
  storageProvider: 'local' | 'vercel-blob';
  storageDir: string;
  /** Token of the (private) Vercel Blob store: server-only; it also signs the tokens browsers upload with. */
  blobReadWriteToken: string | null;
  /** Most the Blob store may hold for this app, in bytes (documents plus what open upload tickets may still bring); 0 = no limit. */
  blobMaxTotalBytes: number;
  /** Most Blob write operations per day (a ticket costs two: its put and the one re-put its client token can still make); 0 = no limit. */
  blobMaxWritesPerDay: number;
  /** Most times one document's file may be opened per day (each open reads the Blob store); 0 = no limit. */
  fileReadsPerDocumentPerDay: number;
  documentRetentionHours: number;
  documentMaxRetentionHours: number;
  cleanupIntervalMinutes: number;
  maxUploadMb: number;
  maxUploadBytes: number;
  maxPages: number;
  maxQueuedJobs: number;
  ingestConcurrency: number;
  ingestPageTimeoutMs: number;
  ingestJobTimeoutMs: number;
  ingestWorkerMaxOldMb: number;
  /** Extra resident memory a running ingestion worker may cause before it is terminated. */
  ingestWorkerMaxRssGrowthMb: number;
  /** How long one tick (one request of the document's ingestion) may go on starting new work, in milliseconds. */
  ingestTickBudgetMs: number;
  /** How long a tick's lease lasts without being renewed: an abandoned tick is taken over after this. */
  ingestLeaseMs: number;
  /** The most one tick may take, however long a unit of work runs (set below the function's maximum duration). */
  ingestTickHardLimitMs: number;
  /** Ticks in a row that died holding the lease after which the document is given up on. */
  ingestMaxAttempts: number;
  /** `gemini` (the default), `tesseract` (optional, self-hosted) or `none`. */
  ocrProvider: 'gemini' | 'tesseract' | 'none';
  /** The Gemini model that reads pages (OCR_PROVIDER=gemini). */
  ocrModel: string;
  /** How many pages go in one request to the model (OCR_PAGES_PER_REQUEST): requests are the scarce quota. */
  ocrPagesPerRequest: number;
  ocrLanguages: string[];
  ocrExtraLanguages: string[];
  ocrMaxPages: number;
  /** The most time OCR may take for one document, in seconds (the pages left are OCR_PARTIAL). */
  ocrMaxSeconds: number;
  ocrCacheDir: string;
  ocrDpi: number;
  ocrMinChars: number;
  embeddingProvider: EmbeddingProvider;
  embeddingModel: string;
  /** Vector size (gemini: outputDimensionality, stored vectors are L2-renormalised). */
  embeddingDimensions: number;
  embeddingBatchSize: number;
  /** Directory of downloaded model files (OCR language packs use OCR_CACHE_DIR); only paths under it are scrubbed from errors. */
  modelCacheDir: string;
  llmProvider: LlmProvider;
  /** Empty only when llmProvider is 'none'. */
  llmModel: string;
  /** The model for rewrites and the grounding check; empty means `llmModel`. */
  llmAuxModel: string;
  llmMaxTokens: number;
  llmTemperature: number;
  /** Server-only. Never logged, never sent to a client. */
  geminiApiKey: string | null;
  /** Requests per minute the process may send to Gemini, all callers together (0 switches the pacing off). */
  geminiMaxRpm: number;
  /**
   * What the app lets itself use of Gemini's free daily quotas, counted in the database for all visitors together (the
   * quotas are one per Google project, not per visitor): answer requests, embedded texts, OCR requests. 0 = no limit
   * (a billed project). Reset at midnight Pacific, like the quotas.
   */
  geminiDailyBudgetLlm: number;
  geminiDailyBudgetEmbed: number;
  geminiDailyBudgetOcr: number;
  /** Requests of the auxiliary model per day (the rewrite of a follow-up and the grounding check); 0 = no limit. */
  geminiDailyBudgetAux: number;
  /**
   * The Gemini key is a free-tier one: the provider may use what is sent to improve its products, so the UI discloses
   * it (`llm.freeTierNotice`). Set GEMINI_FREE_TIER=false for a billed project.
   */
  geminiFreeTier: boolean;
  anthropicApiKey: string | null;
  openaiApiKey: string | null;
  openaiBaseUrl: string;
  ragTopK: number;
  ragCandidates: number;
  ragContextCharBudget: number;
  ragHistoryMessages: number;
  /** Lab 2's guard 2: a yes/no call on the auxiliary model, "does this text contain the answer?" (fails open). */
  ragGroundingCheck: boolean;
  chunkTargetChars: number;
  chunkMaxChars: number;
  chunkMinChars: number;
  chunkOverlapChars: number;
  rateLimitPerMinute: number;
  uploadsPerHour: number;
  uploadsPerHourPerIp: number;
  questionsPerMinute: number;
  /** Ticks per session per minute (the client calls one after another while a document is being read). */
  ticksPerMinute: number;
  /** The bearer secret of the cron endpoint (Vercel sends it as `Authorization: Bearer <CRON_SECRET>`); null: no cron. */
  cronSecret: string | null;
  logLevel: 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace' | 'silent';
}

export interface ConfigIssue {
  variable: string;
  message: string;
}

/** Thrown for an invalid environment. The message lists every invalid variable. */
export class ConfigError extends Error {
  readonly issues: ConfigIssue[];

  constructor(issues: ConfigIssue[]) {
    super(
      `Invalid configuration (check your environment or .env file):\n${issues
        .map((issue) => `  - ${issue.variable}: ${issue.message}`)
        .join('\n')}`,
    );
    this.name = 'ConfigError';
    this.issues = issues;
  }
}

// ---------------------------------------------------------------------------------------------------
// Schema helpers. An unset or blank variable falls back to its default.
// ---------------------------------------------------------------------------------------------------

const blankToUndefined = (value: unknown): unknown =>
  typeof value === 'string' && value.trim() === '' ? undefined : value;

function int(fallback: number, min: number, max = 2_147_483_647) {
  const error = `must be an integer between ${String(min)} and ${String(max)}`;
  return z.preprocess(
    blankToUndefined,
    z.coerce.number({ error }).int({ error }).min(min, { error }).max(max, { error }).default(fallback),
  );
}

/** Like `int`, for a variable whose default depends on others: absent stays `undefined`. */
function optionalInt(min: number, max: number) {
  const error = `must be an integer between ${String(min)} and ${String(max)}`;
  return z.preprocess(
    blankToUndefined,
    z.coerce.number({ error }).int({ error }).min(min, { error }).max(max, { error }).optional(),
  );
}

function decimal(fallback: number, min: number, max: number) {
  const error = `must be a number between ${String(min)} and ${String(max)}`;
  return z.preprocess(
    blankToUndefined,
    z.coerce.number({ error }).min(min, { error }).max(max, { error }).default(fallback),
  );
}

function bool(fallback: boolean) {
  return z.preprocess(
    blankToUndefined,
    z
      .enum(['true', 'false', '1', '0'], { error: 'must be true or false' })
      .default(fallback ? 'true' : 'false')
      .transform((value) => value === 'true' || value === '1'),
  );
}

/** A boolean whose default depends on other variables: absent stays `undefined`. */
const optionalBool = z.preprocess(
  blankToUndefined,
  z
    .enum(['true', 'false', '1', '0'], { error: 'must be true or false' })
    .optional()
    .transform((value) => (value === undefined ? undefined : value === 'true' || value === '1')),
);

function choice<const T extends readonly [string, ...string[]]>(values: T, fallback: T[number]) {
  return z.preprocess(
    blankToUndefined,
    z.enum(values, { error: `must be one of: ${values.join(', ')}` }).default(fallback),
  );
}

function text(fallback: string) {
  return z.preprocess(blankToUndefined, z.string().trim().default(fallback));
}

const optionalText = z.preprocess(blankToUndefined, z.string().trim().optional());

const languagePacks = (fallback: string) =>
  z.preprocess(
    blankToUndefined,
    z
      .string()
      .trim()
      .default(fallback)
      .transform((value) =>
        value
          .split('+')
          .map((pack) => pack.trim())
          .filter(Boolean),
      )
      .refine((packs) => packs.every((pack) => /^[a-z]{3}(_[a-z]+)?$/.test(pack)), {
        error: 'must be Tesseract language codes joined by "+", for example eng+ara',
      }),
  );

const EnvSchema = z.object({
  NODE_ENV: choice(['development', 'test', 'production'], 'development'),
  HOST: text('127.0.0.1'),
  PORT: int(8787, 1, 65_535),
  // Behind a proxy the client address is in X-Forwarded-For; Vercel always is one, so there it defaults to true.
  TRUST_PROXY: optionalBool,
  // Set by Vercel itself (`VERCEL=1`).
  VERCEL: bool(false),
  SESSION_SECRET: z.preprocess(
    blankToUndefined,
    z
      .string()
      .min(MIN_SESSION_SECRET_CHARS, {
        error: `must be at least ${String(MIN_SESSION_SECRET_CHARS)} characters`,
      })
      .optional(),
  ),
  DATABASE_URL: optionalText,
  DATABASE_URL_UNPOOLED: optionalText,
  DATABASE_POOL_MAX: int(3, 1, 50),
  PGLITE_DATA_DIR: text('./.data/pglite'),
  // On Vercel the only writable place is /tmp (500 MB, per instance).
  TMP_DIR: optionalText,
  STORAGE_PROVIDER: choice(['local', 'vercel-blob'], 'local'),
  STORAGE_DIR: text('./.data/uploads'),
  BLOB_READ_WRITE_TOKEN: optionalText,
  // The free Blob store holds 1 GB and allows 2,000 advanced operations and 10 GB of transfer a month, and going over blocks
  // it for 30 days: the app keeps itself well under (these are counted in the database, for all visitors together).
  BLOB_MAX_TOTAL_MB: int(800, 0, 1_000_000),
  BLOB_MAX_WRITES_PER_DAY: int(60, 0, 1_000_000),
  FILE_READS_PER_DOC_PER_DAY: int(20, 0, 1_000_000),
  // Set by Vercel itself: production, preview or development.
  VERCEL_ENV: optionalText,
  ALLOW_PREVIEW_DATA: bool(false),
  DOCUMENT_RETENTION_HOURS: decimal(24, 0.01, 24 * 365),
  DOCUMENT_MAX_RETENTION_HOURS: decimal(72, 0.01, 24 * 365),
  CLEANUP_INTERVAL_MINUTES: decimal(30, 0.01, 24 * 60),
  // 50 MB; 20 MB with a Blob store (one write operation each, and the store is small). The default is chosen below.
  MAX_UPLOAD_MB: optionalInt(1, 2048),
  MAX_PAGES: int(300, 1, 100_000),
  MAX_QUEUED_JOBS: int(3, 1, 1000),
  INGEST_CONCURRENCY: int(1, 1, 16),
  INGEST_PAGE_TIMEOUT_MS: int(20_000, 100),
  INGEST_JOB_TIMEOUT_MS: int(1_800_000, 1000),
  INGEST_WORKER_MAX_OLD_MB: int(768, 64, 16_384),
  INGEST_WORKER_MAX_RSS_GROWTH_MB: int(512, 64, 16_384),
  INGEST_TICK_BUDGET_MS: int(45_000, 1000, 600_000),
  INGEST_LEASE_MS: int(60_000, 1000, 600_000),
  INGEST_TICK_HARD_LIMIT_MS: int(240_000, 5000, 900_000),
  INGEST_MAX_ATTEMPTS: int(3, 1, 100),
  OCR_PROVIDER: choice(['gemini', 'tesseract', 'none'], 'gemini'),
  OCR_MODEL: text('gemini-3.5-flash-lite'),
  OCR_PAGES_PER_REQUEST: int(8, 1, 50),
  OCR_LANGUAGES: languagePacks('eng+ara'),
  OCR_EXTRA_LANGUAGES: languagePacks('fra+spa+deu+ita+por+tur+fas+urd'),
  OCR_MAX_PAGES: int(60, 0, 100_000),
  // At most the 600 s the host's watchdog gives one request to the model (BATCH_TIMEOUT_MS in ingest/worker/ocr-task.ts, which a
  // test keeps equal to this): a longer budget would let the watchdog kill a request before the budget fires, and a stop by the
  // watchdog is not a stop by the time allowed.
  OCR_MAX_SECONDS: int(600, 1, 600),
  OCR_CACHE_DIR: text('./.data/tessdata'),
  OCR_DPI: int(200, 72, 600),
  OCR_MIN_CHARS: int(25, 0, 10_000),
  EMBEDDING_PROVIDER: choice(['gemini', 'openai'], 'gemini'),
  EMBEDDING_MODEL: optionalText,
  EMBEDDING_DIMENSIONS: int(768, 64, 4096),
  EMBEDDING_BATCH_SIZE: int(16, 1, 512),
  MODEL_CACHE_DIR: text('./.data/models'),
  LLM_PROVIDER: choice(['gemini', 'anthropic', 'openai', 'none'], 'gemini'),
  LLM_MODEL: optionalText,
  LLM_AUX_MODEL: optionalText,
  LLM_MAX_TOKENS: int(900, 16, 32_768),
  LLM_TEMPERATURE: decimal(0.2, 0, 2),
  GEMINI_API_KEY: optionalText,
  GEMINI_MAX_RPM: int(10, 0, 100_000),
  // About 80% of what the free tier is believed to give per day (unpublished; see the README). Answers and OCR share the
  // 500 requests of the lite model, so 300 + 100 here; the embedding quota counts texts (about 1,000 a day).
  GEMINI_DAILY_BUDGET_LLM: int(300, 0, 100_000_000),
  GEMINI_DAILY_BUDGET_EMBED: int(800, 0, 100_000_000),
  GEMINI_DAILY_BUDGET_OCR: int(100, 0, 100_000_000),
  // An answer makes up to two calls on the auxiliary model (the rewrite of a follow-up, the grounding check): 400 of the
  // 500 requests of its bucket.
  GEMINI_DAILY_BUDGET_AUX: int(400, 0, 100_000_000),
  GEMINI_FREE_TIER: bool(true),
  ANTHROPIC_API_KEY: optionalText,
  OPENAI_API_KEY: optionalText,
  OPENAI_BASE_URL: z.preprocess(
    blankToUndefined,
    z
      .url({ error: 'must be an absolute URL such as https://api.openai.com/v1' })
      .default(DEFAULT_OPENAI_BASE_URL),
  ),
  RAG_TOP_K: int(6, 1, 64),
  RAG_CANDIDATES: int(24, 1, 512),
  RAG_CONTEXT_CHAR_BUDGET: int(16_000, 500, 200_000),
  RAG_HISTORY_MESSAGES: int(6, 0, 50),
  RAG_GROUNDING_CHECK: bool(true),
  // About 600 to 900 tokens a chunk: the free embedding quota is counted per chunk (about 1,000 a day), so a book only
  // fits when chunks are this big (gemini-embedding-2 takes 8,192 tokens).
  CHUNK_TARGET_CHARS: int(2000, 100, 20_000),
  CHUNK_MAX_CHARS: int(3000, 100, 40_000),
  CHUNK_MIN_CHARS: int(400, 1, 10_000),
  CHUNK_OVERLAP_CHARS: int(200, 0, 5000),
  RATE_LIMIT_PER_MINUTE: int(120, 1, 1_000_000),
  UPLOADS_PER_HOUR: int(20, 1, 1_000_000),
  UPLOADS_PER_HOUR_PER_IP: int(10, 1, 1_000_000),
  QUESTIONS_PER_MINUTE: int(20, 1, 1_000_000),
  // A client ticks one after another while a document is read (about one a minute on the soft budget, a few at a burst): well
  // under RATE_LIMIT_PER_MINUTE, so that the limit is a limit.
  TICKS_PER_MINUTE: int(60, 1, 1_000_000),
  CRON_SECRET: optionalText,
  LOG_LEVEL: choice(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'], 'info'),
});

/** Every environment variable the server reads. */
export const CONFIG_VARIABLES: readonly string[] = Object.keys(EnvSchema.shape);

/** Relative paths resolve against the repository root; absolute paths and `memory://` are kept. */
function resolveDataPath(value: string): string {
  if (value === MEMORY_DATA_DIR) return value;
  return path.isAbsolute(value) ? path.normalize(value) : path.resolve(REPO_ROOT, value);
}

/** Parses and validates the environment. Throws a ConfigError that lists every invalid variable. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    throw new ConfigError(
      parsed.error.issues.map((issue) => {
        const variable = String(issue.path[0] ?? 'environment');
        const received = env[variable];
        return {
          variable,
          message:
            received === undefined || variable === 'SESSION_SECRET'
              ? issue.message
              : `${issue.message} (received "${received}")`,
        };
      }),
    );
  }
  const e = parsed.data;
  const issues: ConfigIssue[] = [];
  const problem = (variable: string, message: string): void => {
    issues.push({ variable, message });
  };

  const isProduction = e.NODE_ENV === 'production';
  if (isProduction && e.SESSION_SECRET === undefined) {
    problem(
      'SESSION_SECRET',
      `is required in production (at least ${String(MIN_SESSION_SECRET_CHARS)} random characters)`,
    );
  }

  const llmModel = e.LLM_MODEL ?? defaultLlmModelFor(e.LLM_PROVIDER) ?? '';
  if (e.LLM_PROVIDER === 'openai' && llmModel === '') {
    problem(
      'LLM_MODEL',
      'is required when LLM_PROVIDER=openai (there is no default model for an OpenAI-compatible endpoint)',
    );
  }
  const embeddingModel = e.EMBEDDING_MODEL ?? defaultEmbeddingModelFor(e.EMBEDDING_PROVIDER) ?? '';
  if (e.EMBEDDING_PROVIDER === 'openai' && embeddingModel === '') {
    problem(
      'EMBEDDING_MODEL',
      'is required when EMBEDDING_PROVIDER=openai (for example text-embedding-3-small)',
    );
  }
  if (e.DOCUMENT_MAX_RETENTION_HOURS < e.DOCUMENT_RETENTION_HOURS) {
    problem('DOCUMENT_MAX_RETENTION_HOURS', 'must not be smaller than DOCUMENT_RETENTION_HOURS');
  }
  if (e.CHUNK_MAX_CHARS < e.CHUNK_TARGET_CHARS) {
    problem('CHUNK_MAX_CHARS', 'must not be smaller than CHUNK_TARGET_CHARS');
  }
  if (e.CHUNK_MIN_CHARS > e.CHUNK_TARGET_CHARS) {
    problem('CHUNK_MIN_CHARS', 'must not be larger than CHUNK_TARGET_CHARS');
  }
  if (e.RAG_CANDIDATES < e.RAG_TOP_K) {
    problem('RAG_CANDIDATES', 'must not be smaller than RAG_TOP_K');
  }
  if (e.INGEST_TICK_HARD_LIMIT_MS <= e.INGEST_TICK_BUDGET_MS) {
    problem('INGEST_TICK_HARD_LIMIT_MS', 'must be larger than INGEST_TICK_BUDGET_MS');
  }
  if (e.STORAGE_PROVIDER === 'vercel-blob' && e.INGEST_TICK_HARD_LIMIT_MS < BLOB_MIN_HARD_LIMIT_MS) {
    problem(
      'INGEST_TICK_HARD_LIMIT_MS',
      `must be at least ${String(BLOB_MIN_HARD_LIMIT_MS)} with STORAGE_PROVIDER=vercel-blob (a read of the store has to fit in what is left after the 5 s a tick keeps free to wind down: with less, every document would end as a store that does not answer)`,
    );
  }
  if (e.OCR_PROVIDER !== 'none' && e.INGEST_TICK_HARD_LIMIT_MS < OCR_MIN_HARD_LIMIT_MS) {
    problem(
      'INGEST_TICK_HARD_LIMIT_MS',
      `must be at least ${String(OCR_MIN_HARD_LIMIT_MS)} while OCR is on (an OCR call needs 3 s after the 5 s a tick keeps free to wind down)`,
    );
  }
  if (e.STORAGE_PROVIDER === 'vercel-blob' && e.BLOB_READ_WRITE_TOKEN === undefined) {
    problem(
      'BLOB_READ_WRITE_TOKEN',
      'is required when STORAGE_PROVIDER=vercel-blob (the read-write token of the private Blob store)',
    );
  }
  if (e.VERCEL) {
    // Settings that cannot work on a Vercel function are refused at start, not discovered by the first visitor.
    if (e.STORAGE_PROVIDER === 'local') {
      problem(
        'STORAGE_PROVIDER',
        'must be vercel-blob on Vercel (the disk of a function is read-only except /tmp, and is not shared between instances)',
      );
    }
    if (e.SESSION_SECRET === undefined) {
      problem(
        'SESSION_SECRET',
        `is required on Vercel (at least ${String(MIN_SESSION_SECRET_CHARS)} random characters): every instance must sign sessions with the same secret`,
      );
    }
    if (e.TMP_DIR !== undefined && !(e.TMP_DIR === '/tmp' || e.TMP_DIR.startsWith('/tmp/'))) {
      problem(
        'TMP_DIR',
        'must be under /tmp on Vercel (the only writable place of a function: anywhere else is read-only)',
      );
    }
    if (e.INGEST_TICK_HARD_LIMIT_MS > VERCEL_MAX_DURATION_MS - VERCEL_DURATION_MARGIN_MS) {
      problem(
        'INGEST_TICK_HARD_LIMIT_MS',
        `must be at most ${String(VERCEL_MAX_DURATION_MS - VERCEL_DURATION_MARGIN_MS)} on Vercel (the function is stopped at ${String(VERCEL_MAX_DURATION_MS)}: maxDuration in vercel.json)`,
      );
    }
  }
  if (e.VERCEL && e.DATABASE_URL === undefined) {
    problem(
      'DATABASE_URL',
      'is required on Vercel (the embedded database needs a writable disk; use the pooled Neon connection string)',
    );
  }
  if (issues.length > 0) throw new ConfigError(issues);

  const maxUploadMb =
    e.MAX_UPLOAD_MB ??
    (e.STORAGE_PROVIDER === 'vercel-blob' ? DEFAULT_MAX_UPLOAD_MB_BLOB : DEFAULT_MAX_UPLOAD_MB);
  const generatedSecret = e.SESSION_SECRET === undefined;
  return {
    nodeEnv: e.NODE_ENV,
    isProduction,
    host: e.HOST,
    port: e.PORT,
    trustProxy: e.TRUST_PROXY ?? e.VERCEL,
    onVercel: e.VERCEL,
    vercelEnv: e.VERCEL_ENV ?? null,
    allowPreviewData: e.ALLOW_PREVIEW_DATA,
    sessionSecret: e.SESSION_SECRET ?? randomBytes(32).toString('hex'),
    sessionSecretGenerated: generatedSecret,
    databaseUrl: e.DATABASE_URL ?? null,
    databaseUrlUnpooled: e.DATABASE_URL_UNPOOLED ?? null,
    databasePoolMax: e.DATABASE_POOL_MAX,
    pgliteDataDir: resolveDataPath(e.PGLITE_DATA_DIR),
    tmpDir: resolveDataPath(e.TMP_DIR ?? (e.VERCEL ? VERCEL_TMP_DIR : './.data/tmp')),
    storageProvider: e.STORAGE_PROVIDER,
    storageDir: resolveDataPath(e.STORAGE_DIR),
    blobReadWriteToken: e.BLOB_READ_WRITE_TOKEN ?? null,
    blobMaxTotalBytes: e.BLOB_MAX_TOTAL_MB * 1024 * 1024,
    blobMaxWritesPerDay: e.BLOB_MAX_WRITES_PER_DAY,
    fileReadsPerDocumentPerDay: e.FILE_READS_PER_DOC_PER_DAY,
    documentRetentionHours: e.DOCUMENT_RETENTION_HOURS,
    documentMaxRetentionHours: e.DOCUMENT_MAX_RETENTION_HOURS,
    cleanupIntervalMinutes: e.CLEANUP_INTERVAL_MINUTES,
    maxUploadMb: maxUploadMb,
    maxUploadBytes: maxUploadMb * 1024 * 1024,
    maxPages: e.MAX_PAGES,
    maxQueuedJobs: e.MAX_QUEUED_JOBS,
    ingestConcurrency: e.INGEST_CONCURRENCY,
    ingestPageTimeoutMs: e.INGEST_PAGE_TIMEOUT_MS,
    ingestJobTimeoutMs: e.INGEST_JOB_TIMEOUT_MS,
    ingestWorkerMaxOldMb: e.INGEST_WORKER_MAX_OLD_MB,
    ingestWorkerMaxRssGrowthMb: e.INGEST_WORKER_MAX_RSS_GROWTH_MB,
    ingestTickBudgetMs: e.INGEST_TICK_BUDGET_MS,
    ingestLeaseMs: e.INGEST_LEASE_MS,
    ingestTickHardLimitMs: e.INGEST_TICK_HARD_LIMIT_MS,
    ingestMaxAttempts: e.INGEST_MAX_ATTEMPTS,
    ocrProvider: e.OCR_PROVIDER,
    ocrModel: e.OCR_MODEL,
    ocrPagesPerRequest: e.OCR_PAGES_PER_REQUEST,
    ocrLanguages: e.OCR_LANGUAGES,
    ocrExtraLanguages: e.OCR_EXTRA_LANGUAGES,
    ocrMaxPages: e.OCR_MAX_PAGES,
    ocrMaxSeconds: e.OCR_MAX_SECONDS,
    ocrCacheDir: resolveDataPath(e.OCR_CACHE_DIR),
    ocrDpi: e.OCR_DPI,
    ocrMinChars: e.OCR_MIN_CHARS,
    embeddingProvider: e.EMBEDDING_PROVIDER,
    embeddingModel,
    embeddingDimensions: e.EMBEDDING_DIMENSIONS,
    embeddingBatchSize: e.EMBEDDING_BATCH_SIZE,
    modelCacheDir: resolveDataPath(e.MODEL_CACHE_DIR),
    llmProvider: e.LLM_PROVIDER,
    llmModel,
    llmAuxModel: e.LLM_AUX_MODEL ?? defaultLlmAuxModelFor(e.LLM_PROVIDER),
    llmMaxTokens: e.LLM_MAX_TOKENS,
    llmTemperature: e.LLM_TEMPERATURE,
    geminiApiKey: e.GEMINI_API_KEY ?? null,
    geminiMaxRpm: e.GEMINI_MAX_RPM,
    geminiDailyBudgetLlm: e.GEMINI_DAILY_BUDGET_LLM,
    geminiDailyBudgetEmbed: e.GEMINI_DAILY_BUDGET_EMBED,
    geminiDailyBudgetOcr: e.GEMINI_DAILY_BUDGET_OCR,
    geminiDailyBudgetAux: e.GEMINI_DAILY_BUDGET_AUX,
    geminiFreeTier: e.GEMINI_FREE_TIER,
    anthropicApiKey: e.ANTHROPIC_API_KEY ?? null,
    openaiApiKey: e.OPENAI_API_KEY ?? null,
    openaiBaseUrl: e.OPENAI_BASE_URL,
    ragTopK: e.RAG_TOP_K,
    ragCandidates: e.RAG_CANDIDATES,
    ragContextCharBudget: e.RAG_CONTEXT_CHAR_BUDGET,
    ragHistoryMessages: e.RAG_HISTORY_MESSAGES,
    ragGroundingCheck: e.RAG_GROUNDING_CHECK,
    chunkTargetChars: e.CHUNK_TARGET_CHARS,
    chunkMaxChars: e.CHUNK_MAX_CHARS,
    chunkMinChars: e.CHUNK_MIN_CHARS,
    chunkOverlapChars: e.CHUNK_OVERLAP_CHARS,
    rateLimitPerMinute: e.RATE_LIMIT_PER_MINUTE,
    uploadsPerHour: e.UPLOADS_PER_HOUR,
    uploadsPerHourPerIp: e.UPLOADS_PER_HOUR_PER_IP,
    questionsPerMinute: e.QUESTIONS_PER_MINUTE,
    ticksPerMinute: e.TICKS_PER_MINUTE,
    cronSecret: e.CRON_SECRET ?? null,
    logLevel: e.LOG_LEVEL,
  };
}

/**
 * Whether the configured chat provider can be used at all: a key for the hosted providers (an
 * OpenAI-compatible endpoint other than api.openai.com, such as Ollama, needs none), never for `none`. This is configuration only; it does not probe the provider.
 */
export function isLlmConfigured(config: Config): boolean {
  switch (config.llmProvider) {
    case 'gemini':
      return config.geminiApiKey !== null;
    case 'anthropic':
      return config.anthropicApiKey !== null;
    case 'openai':
      return config.openaiApiKey !== null || config.openaiBaseUrl !== DEFAULT_OPENAI_BASE_URL;
    case 'none':
      return false;
  }
}

/**
 * Whether this process may do work that deletes or changes data it has not made itself: apply migrations, remove expired
 * documents and the blobs nobody claimed. True in production and off Vercel; on Vercel's preview and development environments
 * only with ALLOW_PREVIEW_DATA=true, which says the environment has a database and a Blob store of its own. A preview that was
 * given the production DATABASE_URL (or the production Blob token) must not touch what it finds there.
 */
export function mayDeleteData(config: Pick<Config, 'vercelEnv' | 'allowPreviewData'>): boolean {
  return config.vercelEnv === null || config.vercelEnv === 'production' || config.allowPreviewData;
}
