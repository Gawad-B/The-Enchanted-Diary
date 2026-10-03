import { ThinkingLevel } from '@google/genai';
import type {
  EmbedContentParameters,
  EmbedContentResponse,
  GenerateContentParameters,
  GenerateContentResponse,
  ThinkingConfig,
} from '@google/genai';
import {
  TIMEOUT_DETAIL,
  classifyFinishReason,
  curatedDetail,
  getGeminiClient,
  getGeminiPacer,
  isAbortLike,
  blockedPromptReason,
  isBlockingFinish,
  mapGeminiError,
  withGeminiRetry,
  type GeminiPacer,
  type RetryOptions,
} from '../gemini/index.js';
import { AppError } from '../http/errors.js';
import {
  LLM_FIRST_BYTE_TIMEOUT_MS,
  LLM_STALL_TIMEOUT_MS,
  LlmError,
  abortError,
  type LLMProvider,
  type LlmRequest,
} from './provider.js';

/**
 * Google Gemini through the shared client (`gemini/`): streaming with `generateContentStream`, the system prompt as the
 * system instruction, the conversation as user / model turns.
 *  - two models: LLM_MODEL writes the answers, LLM_AUX_MODEL (a lite tier) does the small calls around them (a request
 *    with `tier: 'auxiliary'`);
 *  - opening the stream is retried (429, 5xx, a dropped connection) with backoff that honours the server's RetryInfo;
 *    once text has been delivered nothing is retried;
 *  - thinking is kept to the minimum (`thinkingLevel: MINIMAL` for Gemini 3 models, `thinkingBudget: 0` for Gemini 2.x):
 *    a grounded answer needs none, it costs time to the first token and its tokens count against the output limit; a model
 *    that refuses a level (3.8 Flash has no `minimal`) is asked again with the next one, and in the end with none;
 *  - Gemini 3 models are called with their default temperature (lowering it makes them loop or degrade, say Google's
 *    guides); `temperature` is only sent to earlier models;
 *  - every request waits for a slot of ITS model's pacer window (GEMINI_MAX_RPM per model: the quotas are per model), so the
 *    free tier's requests per minute are met before the service has to refuse; a 429 that gets through is retried after the
 *    delay it names. The wait for a slot is cancelled by the visitor's signal only and counts against no timeout;
 *  - three clocks run from the moment a request is SENT (never the queue): a first-byte timeout, a stall timeout between
 *    chunks, and, for the small calls, the caller's `timeoutMs`; any of them ends the call as LLM_UNAVAILABLE `timeout`;
 *  - how the reply ended is reported through `onFinish`: the output limit (MAX_TOKENS), or a filter that stopped it after
 *    some text (SAFETY, RECITATION, OTHER, ...), mark the text as truncated; the same classification as OCR's
 *    (`gemini/response.ts`);
 *  - the answer is a plain `generateContentStream` call (never the Interactions API, which stores interactions on the
 *    server by default);
 *  - a blocked prompt, or a reply that stopped for a safety reason before any text, is an error (LLM_FAILED) with one of
 *    our own sentences, never an empty answer;
 *  - every error leaves this file as an LlmError: the SDK's message (which can echo the request) and the key stay in the
 *    log's `cause`; only curated details (`gemini/errors.ts`) are kept for clients.
 */

/** The part of the SDK client this provider uses (tests substitute it). */
export interface GeminiModelsLike {
  models: {
    generateContentStream(params: GenerateContentParameters): Promise<AsyncIterable<GenerateContentResponse>>;
    embedContent?(params: EmbedContentParameters): Promise<EmbedContentResponse>;
  };
}

export interface GeminiLlmOptions {
  apiKey: string | null;
  model: string;
  /** The model for auxiliary calls; empty means `model`. */
  auxModel: string;
  /** A stand-in for the SDK client (tests). */
  client?: GeminiModelsLike;
  retry?: RetryOptions;
  /** Paces every request through this one window (tests). Default: one window per model, `maxRpm` requests a minute each. */
  pacer?: GeminiPacer | undefined;
  maxRpm?: number;
  /**
   * The model OCR reads pages with, when it is Gemini's. Gemini's limits are per model, and OCR (the main thread and the ingestion
   * worker threads) is paced in the process-wide `default` window: a call of this model draws on that same window, so that the one
   * quota is never given two (up to twice the requests per minute) when OCR_MODEL and LLM_MODEL are the same model.
   */
  ocrModel?: string;
  /** The first-byte and stall clocks (tests make them short). */
  timeouts?: { firstByteMs?: number; stallMs?: number };
}

