import { AppError } from '../http/errors.js';

/*
 * What a Gemini call can fail with, and what each failure means to the rest of the server. The SDK throws `ApiError`
 * (an `Error` with an HTTP `status`) whose message is the JSON body of the error response; a network failure is a
 * `TypeError: fetch failed`. Nothing raw leaves this module: the AppError messages are curated (a key fragment, a
 * project name or a quota detail in the body of a response must never reach a client or a log).
 */

/** The model refused to produce (or finish) an answer: a safety filter, a blocklist, recitation. */
export class GeminiBlockedError extends Error {
  constructor(
    /** Gemini's own reason: `SAFETY`, `PROHIBITED_CONTENT`, `BLOCKLIST`, `RECITATION`, `OTHER`, ... */
    readonly reason: string,
  ) {
    super(`The model declined to answer (${reason})`);
    this.name = 'GeminiBlockedError';
  }
}

/** The service answered with no candidate at all and no reason (a flake that a second request usually gets past). */
export class GeminiEmptyResponseError extends Error {
  constructor() {
    super('The model returned no answer');
    this.name = 'GeminiEmptyResponseError';
  }
}

/** The `detail` of the AppError for a key the service rejected (401, 403): a configuration fault that waiting does not mend. */
export const KEY_REJECTED_DETAIL = 'the key was rejected';
/** The `detail` of the AppError for a model that does not exist (404): the same. */
export const MODEL_NOT_FOUND_DETAIL = 'model not found';

/** The `detail` of the AppError for a request that was refused because the daily quota is used up. */
export const DAILY_QUOTA_DETAIL = 'daily quota reached';
/**
 * The `detail` of the AppError for a 429 whose quota is ZERO (`limit: 0`): the model has no quota at all on this key's tier
 * (a model the free tier does not include). Waiting changes nothing: it is a configuration fault, worded as one.
 */
export const NO_QUOTA_DETAIL = 'this model has no quota on your Gemini plan — pick another model';

/** The `detail` of the AppError for a service that answered with no text at all. */
export const EMPTY_ANSWER_DETAIL = 'empty answer';
/** The `detail` of the AppError for a service that never answered (network, no connection). */
export const NO_ANSWER_DETAIL = 'no answer';

/**
 * The only `detail` strings that may reach a browser (an SSE `error.detail`, an API error body): curated constants of this
 * module and of the ingestion, never a provider's own words, a status line or a model name. `ingest/detail.ts` has its own.
 */
const CURATED_DETAILS: ReadonlySet<string> = new Set([
  'daily quota reached',
  NO_QUOTA_DETAIL,
  'the key was rejected',
  'model not found',
  'timeout',
  'empty answer',
  'no answer',
]);

/** `detail` when it is one of the curated constants, else undefined: the filter every server-written detail goes through. */
export function curatedDetail(detail: string | undefined): string | undefined {
  return detail !== undefined && CURATED_DETAILS.has(detail) ? detail : undefined;
}

export interface ParsedGeminiError {
  /** The HTTP status, or null for a failure that never got an answer (network, timeout). */
  status: number | null;
  /** Google's own status word: `RESOURCE_EXHAUSTED`, `UNAVAILABLE`, `INVALID_ARGUMENT`, ... */
  apiStatus: string | null;
  /** How long the service asked to wait (`RetryInfo`), in milliseconds. */
  retryDelayMs: number | null;
  /** The quota that ran out is one per day (a `QuotaFailure` whose id says `PerDay`): waiting a minute will not help. */
  dailyQuota: boolean;
  /** The quota is zero (`limit: 0`, a `quotaValue` of 0): the model is not part of this key's plan. */
  noQuota: boolean;
  /** The text of the error body, for matching only (never shown). */
  text: string;
}

interface ErrorBody {
  error?: {
    code?: number;
    message?: string;
    status?: string;
    details?: Record<string, unknown>[];
  };
}

/** "23s", "1.5s", "250ms" or `{seconds, nanos}`: a RetryInfo delay in milliseconds. */
function delayToMs(value: unknown): number | null {
  if (typeof value === 'string') {
    const match = /^([0-9]+(?:\.[0-9]+)?)\s*(ms|s)$/u.exec(value.trim());
    if (match?.[1] === undefined) return null;
    return Math.round(Number(match[1]) * (match[2] === 'ms' ? 1 : 1000));
  }
  if (typeof value === 'object' && value !== null) {
    const { seconds, nanos } = value as { seconds?: unknown; nanos?: unknown };
    const s = Number(seconds ?? 0);
    const n = Number(nanos ?? 0);
    return Number.isFinite(s) && Number.isFinite(n) ? Math.round(s * 1000 + n / 1e6) : null;
  }
  return null;
}

const isApiError = (error: unknown): error is Error & { status: number } =>
  error instanceof Error &&
  error.name === 'ApiError' &&
  typeof (error as { status?: unknown }).status === 'number';

/**
 * The JSON object that starts at the first `{` of a text ("got status: 429 . {...}", or the whole text), or, when the body is an
 * array (`[{"error": ...}]`), its first object; null when there is none.
 */
