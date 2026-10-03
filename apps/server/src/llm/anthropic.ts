import Anthropic from '@anthropic-ai/sdk';
import type {
  MessageStreamParams,
  RawMessageStreamEvent,
} from '@anthropic-ai/sdk/resources/messages/messages';
import { LlmError, abortError, isAbortError, type LLMProvider, type LlmRequest } from './provider.js';

/**
 * Claude through the official SDK, streamed. The pieces that matter:
 *  - the key is read once from the configuration and only ever reaches the SDK client; every error that leaves this
 *    file is one of our own curated sentences (the SDK's message and the response body stay in `cause`);
 *  - the newest models fix their sampling: `temperature` other than the default is a 400 on Claude Sonnet 5 / Opus 5
 *    and later, so it is only sent to models that accept it;
 *  - the newest models think by default and `effort` replaces the thinking budget: a grounded answer needs little
 *    reasoning, so effort `low` keeps the time to the first token short (older models are not sent the field: some
 *    reject it);
 *  - a refusal arrives as a normal 200 with `stop_reason: "refusal"`: it becomes an LlmError, never an empty answer;
 *  - the stream is passed the request's AbortSignal, so a closed browser tab stops the generation.
 */

/** Models that reject any non-default sampling parameter (Sonnet 5+, Opus 4.7+, Fable, Mythos). */
const FIXED_SAMPLING = /^claude-(?:(?:sonnet|opus)-5|fable|mythos|opus-4-[78])/u;
/** Models that accept `output_config.effort` (Opus 4.5+, Sonnet 4.6+ and everything newer). */
const ACCEPTS_EFFORT = /^claude-(?:(?:sonnet|opus)-5|fable|mythos|opus-4-[5-9]|sonnet-4-[6-9])/u;

export const acceptsTemperature = (model: string): boolean => !FIXED_SAMPLING.test(model);
export const acceptsEffort = (model: string): boolean => ACCEPTS_EFFORT.test(model);

/** The part of the SDK client this provider uses (tests substitute it). */
export interface AnthropicLike {
  messages: {
    stream(
      body: MessageStreamParams,
      options?: { signal?: AbortSignal },
    ): AsyncIterable<RawMessageStreamEvent>;
  };
}

export interface AnthropicProviderOptions {
  apiKey: string | null;
  model: string;
  /** A stand-in for the SDK client (tests). */
  client?: AnthropicLike;
  /** Another API origin than api.anthropic.com (a test server). The SDK also reads ANTHROPIC_BASE_URL itself. */
  baseUrl?: string;
}

const UNAVAILABLE = 'The language model service is not reachable right now. Try again in a moment.';

export class AnthropicProvider implements LLMProvider {
  readonly name = 'anthropic';
  readonly model: string;
  private readonly apiKey: string | null;
  private readonly baseUrl: string | undefined;
  private client: AnthropicLike | undefined;

  constructor(options: AnthropicProviderOptions) {
    this.model = options.model;
    this.apiKey = options.apiKey;
    this.baseUrl = options.baseUrl;
    this.client = options.client;
  }

  isConfigured(): boolean {
    return this.apiKey !== null || this.client !== undefined;
  }

  private sdk(): AnthropicLike {
    if (this.client === undefined) {
      if (this.apiKey === null) {
        throw new LlmError('LLM_UNAVAILABLE', 'No Anthropic API key is configured on this server.');
      }
      this.client = new Anthropic({
        apiKey: this.apiKey,
        maxRetries: 2,
        ...(this.baseUrl === undefined ? {} : { baseURL: this.baseUrl }),
      });
    }
    return this.client;
  }

  async *stream(request: LlmRequest): AsyncGenerator<string> {
    const client = this.sdk();
    const body: MessageStreamParams = {
      model: this.model,
      max_tokens: request.maxTokens,
      system: request.system,
      messages: request.messages,
      ...(acceptsTemperature(this.model) ? { temperature: request.temperature } : {}),
      ...(acceptsEffort(this.model) ? { output_config: { effort: 'low' } } : {}),
    };
    let stopReason: string | null = null;
    try {
      const events = client.messages.stream(
        body,
        request.signal === undefined ? {} : { signal: request.signal },
      );
      for await (const event of events) {
        if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
          yield event.delta.text;
        } else if (event.type === 'message_delta') {
          stopReason = event.delta.stop_reason ?? stopReason;
        }
      }
    } catch (error) {
      throw mapAnthropicError(error, request.signal);
    }
    if (stopReason === 'refusal') {
      throw new LlmError('LLM_FAILED', 'The language model declined to answer this request.');
    }
    // `max_tokens` is the output limit; `model_context_window_exceeded` and `pause_turn` also leave the text unfinished
    request.onFinish?.({
      reason: stopReason,
      truncated:
        stopReason === 'max_tokens' ||
        stopReason === 'model_context_window_exceeded' ||
        stopReason === 'pause_turn',
    });
  }
}

/** Our own error for whatever the SDK threw. An abort stays an abort. */
export function mapAnthropicError(error: unknown, signal: AbortSignal | undefined): Error {
  if (error instanceof LlmError) return error;
  if (signal?.aborted === true || error instanceof Anthropic.APIUserAbortError || isAbortError(error)) {
    return abortError(signal);
  }
  if (error instanceof Anthropic.APIError) {
    const status = typeof error.status === 'number' ? error.status : undefined;
    const options = { cause: error, ...(status === undefined ? {} : { status }) };
    if (status === 401 || status === 403) {
      return new LlmError(
        'LLM_UNAVAILABLE',
        'The language model rejected this server’s credentials.',
        options,
      );
    }
    if (status === 404) {
      return new LlmError('LLM_UNAVAILABLE', 'The configured language model is not available.', options);
    }
    if (status === 429 || (status !== undefined && status >= 500) || status === undefined) {
      // 429, 5xx (529 means overloaded) and connection failures (no status) are worth trying again later.
      return new LlmError('LLM_UNAVAILABLE', UNAVAILABLE, options);
    }
    return new LlmError('LLM_FAILED', 'The language model could not process this request.', options);
  }
  return new LlmError('LLM_FAILED', 'The language model failed unexpectedly.', { cause: error });
}
