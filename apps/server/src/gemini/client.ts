import { GoogleGenAI, type Models } from '@google/genai';
import { AppError } from '../http/errors.js';

/**
 * The part of the SDK's client a provider uses. A provider asks for exactly the methods it calls
 * (`GeminiClient<'generateContent'>`), so a test double implements those and nothing else, and the real client
 * (`getGeminiClient`) satisfies every one of them.
 */
export interface GeminiClient<Methods extends keyof Models = 'generateContent'> {
  readonly models: Pick<Models, Methods>;
}

/** The configuration the client needs. */
export interface GeminiClientConfig {
  geminiApiKey: string | null;
}

/** Whether a key is configured (what "available" means for every Gemini-backed provider; nothing is probed). */
export const hasGeminiKey = (config: GeminiClientConfig): boolean => config.geminiApiKey !== null;

const clients = new Map<string, GeminiClient<'generateContent' | 'generateContentStream' | 'embedContent'>>();

/**
 * The process-wide client for the configured key (created on first use, one per key). The key is read from the
 * configuration only, and is never logged, put in an error or sent anywhere but to Google. Throws LLM_UNAVAILABLE when
 * no key is set.
 */
export function getGeminiClient(
  config: GeminiClientConfig,
): GeminiClient<'generateContent' | 'generateContentStream' | 'embedContent'> {
  const key = config.geminiApiKey;
  if (key === null) {
    throw new AppError('LLM_UNAVAILABLE', 'Gemini is not configured.', 'GEMINI_API_KEY is not set');
  }
  let client = clients.get(key);
  if (client === undefined) {
    client = new GoogleGenAI({ apiKey: key });
    clients.set(key, client);
  }
  return client;
}
