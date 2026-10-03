import type { Config } from '../config.js';
import { AnthropicProvider } from './anthropic.js';
import { GeminiLlmProvider } from './gemini.js';
import { OpenAICompatibleProvider } from './openai.js';
import { NoLlmProvider, type LLMProvider } from './provider.js';

export { AnthropicProvider } from './anthropic.js';
export { GeminiLlmProvider } from './gemini.js';
export { OpenAICompatibleProvider } from './openai.js';
export { LlmError, NoLlmProvider, type LLMProvider, type LlmMessage, type LlmRequest } from './provider.js';

/** The OpenAI base URL: with it a key is required; any other base URL (Ollama, LM Studio, vLLM) may need none. */
const OPENAI_DEFAULT_BASE_URL = 'https://api.openai.com/v1';

type LlmConfig = Pick<
  Config,
  | 'llmProvider'
  | 'llmModel'
  | 'llmAuxModel'
  | 'geminiApiKey'
  | 'geminiMaxRpm'
  | 'anthropicApiKey'
  | 'openaiApiKey'
  | 'openaiBaseUrl'
> &
  // (optional: where it is not given, the models are paced as if OCR used another one)
  Partial<Pick<Config, 'ocrProvider' | 'ocrModel'>>;

/**
 * The chat provider the configuration asks for. Nothing is contacted until a question is asked; `none` (and a hosted
 * provider without its key) gives a provider whose `isConfigured()` is false, so the answer pipeline shows the
 * retrieved passages instead.
 */
export function createLlmProvider(config: LlmConfig): LLMProvider {
  switch (config.llmProvider) {
    case 'gemini':
      return new GeminiLlmProvider({
        apiKey: config.geminiApiKey,
        model: config.llmModel,
        auxModel: config.llmAuxModel,
        maxRpm: config.geminiMaxRpm,
        // OCR reads its pages with this model when it is Gemini's: one Google quota is one window, however many callers draw on it
        ...(config.ocrProvider === 'gemini' && config.ocrModel !== undefined
          ? { ocrModel: config.ocrModel }
          : {}),
      });
    case 'anthropic':
      return new AnthropicProvider({ apiKey: config.anthropicApiKey, model: config.llmModel });
    case 'openai':
      return new OpenAICompatibleProvider({
        baseUrl: config.openaiBaseUrl,
        apiKey: config.openaiApiKey,
        model: config.llmModel,
        configured: config.openaiApiKey !== null || config.openaiBaseUrl !== OPENAI_DEFAULT_BASE_URL,
      });
    case 'none':
      return new NoLlmProvider();
  }
}