/**
 * The clocks of one request. `arm()` starts them when the request is sent (after the pacer granted its slot), `touch()` is
 * called with every chunk, `stop()` ends them. Whatever fires aborts `signal`, the one the SDK call gets (it also follows the
 * visitor's signal), and `timedOut` says it was a clock and not the visitor.
 */
class RequestWatch {
  private readonly controller = new AbortController();
  private firstByte: NodeJS.Timeout | undefined;
  private deadline: NodeJS.Timeout | undefined;
  private stall: NodeJS.Timeout | undefined;
  timedOut = false;
  private readonly onVisitorAbort: () => void;

  constructor(
    private readonly visitor: AbortSignal | undefined,
    private readonly clocks: { firstByteMs: number; stallMs: number; deadlineMs: number | undefined },
  ) {
    this.onVisitorAbort = () => {
      this.stop();
      this.controller.abort(this.visitor?.reason);
    };
    if (visitor?.aborted === true) this.controller.abort(visitor.reason);
    else visitor?.addEventListener('abort', this.onVisitorAbort, { once: true });
  }

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  private fire(): void {
    this.timedOut = true;
    this.stop();
    this.controller.abort(new DOMException('The model did not answer in time', 'TimeoutError'));
  }

  private deadlineStarted = false;

  /**
   * A request leaves now: its first-byte clock starts. The overall deadline of a small call starts ONCE, at the first send of the
   * logical call (a retry does not get a new one, and the waits between attempts count against it).
   */
  arm(): void {
    clearTimeout(this.firstByte);
    clearTimeout(this.stall);
    this.stall = undefined;
    this.firstByte = setTimeout(() => this.fire(), this.clocks.firstByteMs);
    if (this.clocks.deadlineMs !== undefined && !this.deadlineStarted) {
      this.deadlineStarted = true;
      this.deadline = setTimeout(() => this.fire(), this.clocks.deadlineMs);
    }
  }

  /** The consumer stopped reading before the end: the HTTP request is cancelled too, not left to stream to nobody. */
  cancel(): void {
    this.stop();
    if (!this.controller.signal.aborted)
      this.controller.abort(new DOMException('The reply was not read to the end', 'AbortError'));
  }

  /** A chunk arrived: the first-byte clock is done, the stall clock starts over. */
  touch(): void {
    clearTimeout(this.firstByte);
    this.firstByte = undefined;
    clearTimeout(this.stall);
    this.stall = setTimeout(() => this.fire(), this.clocks.stallMs);
  }

  /** A failed attempt: its clocks end, the call's deadline goes on. */
  stopAttempt(): void {
    clearTimeout(this.firstByte);
    clearTimeout(this.stall);
    this.firstByte = undefined;
    this.stall = undefined;
  }

  stop(): void {
    this.stopAttempt();
    clearTimeout(this.deadline);
    this.deadline = undefined;
  }

  dispose(): void {
    this.stop();
    this.visitor?.removeEventListener('abort', this.onVisitorAbort);
  }
}

export class GeminiLlmProvider implements LLMProvider {
  readonly name = 'gemini';
  readonly model: string;
  readonly handlesTimeout = true;
  readonly reportsSend = true;
  private readonly auxModel: string;
  private readonly apiKey: string | null;
  private readonly injected: GeminiModelsLike | undefined;
  private readonly retry: RetryOptions;
  private readonly pacer: GeminiPacer | undefined;
  private readonly maxRpm: number | undefined;
  private readonly ocrModel: string | undefined;
  private readonly firstByteMs: number;
  private readonly stallMs: number;