function jsonIn(text: string): ErrorBody | null {
  for (const opener of ['{', '[']) {
    const start = text.indexOf(opener);
    if (start < 0) continue;
    try {
      const parsed: unknown = JSON.parse(text.slice(start));
      const value: unknown = Array.isArray(parsed) ? parsed[0] : parsed;
      if (typeof value === 'object' && value !== null) return value;
    } catch {
      /* not this opener */
    }
  }
  return null;
}

/**
 * The `error` objects of an error response, outermost first. The SDK puts the body of the response in the message of its
 * ApiError, and a STREAMING call (content-type `text/event-stream`) wraps that body once more: the real service answers
 * `{"error": {"message": "{\"error\": {\"code\": 429, \"status\": \"RESOURCE_EXHAUSTED\", \"details\": [...]}}",
 * "code": 429, "status": "Too Many Requests"}}`, so the quota facts sit in the message of the outer layer, as a string. Every
 * layer is read (the message of one may itself be JSON, or "got status: 429 . {json}").
 */
function errorLayers(text: string): NonNullable<ErrorBody['error']>[] {
  const layers: NonNullable<ErrorBody['error']>[] = [];
  let current = text;
  for (let depth = 0; depth < 3; depth += 1) {
    const layer = jsonIn(current)?.error;
    if (layer === undefined || typeof layer !== 'object') break;
    layers.push(layer);
    if (typeof layer.message !== 'string') break;
    current = layer.message;
  }
  return layers;
}

/** Reads the status, Google's status word and the requested retry delay out of whatever the SDK threw. */
export function parseGeminiError(error: unknown): ParsedGeminiError {
  const text = error instanceof Error ? error.message : String(error);
  const parsed: ParsedGeminiError = {
    status: isApiError(error) ? error.status : null,
    apiStatus: null,
    retryDelayMs: null,
    dailyQuota: false,
    noQuota: /(?:^|[^\w.])limit:\s*0(?![\d.])/iu.test(text),
    text,
  };
  const layers = errorLayers(text);
  for (const layer of layers) {
    // Google's own status word is the one of the innermost layer that has one (the outer one of a stream is "Too Many Requests")
    if (typeof layer.status === 'string' && /^[A-Z_]+$/u.test(layer.status)) parsed.apiStatus = layer.status;
    else parsed.apiStatus ??= null;
    parsed.status ??= typeof layer.code === 'number' ? layer.code : null;
    for (const item of layer.details ?? []) {
      const type = item['@type'];
      if (typeof type === 'string' && type.endsWith('RetryInfo')) {
        parsed.retryDelayMs = delayToMs(item.retryDelay);
      }
      if (typeof type === 'string' && type.endsWith('QuotaFailure')) {
        const violations = Array.isArray(item.violations)
          ? (item.violations as Record<string, unknown>[])
          : [];
        if (
          violations.some((violation) =>
            /PerDay|Daily/u.test(typeof violation.quotaId === 'string' ? violation.quotaId : ''),
          )
        ) {
          parsed.dailyQuota = true;
        }
        if (
          violations.some(
            (violation) => Number(violation.quotaValue) === 0 && violation.quotaValue !== undefined,
          )
        ) {
          parsed.noQuota = true;
        }
      }
    }
  }
  if (layers.length > 0) {
    // A quota of zero is not "used up": a daily limit of 0 is no daily quota to wait out.
    if (parsed.noQuota) parsed.dailyQuota = false;
    if (parsed.retryDelayMs === null) {
      for (const layer of layers) {
        const said = /retry in ([0-9]+(?:\.[0-9]+)?)\s*s/iu.exec(layer.message ?? '')?.[1];
        if (said !== undefined) {
          parsed.retryDelayMs = delayToMs(`${said}s`);
          break;
        }
      }
    }
  }
  return parsed;
}

/** True for a cancellation (the caller's AbortSignal), which is never retried and never mapped. */
export function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

/** The same, under the name the providers use: an AbortError or anything that looks like one (a DOMException, a cause). */
export const isAbortLike = (error: unknown): boolean =>
  isAbortError(error) || (error instanceof Error && isAbortError(error.cause));

/**
 * Whether a failure (a raw SDK error or the AppError {@link mapGeminiError} made of one) means the DAILY quota of the
 * model is used up: waiting does not help until it resets. Callers park the work (ingestion marks pages OCR_PARTIAL
 * with the detail "daily quota reached") instead of failing the whole document.
 */
export function isDailyQuotaError(error: unknown): boolean {
  if (error instanceof AppError) return error.code === 'RATE_LIMITED' && error.detail === DAILY_QUOTA_DETAIL;
  return parseGeminiError(error).dailyQuota;
}

const NETWORK_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ENOTFOUND',
  'EAI_AGAIN',
  'ETIMEDOUT',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_SOCKET',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
]);

