/** Whether a provider is ready to embed. Hosted providers (Gemini, an OpenAI-compatible endpoint) are always `ready`. */
export type EmbeddingLoadState = 'idle' | 'loading' | 'ready' | 'failed';

/** A failed embedding call. `retryable` tells the ingestion job whether trying again could help. */
export class EmbeddingError extends Error {
  readonly retryable: boolean;
  readonly status: number | undefined;
  /** The service refused because of a rate limit (429); `dailyQuota` says it is the per-day quota, which resets overnight. */
  readonly rateLimited: boolean;
  readonly dailyQuota: boolean;
  /** The provider has no key (or endpoint): a fault of the configuration, not of the service. */
  readonly unconfigured: boolean;

  constructor(
    message: string,
    options: {
      retryable?: boolean;
      status?: number;
      rateLimited?: boolean;
      dailyQuota?: boolean;
      unconfigured?: boolean;
      cause?: unknown;
    } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'EmbeddingError';
    this.retryable = options.retryable ?? false;
    this.status = options.status;
    this.rateLimited = options.rateLimited ?? false;
    this.dailyQuota = options.dailyQuota ?? false;
    this.unconfigured = options.unconfigured ?? false;
  }
}

/** What a caller may ask of an embedding of a question besides its text. */
export interface QueryOptions {
  /**
   * Called once, when the request has actually LEFT for the service (after the provider's own queue, before the first attempt): a
   * caller that counts what it asks of a quota counts then, not when it asks, so that a visitor who goes away while the call waits
   * for its slot spent nothing. Only a provider with `reportsSend` calls it.
   */
  onSent?: () => void;
}

/** What is known about a passage besides its text. */
export interface PassageOptions {
  /**
   * One title per text (a section heading, the file name; null or an empty string for none), for models that embed a
   * passage together with its title (gemini-embedding-2: `title: <title or none> | text: <text>`).
   */
  titles?: readonly (string | null | undefined)[];
}

/**
 * Turns text into vectors. Passages (document chunks) and queries are embedded differently by some models (the
 * Gemini embedding model wants a "title: ... | text: ..." prefix on a passage and "task: search result | query: ..." on a
 * question), so the two calls are separate. Vectors are L2-normalised, so cosine similarity is a dot product.
 */
export interface EmbeddingProvider {
  /** Provider name as configured: `gemini` or `openai`. */
  readonly name: string;
  readonly model: string;
  /** Vector size; null until it is known (an OpenAI-compatible endpoint reports it with its first answer). */
  readonly dimensions: number | null;
  /** The longest input, in tokens, including the prefix and the model's special tokens. */
  readonly maxInputTokens: number;
  /** Whether it can be used at all (its key is set); a provider that cannot tell (a test double) is taken as ready. */
  isConfigured?(): boolean;
  embedPassages(
    texts: readonly string[],
    signal?: AbortSignal,
    options?: PassageOptions,
  ): Promise<number[][]>;
  embedQuery(text: string, signal?: AbortSignal, options?: QueryOptions): Promise<number[]>;
  /** The provider calls `QueryOptions.onSent` when a request leaves (Gemini's does); one that does not is counted as sending at once. */
  readonly reportsSend?: boolean;
  /** Exact token counts of passages with the model's own tokenizer, when it has one. */
  countTokens?(texts: readonly string[]): Promise<number[]>;
  /** The same count for one passage, synchronously: what the chunker needs to split chunks that are too long. */
  countTokensSync?(text: string): number;
  /** Hooks of the ingestion service for a provider that holds something to prepare or to free; the hosted ones have none. */
  warmup?(): Promise<void>;
  loadState?(): EmbeddingLoadState;
  dispose?(): Promise<void>;
}

export function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) {
    throw signal.reason instanceof Error
      ? signal.reason
      : new DOMException('The operation was aborted', 'AbortError');
  }
}