  constructor(options: GeminiLlmOptions) {
    this.model = options.model;
    this.auxModel = options.auxModel === '' ? options.model : options.auxModel;
    this.apiKey = options.apiKey;
    this.injected = options.client;
    this.retry = options.retry ?? {};
    this.pacer = options.pacer;
    this.maxRpm = options.maxRpm;
    this.ocrModel = options.ocrModel;
    this.firstByteMs = options.timeouts?.firstByteMs ?? LLM_FIRST_BYTE_TIMEOUT_MS;
    this.stallMs = options.timeouts?.stallMs ?? LLM_STALL_TIMEOUT_MS;
  }

  isConfigured(): boolean {
    return this.apiKey !== null || this.injected !== undefined;
  }

  private sdk(): GeminiModelsLike {
    return this.injected ?? getGeminiClient({ geminiApiKey: this.apiKey });
  }

  /** The window of the model's quota bucket: each model has its own (the answer model's calls never wait for the small one's). */
  private pacerFor(model: string): GeminiPacer | undefined {
    if (this.pacer !== undefined) return this.pacer;
    if (this.maxRpm === undefined) return undefined;
    return getGeminiPacer({ geminiMaxRpm: this.maxRpm }, model === this.ocrModel ? 'default' : model);
  }

  async *stream(request: LlmRequest): AsyncGenerator<string> {
    if (!this.isConfigured()) {
      throw new LlmError('LLM_UNAVAILABLE', 'No Gemini API key is configured on this server.');
    }
    const model = request.tier === 'auxiliary' ? this.auxModel : this.model;
    const client = this.sdk();
    const watch = new RequestWatch(request.signal, {
      firstByteMs: this.firstByteMs,
      stallMs: this.stallMs,
      deadlineMs: request.timeoutMs,
    });
    const parameters = (thinking: ThinkingConfig | undefined): GenerateContentParameters => ({
      model,
      contents: request.messages.map((message) => ({
        role: message.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: message.content }],
      })),
      config: {
        systemInstruction: request.system,
        maxOutputTokens: request.maxTokens,
        ...(isGemini3OrLater(model) ? {} : { temperature: request.temperature }),
        ...(thinking === undefined ? {} : { thinkingConfig: thinking }),
        abortSignal: watch.signal,
      },
    });

    try {
      let chunks: AsyncIterable<GenerateContentResponse>;
      try {
        chunks = await this.open(client, model, parameters, watch, request.onSent);
      } catch (error) {
        throw this.toLlmError(error, request.signal, watch);
      }

      let delivered = false;
      let blocked: string | undefined;
      let finish: string | undefined;
      let readToEnd = false;
      try {
        for await (const chunk of chunks) {
          watch.touch();
          const promptBlock = blockedPromptReason(chunk);
          if (promptBlock !== undefined) {
            blocked = `prompt ${promptBlock}`;
            break;
          }
          const reason = chunk.candidates?.[0]?.finishReason;
          const text = textOf(chunk);
          if (text !== '') {
            delivered = true;
            yield text;
          }
          if (reason !== undefined) finish = reason;
          if (isBlockingFinish(reason) && !delivered) {
            blocked = `reply ${String(reason)}`;
            break;
          }
        }
        readToEnd = true;
      } catch (error) {
        throw this.toLlmError(error, request.signal, watch);
      } finally {
        // the consumer stopped early (a verdict that needed only its first word): the HTTP stream is cancelled, not left running
        if (!readToEnd) watch.cancel();
      }
      if (blocked !== undefined) {
        throw new LlmError(
          'LLM_FAILED',
          blocked.startsWith('prompt')
            ? 'The language service declined to read this request.'
            : 'The language service stopped writing this answer.',
          { cause: new Error(blocked) },
        );
      }
      request.onFinish?.({ reason: finish ?? null, truncated: classifyFinishReason(finish) !== 'complete' });
    } finally {
      watch.dispose();
    }
  }

  /** Opens the stream with retries; a model that does not accept a thinking setting is asked again with the next one. */
  private async open(
    client: GeminiModelsLike,
    model: string,
    parameters: (thinking: ThinkingConfig | undefined) => GenerateContentParameters,
    watch: RequestWatch,
    onSent: (() => void) | undefined,
  ): Promise<AsyncIterable<GenerateContentResponse>> {
    const pacer = this.pacerFor(model);
    let announced = false;
    // The retry loop waits (for a slot, between attempts) on the WATCH's signal: it follows the visitor, and it is aborted by the
    // call's deadline, so a small call's backoff can never outlast the time it was given.
    const retry = {
      ...this.retry,
      ...(pacer === undefined ? {} : { pacer }),
      signal: watch.signal,
    };
    const variants = thinkingVariants(model);
    for (let index = 0; ; index += 1) {
      const thinking = variants[index];
      try {
        return await withGeminiRetry(() => {
          // The slot is in hand: the request leaves now, and its clocks start.
          watch.arm();
          if (!announced) {
            announced = true;
            onSent?.();
          }
          return client.models
            .generateContentStream(parameters(thinking))
            .catch(rethrowThinkingRejection)
            .catch((error: unknown) => {
              watch.stopAttempt();
              throw error;
            });
        }, retry);
      } catch (error) {
        if (!(error instanceof ThinkingRejected) || index + 1 >= variants.length) throw error;
      }
    }
  }

  private toLlmError(error: unknown, signal: AbortSignal | undefined, watch: RequestWatch): Error {
    if (error instanceof LlmError) return error;
    // A clock of ours ended the request: that is a failure of the service, not the visitor going away.
    if (watch.timedOut && signal?.aborted !== true) {
      return new LlmError('LLM_UNAVAILABLE', 'The language service did not answer in time.', {
        detail: TIMEOUT_DETAIL,
        cause: error,
      });
    }
    if (signal?.aborted === true || isAbortLike(error)) return abortError(signal);
    const mapped = error instanceof AppError ? error : mapGeminiError(error);
    const code =
      mapped.code === 'LLM_FAILED'
        ? 'LLM_FAILED'
        : mapped.code === 'RATE_LIMITED'
          ? 'RATE_LIMITED'
          : 'LLM_UNAVAILABLE';
    const status = (error as { status?: unknown }).status;
    const detail = curatedDetail(mapped.detail);
    return new LlmError(code, mapped.message, {
      cause: error,
      ...(detail === undefined ? {} : { detail }),
      ...(typeof status === 'number' ? { status } : {}),
    });
  }
}

