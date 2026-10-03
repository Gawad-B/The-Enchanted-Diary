import type { EmbedContentParameters, EmbedContentResponse } from '@google/genai';
import {
  GeminiPacer,
  classifyGeminiError,
  getGeminiClient,
  isAbortLike,
  isDailyQuotaError,
  mapGeminiError,
  withGeminiRetry,
  type RetryOptions,
} from '../gemini/index.js';
import {
  EmbeddingError,
  throwIfAborted,
  type EmbeddingProvider,
  type PassageOptions,
  type QueryOptions,
} from './provider.js';

/**
 * Google Gemini embeddings (default model gemini-embedding-2) through the shared client:
 *  - gemini-embedding-2 has NO `taskType`: the task is written into the text instead. A passage is embedded as
 *    `title: <title or none> | text: <chunk>`, a question as `task: search result | query: <question>` (the documented
 *    pairing; the same prefixes are applied here and nowhere else, so stored vectors and query vectors always match);
 *  - every text goes in as its OWN Content (`{ parts: [{ text }] }`): a plain string array, or one Content with several
 *    parts, comes back as ONE aggregated vector, which would silently shift every chunk after it. The number of vectors
 *    that comes back is checked against the number of texts sent;
 *  - `outputDimensionality` shortens the vectors to EMBEDDING_DIMENSIONS (768). The model normalises shortened vectors
 *    itself; they are L2-normalised here again anyway (cosine similarity is then a dot product);
 *  - passages go in batches of at most `batchSize` (never more than the 100 an embedContent request takes), each batch
 *    retried on 429 / 5xx with backoff;
 *  - the free quota counts every text of a batch (about 100 a minute, 1,000 a day), so each text takes a slot of the
 *    embedding pacer before its batch is sent. A day's quota used up is an EmbeddingError with `dailyQuota` set.
 * The API key never appears in an error: the messages are our own.
 */

export interface GeminiEmbedClientLike {
  models: { embedContent(params: EmbedContentParameters): Promise<EmbedContentResponse> };
}

export interface GeminiEmbeddingsOptions {
  apiKey: string | null;
  model: string;
  dimensions: number;
  batchSize: number;
  client?: GeminiEmbedClientLike;
  retry?: RetryOptions;
  /** Paces the texts sent per minute (a test passes its own; the default is shared by the process). */
  pacer?: GeminiPacer;
}

/** Documented limit of one embedContent request. */
export const GEMINI_MAX_BATCH = 100;
/** Longest input in tokens, as documented for gemini-embedding-2 (the chunker stays far below it). */
export const GEMINI_EMBEDDING_MAX_INPUT_TOKENS = 8192;
/** Texts per minute the free tier takes for gemini-embedding-2 (100), with a little room. */
export const GEMINI_EMBEDDING_TEXTS_PER_MINUTE = 90;

/** The text of a passage as the model is meant to see it. */
export function passageText(text: string, title?: string | null): string {
  const heading = (title ?? '').replace(/\s+/gu, ' ').trim();
  return `title: ${heading === '' ? 'none' : heading} | text: ${text}`;
}

/** The text of a question as the model is meant to see it. */
export function queryText(text: string): string {
  return `task: search result | query: ${text}`;
}

export function l2Normalize(vector: readonly number[]): number[] {
  const length = Math.hypot(...vector);
  return length === 0 ? [...vector] : vector.map((value) => value / length);
}

let sharedPacer: GeminiPacer | null = null;
const processPacer = (): GeminiPacer => {
  sharedPacer ??= new GeminiPacer({ maxPerMinute: GEMINI_EMBEDDING_TEXTS_PER_MINUTE });
  return sharedPacer;
};

export class GeminiEmbeddings implements EmbeddingProvider {
  readonly name = 'gemini';
  readonly reportsSend = true;
  readonly model: string;
  readonly dimensions: number;
  readonly maxInputTokens = GEMINI_EMBEDDING_MAX_INPUT_TOKENS;
  private readonly options: GeminiEmbeddingsOptions;