/** A failure that never got an HTTP answer: fetch failed, the connection dropped, a timeout. */
function isNetworkError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (error.name === 'TimeoutError') return true;
  const code = (error.cause as { code?: unknown } | undefined)?.code ?? (error as { code?: unknown }).code;
  return (
    (error instanceof TypeError && /fetch failed/iu.test(error.message)) ||
    (typeof code === 'string' && NETWORK_CODES.has(code))
  );
}

/** The statuses worth another attempt: rate limits, timeouts and the server being busy or down. */
const RETRYABLE_STATUSES = new Set([408, 429, 500, 502, 503, 504]);

/** True when waiting and asking again can work: a 429 or 5xx answer, or no answer at all. */
export function isRetryableGeminiError(error: unknown): boolean {
  if (isAbortError(error) || error instanceof GeminiBlockedError || error instanceof AppError) return false;
  if (error instanceof GeminiEmptyResponseError) return true;
  const { status, dailyQuota, noQuota } = parseGeminiError(error);
  if (dailyQuota || noQuota) return false;
  return status === null ? isNetworkError(error) : RETRYABLE_STATUSES.has(status);
}

/**
 * Turns whatever a Gemini call threw into the AppError the server speaks:
 *  - 429 (or RESOURCE_EXHAUSTED)       -> RATE_LIMITED
 *  - a blocked prompt or answer        -> OUTPUT_BLOCKED
 *  - no answer, 5xx, a bad or missing key, a model that does not exist -> LLM_UNAVAILABLE
 *  - anything else the service refused (a malformed request)           -> LLM_FAILED
 * An AppError passes through. Cancellations (`AbortError`) are not mapped: check {@link isAbortError} first.
 */
export function mapGeminiError(error: unknown): AppError {
  if (error instanceof AppError) return error;
  if (error instanceof GeminiBlockedError) {
    return new AppError('OUTPUT_BLOCKED', 'The model declined to process this content.', error.reason);
  }
  if (error instanceof GeminiEmptyResponseError) {
    return new AppError('LLM_UNAVAILABLE', 'The model service returned no answer.', EMPTY_ANSWER_DETAIL);
  }
  const { status, apiStatus, retryDelayMs, dailyQuota, noQuota, text } = parseGeminiError(error);
  if (noQuota) {
    return new AppError(
      'LLM_UNAVAILABLE',
      'The model service has no quota for the configured model.',
      NO_QUOTA_DETAIL,
    );
  }
  if (dailyQuota) {
    return new AppError(
      'RATE_LIMITED',
      'The daily request limit of the model service has been reached.',
      DAILY_QUOTA_DETAIL,
    );
  }
  if (status === 429 || apiStatus === 'RESOURCE_EXHAUSTED') {
    return new AppError(
      'RATE_LIMITED',
      'The model service is busy right now; try again in a moment.',
      retryDelayMs === null ? undefined : `retry after ${String(Math.ceil(retryDelayMs / 1000))} s`,
    );
  }
  if (status === 401 || status === 403 || /api key/iu.test(text)) {
    return new AppError('LLM_UNAVAILABLE', 'The model service refused the API key.', KEY_REJECTED_DETAIL);
  }
  if (status === 404) {
    return new AppError('LLM_UNAVAILABLE', 'The configured model is not available.', MODEL_NOT_FOUND_DETAIL);
  }
  if (status === null || status >= 500 || status === 408) {
    return new AppError(
      'LLM_UNAVAILABLE',
      'The model service is not available right now.',
      status === null ? NO_ANSWER_DETAIL : `status ${String(status)}`,
    );
  }
  return new AppError('LLM_FAILED', 'The model could not complete the request.', `status ${String(status)}`);
}

export interface ClassifiedGeminiError {
  /** A curated sentence (never the raw message). */
  message: string;
  /** Waiting and trying again can work: a rate limit, a busy or unreachable service (not a daily quota, a rejected key or an unknown model). */
  retryable: boolean;
  /** The HTTP status when there was one. */
  status?: number;
}

/**
 * The same verdict as {@link mapGeminiError}, as a plain record for callers with their own error type (the embedding
 * provider): a curated message, whether a later attempt can work, and the HTTP status. Accepts the raw SDK error or
 * the AppError this module made of it.
 */
export function classifyGeminiError(error: unknown): ClassifiedGeminiError {
  const mapped = mapGeminiError(error);
  const parsed = parseGeminiError(error);
  const status = parsed.status ?? Number(/status (\d+)/u.exec(mapped.detail ?? '')?.[1] ?? Number.NaN);
  return {
    message: mapped.detail === undefined ? mapped.message : `${mapped.message} (${mapped.detail})`,
    retryable:
      (mapped.code === 'RATE_LIMITED' || mapped.code === 'LLM_UNAVAILABLE') &&
      !isDailyQuotaError(mapped) &&
      mapped.detail !== KEY_REJECTED_DETAIL &&
      mapped.detail !== MODEL_NOT_FOUND_DETAIL &&
      mapped.detail !== NO_QUOTA_DETAIL,
    ...(Number.isFinite(status) ? { status } : {}),
  };
}