/** The text of a streamed chunk: its text parts, without the SDK's warning about other kinds of part. */
function textOf(chunk: GenerateContentResponse): string {
  const parts = chunk.candidates?.[0]?.content?.parts ?? [];
  return parts
    .map((part) => (part.thought === true || typeof part.text !== 'string' ? '' : part.text))
    .join('');
}

/**
 * Gemini 3 and later (and the `-latest` aliases, which point at them) take no lowered temperature and think by
 * `thinkingLevel`; Gemini 2.x takes a temperature and a `thinkingBudget`.
 */
export function isGemini3OrLater(model: string): boolean {
  const major = /^gemini-(\d+)/u.exec(model)?.[1];
  return major === undefined ? true : Number(major) >= 3;
}

/** The thinking settings to try, in order; `undefined` (the last) leaves it to the model. */
export function thinkingVariants(model: string): (ThinkingConfig | undefined)[] {
  return isGemini3OrLater(model)
    ? [{ thinkingLevel: ThinkingLevel.MINIMAL }, { thinkingLevel: ThinkingLevel.LOW }, undefined]
    : [{ thinkingBudget: 0 }, undefined];
}

/** A 400 that complains about the thinking setting (a model that has no such level, or cannot be told not to think). */
class ThinkingRejected extends AppError {
  constructor() {
    super('LLM_FAILED', 'The model does not accept this thinking setting.', 'thinking setting rejected');
    this.name = 'ThinkingRejected';
  }
}

function rethrowThinkingRejection(error: unknown): never {
  const status = (error as { status?: unknown } | null)?.status;
  if (status === 400 && error instanceof Error && /thinking/iu.test(error.message))
    throw new ThinkingRejected();
  throw error;
}