  constructor(options: GeminiEmbeddingsOptions) {
    this.options = options;
    this.model = options.model;
    this.dimensions = options.dimensions;
  }

  isConfigured(): boolean {
    return this.options.apiKey !== null || this.options.client !== undefined;
  }

  private client(): GeminiEmbedClientLike {
    if (this.options.client !== undefined) return this.options.client;
    if (this.options.apiKey === null) {
      throw new EmbeddingError('No Gemini API key is configured on this server.', { unconfigured: true });
    }
    return getGeminiClient({ geminiApiKey: this.options.apiKey });
  }

  /** `inputs` are the final texts (prefix included); one vector comes back for each, in order. */
  private async embed(
    inputs: readonly string[],
    signal: AbortSignal | undefined,
    onSent?: () => void,
  ): Promise<number[][]> {
    throwIfAborted(signal);
    const client = this.client();
    const pacer = this.options.pacer ?? processPacer();
    const batch = Math.max(1, Math.min(this.options.batchSize, GEMINI_MAX_BATCH));
    const vectors: number[][] = [];
    // the first request that leaves is announced, once (a retry or a later batch is not another announcement)
    let announced = false;
    for (let offset = 0; offset < inputs.length; offset += batch) {
      throwIfAborted(signal);
      const slice = inputs.slice(offset, offset + batch);
      for (const _text of slice) await pacer.acquire(signal);
      let response: EmbedContentResponse;
      try {
        response = await withGeminiRetry(
          () => {
            if (!announced) {
              announced = true;
              onSent?.();
            }
            return client.models.embedContent({
              model: this.model,
              // One Content per text. Never `contents: slice` (strings) or several parts in one Content: both give ONE vector.
              contents: slice.map((text) => ({ parts: [{ text }] })),
              config: {
                outputDimensionality: this.dimensions,
                ...(signal === undefined ? {} : { abortSignal: signal }),
              },
            });
          },
          { ...this.options.retry, ...(signal === undefined ? {} : { signal }) },
        );
      } catch (error) {
        if (signal?.aborted === true || isAbortLike(error)) throw error;
        const classified = classifyGeminiError(error);
        const mapped = mapGeminiError(error);
        throw new EmbeddingError(`Embedding failed: ${classified.message}`, {
          retryable: classified.retryable,
          rateLimited: mapped.code === 'RATE_LIMITED',
          dailyQuota: isDailyQuotaError(error),
          ...(classified.status === undefined ? {} : { status: classified.status }),
          cause: error,
        });
      }
      const embeddings = response.embeddings ?? [];
      if (embeddings.length !== slice.length) {
        throw new EmbeddingError(
          `The embedding service returned ${String(embeddings.length)} vectors for ${String(slice.length)} texts.`,
        );
      }
      for (const embedding of embeddings) {
        const values = embedding.values;
        if (values === undefined || values.length === 0) {
          throw new EmbeddingError('The embedding service returned an empty vector.');
        }
        vectors.push(l2Normalize(values));
      }
    }
    return vectors;
  }

  embedPassages(
    texts: readonly string[],
    signal?: AbortSignal,
    options: PassageOptions = {},
  ): Promise<number[][]> {
    return this.embed(
      texts.map((text, index) => passageText(text, options.titles?.[index])),
      signal,
    );
  }

  /**
   * Several questions in one request (the calibration embeds a few dozen at once: one call, not one each). Same prefix and
   * normalisation as `embedQuery`.
   */
  embedQueries(texts: readonly string[], signal?: AbortSignal): Promise<number[][]> {
    return this.embed(texts.map(queryText), signal);
  }

  async embedQuery(text: string, signal?: AbortSignal, options: QueryOptions = {}): Promise<number[]> {
    const [vector] = await this.embed([queryText(text)], signal, options.onSent);
    if (vector === undefined) throw new EmbeddingError('The embedding service returned no vector.');
    return vector;
  }
}
