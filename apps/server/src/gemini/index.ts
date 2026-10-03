/*
 * The one place the server talks to Google's Gemini API. Providers (OCR here; answers, auxiliary calls and embeddings
 * elsewhere) use it and nothing else calls Gemini:
 *
 *   const client = getGeminiClient(config);                  // the SDK client for GEMINI_API_KEY (never logged)
 *   const pacer = getGeminiPacer(config);                    // GEMINI_MAX_RPM requests per minute, one budget for the
 *                                                            // process: its worker threads attach to the main thread's
 *                                                            // window (`geminiPacerBuffer`, `useGeminiPacerBuffer`)
 *   const response = await withGeminiRetry(                  // backoff on 429/5xx (honours RetryInfo), paced,
 *     () => client.models.generateContent(request),          // cancellable; failures come out as AppErrors
 *     { pacer, signal },
 *   );
 *   const { text } = geminiText(response);                   // safety blocks come out as OUTPUT_BLOCKED
 *
 * A provider that wants a test double takes a `GeminiClient<'generateContent'>` (or the methods it uses) as an
 * option; the double implements those methods and nothing else.
 */
export { getGeminiClient, hasGeminiKey, type GeminiClient, type GeminiClientConfig } from './client.js';
export {
  DAILY_QUOTA_DETAIL,
  EMPTY_ANSWER_DETAIL,
  GeminiBlockedError,
  GeminiEmptyResponseError,
  KEY_REJECTED_DETAIL,
  MODEL_NOT_FOUND_DETAIL,
  NO_ANSWER_DETAIL,
  NO_QUOTA_DETAIL,
  curatedDetail,
  classifyGeminiError,
  isAbortError,
  isAbortLike,
  isDailyQuotaError,
  isRetryableGeminiError,
  mapGeminiError,
  parseGeminiError,
  type ClassifiedGeminiError,
  type ParsedGeminiError,
} from './errors.js';
export {
  GeminiPacer,
  createPacerBuffer,
  geminiPacerBuffer,
  monotonicMs,
  getGeminiPacer,
  useGeminiPacerBuffer,
  type PacerOptions,
} from './pacing.js';
export {
  blockedPromptReason,
  classifyFinishReason,
  geminiText,
  isBlockingFinish,
  type FinishKind,
  type GeminiText,
} from './response.js';
export { TIMEOUT_DETAIL, withGeminiRetry, type GeminiRetryOptions, type RetryOptions } from './retry.js';
