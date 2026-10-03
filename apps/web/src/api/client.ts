import { ApiErrorSchema, type ErrorCode, type z } from '@enchanted/shared';

/** Error kinds that exist only in the browser (the server never sends them). */
export type ClientErrorCode = 'NETWORK';
export type UiErrorCode = ErrorCode | ClientErrorCode;

/** What the experience state and the UI keep about a failure: a stable code plus the technical message. */
export interface UiError {
  code: UiErrorCode;
  message: string;
  detail?: string;
}

/** A failed API call: an error body from the server, an unreadable response, or no response at all. */
export class ApiError extends Error {
  readonly code: UiErrorCode;
  /** HTTP status, or null when the request never got a response. */
  readonly status: number | null;
  readonly detail: string | undefined;
  /** How long the server asked the client to wait before asking again (`Retry-After`), in milliseconds. */
  readonly retryAfterMs: number | undefined;

  constructor(
    code: UiErrorCode,
    message: string,
    status: number | null = null,
    detail?: string,
    retryAfterMs?: number,
  ) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
    this.detail = detail;
    this.retryAfterMs = retryAfterMs;
  }

  toUiError(): UiError {
    return {
      code: this.code,
      message: this.message,
      ...(this.detail === undefined ? {} : { detail: this.detail }),
    };
  }
}

/** True for the error `fetch` throws when the caller aborted the request. */
export function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

/** `fetch` that maps "no response" (offline, refused, DNS) to ApiError('NETWORK') and lets aborts through. */
export async function fetchApi(path: string, init: RequestInit = {}): Promise<Response> {
  try {
    return await fetch(path, { credentials: 'same-origin', ...init });
  } catch (error) {
    if (isAbortError(error)) throw error;
    throw new ApiError('NETWORK', error instanceof Error ? error.message : 'The request could not be sent');
  }
}

/** The longest wait a `Retry-After` can ask of the diary (a day's header would park the page for a day). */
const RETRY_AFTER_CAP_MS = 60 * 60 * 1000;

/** A `Retry-After` header (seconds, or an HTTP date) as milliseconds from `now`; undefined when absent or unreadable. */
export function parseRetryAfter(value: string | null, now: number = Date.now()): number | undefined {
  if (value === null) return undefined;
  const text = value.trim();
  if (text === '') return undefined;
  const seconds = /^\d+$/u.test(text) ? Number(text) : Number.NaN;
  const ms = Number.isNaN(seconds) ? Date.parse(text) - now : seconds * 1000;
  if (!Number.isFinite(ms)) return undefined;
  return Math.min(Math.max(0, ms), RETRY_AFTER_CAP_MS);
}

/** Builds the ApiError for a non-2xx response, using the server's ApiError body when it has one. */
export async function readApiError(response: Response): Promise<ApiError> {
  const retryAfterMs = parseRetryAfter(response.headers.get('Retry-After'));
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    body = undefined;
  }
  const parsed = ApiErrorSchema.safeParse(body);
  if (parsed.success) {
    const { code, message, detail } = parsed.data.error;
    return new ApiError(code, message, response.status, detail, retryAfterMs);
  }
  // A proxy or gateway error page, not our server: keep the status as the technical message.
  const code: ErrorCode = response.status === 429 ? 'RATE_LIMITED' : 'INTERNAL';
  return new ApiError(
    code,
    `HTTP ${String(response.status)} ${response.statusText}`.trim(),
    response.status,
    undefined,
    retryAfterMs,
  );
}

export interface GetJsonOptions {
  signal?: AbortSignal;
}

/** GET `path` and parse the JSON body with `schema`. Throws ApiError (or an AbortError when aborted). */
export async function getJson<S extends z.ZodType>(
  path: string,
  schema: S,
  options: GetJsonOptions = {},
): Promise<z.output<S>> {
  const response = await fetchApi(path, {
    method: 'GET',
    headers: { Accept: 'application/json' },
    ...(options.signal ? { signal: options.signal } : {}),
  });
  if (!response.ok) throw await readApiError(response);
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new ApiError('INTERNAL', 'The server sent a response that is not valid JSON', response.status);
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    throw new ApiError(
      'INTERNAL',
      'The server sent a response in an unexpected shape',
      response.status,
      parsed.error.issues[0]?.message,
    );
  }
  return parsed.data;
}

/**
 * POST `body` as JSON (nothing at all when `body` is undefined) and parse the JSON answer with `schema`. A POST without a
 * body must not claim to carry JSON: the server refuses an empty body under that content type.
 */
export async function postJson<S extends z.ZodType>(
  path: string,
  body: unknown,
  schema: S,
  signal?: AbortSignal,
): Promise<z.output<S>> {
  const response = await fetchApi(path, {
    method: 'POST',
    headers:
      body === undefined
        ? { Accept: 'application/json' }
        : { 'Content-Type': 'application/json', Accept: 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    ...(signal ? { signal } : {}),
  });
  if (!response.ok) throw await readApiError(response);
  let parsedBody: unknown;
  try {
    parsedBody = await response.json();
  } catch {
    throw new ApiError('INTERNAL', 'The server sent a response that is not valid JSON', response.status);
  }
  const parsed = schema.safeParse(parsedBody);
  if (!parsed.success) {
    throw new ApiError(
      'INTERNAL',
      'The server sent a response in an unexpected shape',
      response.status,
      parsed.error.issues[0]?.message,
    );
  }
  return parsed.data;
}
