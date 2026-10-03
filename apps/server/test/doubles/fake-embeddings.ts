import type { EmbeddingProvider, EmbeddingError } from '../../src/embeddings/provider.js';
import { throwIfAborted } from '../../src/embeddings/provider.js';

const DIMENSIONS = 384;

/** Deterministic hashed character-trigram vector, L2-normalised: texts that share words are close. */
export function hashedVector(text: string): number[] {
  const vector = new Array<number>(DIMENSIONS).fill(0);
  const normalised = ` ${text.toLowerCase().replace(/\s+/gu, ' ')} `;
  for (let i = 0; i + 3 <= normalised.length; i += 1) {
    let hash = 2166136261;
    for (const char of normalised.slice(i, i + 3))
      hash = Math.imul(hash ^ (char.codePointAt(0) ?? 0), 16777619);
    const slot = Math.abs(hash) % DIMENSIONS;
    vector[slot] = (vector[slot] ?? 0) + 1;
  }
  const length = Math.hypot(...vector) || 1;
  return vector.map((value) => value / length);
}

/** Waits `ms`, or rejects as soon as the signal aborts. */
export function abortableDelay(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
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
}

/** A gate a test opens when it wants held jobs to go on; waiting on it ends when the job is aborted. */
export class Gate {
  private release!: () => void;
  readonly opened = new Promise<void>((resolve) => {
    this.release = resolve;
  });
  entered = 0;

  open(): void {
    this.release();
  }

  /** For `onPassages`: counts the job as having arrived, then holds it until the gate opens or the job is aborted. */
  hold = async (_texts: readonly string[], signal: AbortSignal | undefined): Promise<void> => {
    this.entered += 1;
    await Promise.race([this.opened, abortableDelay(10 * 60_000, signal)]);
  };
}

export interface FakeEmbeddingOptions {
  /** Called with every batch of passages, before it is embedded (to observe batching, or to hold a job at this step). */
  onPassages?: (texts: readonly string[], signal: AbortSignal | undefined) => void | Promise<void>;
  /** Makes embedPassages fail with this error. */
  failWith?: EmbeddingError;
  /** Time each batch takes, to let a test cancel a running job. */
  delayMs?: number;
  batchSize?: number;
  model?: string;
  /** The model's input window in tokens (512 by default). */
  maxInputTokens?: number;
  /**
   * Gives the fake an exact tokenizer (`countTokens` and `countTokensSync`) that counts like this function: a test
   * makes it stricter than the chunker's estimate to prove that no chunk is stored longer than the window.
   */
  tokenCounter?: (text: string) => number;
}

/** A stand-in for the embedding model in tests that do not need real semantics. Test code only. */
export class FakeEmbeddings implements EmbeddingProvider {
  readonly name = 'fake';
  readonly model: string;
  readonly dimensions = DIMENSIONS;
  readonly maxInputTokens: number;
  readonly countTokens?: (texts: readonly string[]) => Promise<number[]>;
  readonly countTokensSync?: (text: string) => number;
  passageCalls = 0;
  warmups = 0;

  constructor(private readonly options: FakeEmbeddingOptions = {}) {
    this.model = options.model ?? 'fake-hash-384';
    this.maxInputTokens = options.maxInputTokens ?? 512;
    const counter = options.tokenCounter;
    if (counter !== undefined) {
      this.countTokens = (texts) => Promise.resolve(texts.map(counter));
      this.countTokensSync = counter;
    }
  }

  loadState(): 'ready' {
    return 'ready';
  }

  async embedPassages(texts: readonly string[], signal?: AbortSignal): Promise<number[][]> {
    const batchSize = this.options.batchSize ?? 16;
    const vectors: number[][] = [];
    for (let offset = 0; offset < texts.length; offset += batchSize) {
      throwIfAborted(signal);
      const batch = texts.slice(offset, offset + batchSize);
      this.passageCalls += 1;
      await this.options.onPassages?.(batch, signal);
      if (this.options.delayMs !== undefined) await abortableDelay(this.options.delayMs, signal);
      throwIfAborted(signal);
      if (this.options.failWith !== undefined) throw this.options.failWith;
      vectors.push(...batch.map(hashedVector));
    }
    return vectors;
  }

  embedQuery(text: string, signal?: AbortSignal): Promise<number[]> {
    throwIfAborted(signal);
    return Promise.resolve(hashedVector(text));
  }

  warmup(): Promise<void> {
    this.warmups += 1;
    return Promise.resolve();
  }
}
