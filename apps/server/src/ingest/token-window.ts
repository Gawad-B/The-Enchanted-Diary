import { enforceTokenWindow, type Chunk, type ChunkingOptions } from '../chunking/chunker.js';
import type { EmbeddingProvider } from '../embeddings/provider.js';
import { toChunkPages, type AnalyzablePage } from './analyze.js';

export interface TokenWindowLogger {
  info(object: object, message: string): void;
  warn(object: object, message: string): void;
}

/**
 * Takes the exact token count of every chunk with the embedding model's own tokenizer (the chunker only had an
 * estimate) and splits the chunks that still exceed the model's window, so that no stored chunk is truncated by the
 * model. Without an exact counter (a remote embedding service, whose window is far above CHUNK_MAX_CHARS) the
 * chunks are returned as the chunker made them.
 */
export async function fitTokenWindow(
  embeddings: EmbeddingProvider,
  chunks: Chunk[],
  pages: readonly AnalyzablePage[],
  languageOf: (pageNumber: number) => string,
  options: ChunkingOptions,
  log: TokenWindowLogger,
): Promise<Chunk[]> {
  const exact = await embeddings.countTokens?.(chunks.map((chunk) => chunk.content));
  if (exact === undefined) return chunks;
  const counted = chunks.map((chunk, index) => ({ ...chunk, tokenCount: exact[index] ?? chunk.tokenCount }));
  const over = counted.filter((chunk) => chunk.tokenCount > embeddings.maxInputTokens).length;
  if (over === 0) return counted;

  const count = embeddings.countTokensSync?.bind(embeddings);
  if (count === undefined) {
    log.warn(
      { chunks: over },
      'some chunks exceed the embedding window and cannot be split: no synchronous tokenizer',
    );
    return counted;
  }
  const split = enforceTokenWindow(counted, toChunkPages(pages, languageOf), options, {
    maxTokens: embeddings.maxInputTokens,
    countTokens: count,
  });
  log.info(
    { chunksTooLong: over, chunksBefore: counted.length, chunksAfter: split.length },
    'split chunks that exceeded the embedding window',
  );
  return split;
}
