import type { Health, PublicConfig } from '@enchanted/shared';
import type { FastifyInstance } from 'fastify';
import { ACCEPTED_MIME_TYPES, isLlmConfigured, type Config } from '../config.js';
import type { Db } from '../db/client.js';
import type { LLMProvider } from '../llm/provider.js';

/**
 * Which provider implementations are wired into this build of the server. The configuration only says what
 * the operator asked for; these say whether the code behind it exists and works. `/api/health` and `/api/config`
 * report 'unconfigured' / unavailable rather than claim a capability that is not there.
 *
 * `ocr` is a flag, or a function that says what is known about the OCR engine without starting it: true, false, or null
 * while it has not been checked yet or the check is running (`CachedAvailability.peek`). A health or config call never
 * waits for the engine and never starts it: it is checked after the embedding model has loaded, and by the first
 * scanned page.
 */
export interface ProviderReadiness {
  embeddings: boolean;
  /** What the embeddings are, as the wired-in provider reports it (a stand-in in the end-to-end server is not "gemini"). */
  embeddingsInfo?: { provider: string; model: string };
  ocr: boolean | (() => boolean | null);
  /** What /api/health calls the embeddings provider once it is ready, such as `gemini:gemini-embedding-2`. */
  embeddingsLabel?: string;
  /**
   * The chat provider that is wired in. When it is given, `/api/health` and `/api/config` report what it really is
   * (name, model, whether it can answer); without it they fall back to what the configuration asks for.
   */
  llm?: Pick<LLMProvider, 'name' | 'model' | 'isConfigured'>;
}

export const NO_PROVIDERS_READY: ProviderReadiness = { embeddings: false, ocr: false };

const UNCONFIGURED = 'unconfigured';

/** What is known about OCR: false when OCR_PROVIDER=none, null while the engine has not been checked yet. */
function ocrReady(config: Config, ready: ProviderReadiness): boolean | null {
  if (config.ocrProvider === 'none') return false;
  return typeof ready.ocr === 'function' ? ready.ocr() : ready.ocr;
}

/** The OCR entry of the health report: `none`, `gemini:<model>` or `tesseract`, `unconfigured` (it cannot start), or `checking`. */
function describeOcr(config: Config, ready: ProviderReadiness): string {
  if (config.ocrProvider === 'none') return 'none';
  const known = ocrReady(config, ready);
  if (known === null) return 'checking';
  if (!known) return UNCONFIGURED;
  return config.ocrProvider === 'gemini' ? `gemini:${config.ocrModel}` : config.ocrProvider;
}

/** `anthropic:claude-sonnet-5-5`, `none`, or `unconfigured` when the provider cannot answer (no key). */
function describeLlm(config: Config, ready: ProviderReadiness): string {
  const provider = ready.llm?.name ?? config.llmProvider;
  if (provider === 'none') return 'none';
  if (!(ready.llm?.isConfigured() ?? isLlmConfigured(config))) return UNCONFIGURED;
  const model = ready.llm?.model ?? config.llmModel;
  return model === '' ? provider : `${provider}:${model}`;
}

/** Provider names for the health report: the configured name, or 'unconfigured' when unusable. */
export function describeProviders(config: Config, ready: ProviderReadiness): Health['providers'] {
  return {
    llm: describeLlm(config, ready),
    embeddings: ready.embeddings ? (ready.embeddingsLabel ?? config.embeddingProvider) : UNCONFIGURED,
    ocr: describeOcr(config, ready),
  };
}

/**
 * Whether anything a visitor entrusts to the diary (document text, questions, answers) is sent to Gemini on a free-tier
 * key, whose terms let Google use it to improve its products: the UI then says so before the first upload.
 */
function freeTierNotice(config: Config, ready: ProviderReadiness): boolean {
  const sendsToGemini =
    (ready.llm?.name ?? config.llmProvider) === 'gemini' ||
    (ready.embeddingsInfo?.provider ?? config.embeddingProvider) === 'gemini' ||
    config.ocrProvider === 'gemini';
  return sendsToGemini && config.geminiFreeTier;
}

export function describePublicConfig(config: Config, ready: ProviderReadiness): PublicConfig {
  return {
    maxUploadBytes: config.maxUploadBytes,
    maxPages: config.maxPages,
    acceptedMimeTypes: [...ACCEPTED_MIME_TYPES],
    llm: {
      provider: ready.llm?.name ?? config.llmProvider,
      model: ready.llm?.model ?? config.llmModel,
      available: ready.llm?.isConfigured() ?? isLlmConfigured(config),
      profile: 'standard',
      freeTierNotice: freeTierNotice(config, ready),
    },
    embeddings: {
      provider: ready.embeddingsInfo?.provider ?? config.embeddingProvider,
      model: ready.embeddingsInfo?.model ?? config.embeddingModel,
      available: ready.embeddings,
    },
    ocr: { provider: config.ocrProvider, available: ocrReady(config, ready) === true },
  };
}

/** `GET /api/health` and `GET /api/config`. Both are public: no session is created for them. */
export function registerStatusRoutes(
  app: FastifyInstance,
  config: Config,
  db: Db,
  ready: ProviderReadiness,
): void {
  app.get('/api/health', { config: { public: true, unlimited: true } }, async (request, reply) => {
    let ok = true;
    try {
      await db.query('SELECT 1');
    } catch (error) {
      ok = false;
      request.log.error({ err: error }, 'health check: database unreachable');
    }
    const body: Health = { ok, db: db.kind, providers: describeProviders(config, ready) };
    return reply.status(ok ? 200 : 503).send(body);
  });

  app.get('/api/config', { config: { public: true } }, () => describePublicConfig(config, ready));
}
