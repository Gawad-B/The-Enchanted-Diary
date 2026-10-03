import type { Config } from '../config.js';
import { GeminiEmbeddings } from './gemini.js';
import { OpenAICompatibleEmbeddings } from './openai.js';
import type { EmbeddingProvider } from './provider.js';

export { EmbeddingError, type EmbeddingProvider } from './provider.js';
export { GeminiEmbeddings } from './gemini.js';
export { OpenAICompatibleEmbeddings } from './openai.js';

/** The embedding provider the configuration asks for. Nothing is contacted until it is used. */
export function createEmbeddingProvider(
  config: Pick<
    Config,
    | 'embeddingProvider'
    | 'embeddingModel'
    | 'embeddingDimensions'
    | 'embeddingBatchSize'
    | 'geminiApiKey'
    | 'openaiApiKey'
    | 'openaiBaseUrl'
  >,
): EmbeddingProvider {
  if (config.embeddingProvider === 'openai') {
    return new OpenAICompatibleEmbeddings({
      baseUrl: config.openaiBaseUrl,
      apiKey: config.openaiApiKey,
      model: config.embeddingModel,
      batchSize: config.embeddingBatchSize,
    });
  }
  return new GeminiEmbeddings({
    apiKey: config.geminiApiKey,
    model: config.embeddingModel,
    dimensions: config.embeddingDimensions,
    batchSize: config.embeddingBatchSize,
  });
}
