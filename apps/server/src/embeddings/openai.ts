import { z } from 'zod';
import { EmbeddingError, throwIfAborted, type EmbeddingProvider } from './provider.js';

const DEFAULT_MAX_INPUT_TOKENS = 8191;
const REQUEST_TIMEOUT_MS = 60_000;
const MAX_RETRY_DELAY_MS = 30_000;

const ResponseSchema = z.object({
  data: z.array(z.object({ index: z.number().int(), embedding: z.array(z.number()) })),
});

export interface OpenAIEmbeddingOptions {
  /** OPENAI_BASE_URL, for example https://api.openai.com/v1 (or an Ollama / LM Studio / vLLM / Groq endpoint). */
  baseUrl: string;
  /** Optional: local servers need none. Only ever sent as the Authorization header; never logged. */
  apiKey: string | null;
  model: string;
  batchSize: number;
  maxInputTokens?: number;
  maxRetries?: number;
  retryBaseDelayMs?: number;
  /** For tests. */
  fetch?: typeof fetch;
  sleep?: (ms: number, signal: AbortSignal | undefined) => Promise<void>;
  /** Told about retries (status and attempt only: no URL query, no headers, no key). */
  onRetry?: (info: { status: number | null; attempt: number; delayMs: number }) => void;
}

const defaultSleep = (ms: number, signal: AbortSignal | undefined): Promise<void> =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(signal.reason instanceof Error ? signal.reason : new DOMException('Aborted', 'AbortError'));
      },
      { once: true },
    );
  });

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch (error) {
    throw new EmbeddingError('The embedding service answered with something that is not JSON', {
      cause: error,
    });
  }
}

/** Seconds in a Retry-After header, as milliseconds (dates are not supported: backoff is used instead). */
function retryAfterMs(header: string | null): number | null {
  if (header === null) return null;
  const seconds = Number(header);
  return Number.isFinite(seconds) && seconds >= 0 ? Math.min(MAX_RETRY_DELAY_MS, seconds * 1000) : null;
}

/**
 * Embeddings from any OpenAI-compatible `/embeddings` endpoint. Inputs go out in batches; 429 and 5xx answers
 * (and dropped connections) are retried with exponential backoff and jitter, honouring Retry-After; other
 * client errors fail at once. The API key goes in the Authorization header and nowhere else: it is not part of
 * any error message or log line.
 */
export class OpenAICompatibleEmbeddings implements EmbeddingProvider {
  readonly name = 'openai';
  readonly model: string;
  readonly maxInputTokens: number;
  private dims: number | null = null;
  private readonly options: OpenAIEmbeddingOptions;
  private readonly endpoint: string;

  constructor(options: OpenAIEmbeddingOptions) {
    this.options = options;
    this.model = options.model;
    this.maxInputTokens = options.maxInputTokens ?? DEFAULT_MAX_INPUT_TOKENS;
    this.endpoint = `${options.baseUrl.replace(/\/+$/u, '')}/embeddings`;
  }

  get dimensions(): number | null {
    return this.dims;
  }

  /** api.openai.com needs a key; any other endpoint (Ollama, LM Studio, vLLM, Groq) may need none. */
  isConfigured(): boolean {
    return (
      this.options.apiKey !== null || !/^https:\/\/api\.openai\.com(?:\/|$)/iu.test(this.options.baseUrl)
    );
  }

  private async request(input: readonly string[], signal: AbortSignal | undefined): Promise<number[][]> {
    const fetchImpl = this.options.fetch ?? fetch;
    const sleep = this.options.sleep ?? defaultSleep;
    const maxRetries = this.options.maxRetries ?? 4;
    const baseDelay = this.options.retryBaseDelayMs ?? 500;
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (this.options.apiKey !== null) headers.authorization = `Bearer ${this.options.apiKey}`;
    const body = JSON.stringify({ model: this.model, input, encoding_format: 'float' });

    for (let attempt = 0; ; attempt += 1) {
      throwIfAborted(signal);
      let response: Response | null = null;
      let networkError: unknown;
      try {
        const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
        response = await fetchImpl(this.endpoint, {
          method: 'POST',
          headers,
          body,
          signal: signal === undefined ? timeout : AbortSignal.any([signal, timeout]),
        });
      } catch (error) {
        throwIfAborted(signal); // the caller cancelled: not a failure to retry
        networkError = error; // a dropped connection or a timeout: retried below
      }

      let retryAfter: number | null = null;
      if (response !== null) {
        if (response.ok) return this.parse(await readJson(response), input.length);
        if (response.status !== 429 && response.status < 500) {
          throw new EmbeddingError(
            `The embedding service refused the request (HTTP ${String(response.status)})`,
            {
              status: response.status,
            },
          );
        }
        retryAfter = retryAfterMs(response.headers.get('retry-after'));
      }

      const status = response?.status ?? null;
      if (attempt >= maxRetries) {
        throw new EmbeddingError(
          status === null
            ? 'The embedding service could not be reached'
            : `The embedding service kept failing (HTTP ${String(status)})`,
          { retryable: true, ...(status === null ? {} : { status }), cause: networkError },
        );
      }
      const delay =
        retryAfter ?? Math.min(MAX_RETRY_DELAY_MS, baseDelay * 2 ** attempt * (0.75 + Math.random() * 0.5));
      this.options.onRetry?.({ status, attempt: attempt + 1, delayMs: delay });
      await sleep(delay, signal);
    }
  }

  private parse(json: unknown, expected: number): number[][] {
    const parsed = ResponseSchema.safeParse(json);
    if (!parsed.success || parsed.data.data.length !== expected) {
      throw new EmbeddingError('The embedding service answered with an unexpected response');
    }
    const vectors = [...parsed.data.data].sort((a, b) => a.index - b.index).map((item) => item.embedding);
    const size = vectors[0]?.length ?? 0;
    if (size === 0 || vectors.some((vector) => vector.length !== size)) {
      throw new EmbeddingError('The embedding service answered with vectors of different sizes');
    }
    this.dims = size;
    return vectors;
  }

  async embedPassages(texts: readonly string[], signal?: AbortSignal): Promise<number[][]> {
    const vectors: number[][] = [];
    for (let offset = 0; offset < texts.length; offset += this.options.batchSize) {
      vectors.push(...(await this.request(texts.slice(offset, offset + this.options.batchSize), signal)));
    }
    return vectors;
  }

  async embedQuery(text: string, signal?: AbortSignal): Promise<number[]> {
    const [vector] = await this.request([text], signal);
    if (vector === undefined) throw new EmbeddingError('The embedding service returned no vector');
    return vector;
  }
}
