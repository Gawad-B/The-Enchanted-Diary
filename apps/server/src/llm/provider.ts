import type { ErrorCode } from '@enchanted/shared';

export interface LlmMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface LlmRequest {
  /** The system prompt: instructions only, never document text (see rag/prompts.ts). */
  system: string;
  /** Alternating user / assistant turns; the last one is the user's. */
  messages: LlmMessage[];
  maxTokens: number;
  temperature: number;
  /**
   * `auxiliary` marks the small calls around an answer (rewriting a follow-up, the grounding check): a provider with a
   * cheaper model for them (Gemini's separate lite model) uses it; every other provider answers with its one model.
   */
  tier?: 'primary' | 'auxiliary';
  /** Aborting stops the generation as soon as the provider can (a closed connection, a timeout). */
  signal?: AbortSignal;
  /**
   * The whole call may take this long once it is actually SENT: a provider that queues its requests (Gemini's pacer) starts
   * the clock when the request leaves, never while it waits for its turn. Only providers with `handlesTimeout` read it; the
   * caller of any other puts a deadline on the signal itself (see `rag/aux-call.ts`). Expiry is LLM_UNAVAILABLE `timeout`.
   */
  timeoutMs?: number;
  /**
   * Called once when the request has actually LEFT for the service (after the wait for a slot in the provider's queue): a visitor
   * who goes away while the call is queued has sent, and spent, nothing. Only a provider with `reportsSend` calls it.
   */
  onSent?: () => void;
  /**
   * Called once when the reply has ended, with how: `reason` is the provider's own stop reason (null when it has none) and
   * `truncated` says the text is cut off (the output limit, or a filter that stopped the reply after some text). Providers that
   * cannot tell never call it.
   */
  onFinish?: (info: { reason: string | null; truncated: boolean }) => void;
}

/**
 * A chat model that streams its answer as text chunks. One implementation per kind of backend; nothing outside
 * `llm/` knows which one is in use. A provider that cannot run (no key, `none`) reports it through
 * `isConfigured()` and the answer pipeline then shows the retrieved passages instead of calling it.
 */
export interface LLMProvider {
  /** `gemini`, `anthropic`, `openai` or `none` as configured. */
  readonly name: string;
  readonly model: string;
  isConfigured(): boolean;
  /** True when the provider calls `LlmRequest.onSent` when a request leaves (the daily budget then counts it at that moment, not before). */
  readonly reportsSend?: boolean;
  /** True when the provider reads `LlmRequest.timeoutMs` itself (the clock then starts at the send, not before any queue). */
  readonly handlesTimeout?: boolean;
  /**
   * Streams the reply. Failures surface as `LlmError` (curated message, never a key or a raw response body); an
   * aborted request rejects with an `AbortError`.
   */
  stream(request: LlmRequest): AsyncIterable<string>;
  /** Frees whatever the provider holds. */
  dispose?(): Promise<void>;
}

/** The codes a provider can fail with. */
export type LlmErrorCode = Extract<ErrorCode, 'LLM_FAILED' | 'LLM_UNAVAILABLE' | 'RATE_LIMITED'>;

/**
 * A failed generation. `message` is shown to people, so it is always one of our own sentences; whatever the
 * backend said stays in `cause`, which is logged on the server and never sent to a client.
 */
export class LlmError extends Error {
  readonly code: LlmErrorCode;
  readonly status: number | undefined;
  /** A short curated hint for the client (RATE_LIMITED: "daily quota reached"); never raw backend text. */
  readonly detail: string | undefined;

  constructor(
    code: LlmErrorCode,
    message: string,
    options: { status?: number; detail?: string; cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'LlmError';
    this.code = code;
    this.status = options.status;
    this.detail = options.detail;
  }
}

/** How long a hosted provider may take to answer at all, and to send the next chunk once it has started. */
export const LLM_FIRST_BYTE_TIMEOUT_MS = 60_000;
export const LLM_STALL_TIMEOUT_MS = 60_000;

export function abortError(signal: AbortSignal | undefined): Error {
  return signal?.reason instanceof Error
    ? signal.reason
    : new DOMException('The request was aborted', 'AbortError');
}

export function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

/** The provider used when `LLM_PROVIDER=none`: nothing is generated, the passages are shown instead. */
export class NoLlmProvider implements LLMProvider {
  readonly name = 'none';
  readonly model = '';

  isConfigured(): boolean {
    return false;
  }

  // eslint-disable-next-line require-yield -- it never produces anything
  async *stream(): AsyncGenerator<string> {
    await Promise.resolve();
    throw new LlmError('LLM_UNAVAILABLE', 'No language model is configured for this server.');
  }
}
