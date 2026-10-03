import {
  LLM_FIRST_BYTE_TIMEOUT_MS,
  LLM_STALL_TIMEOUT_MS,
  LlmError,
  abortError,
  isAbortError,
  type LLMProvider,
  type LlmRequest,
} from './provider.js';

/**
 * Any server that speaks the OpenAI chat-completions protocol: OpenAI, Ollama, LM Studio, vLLM, Groq. The reply is
 * read as Server-Sent Events (`data: {json}` lines ending with `data: [DONE]`) straight from `fetch`.
 *
 * The key travels only in the Authorization header. A non-2xx answer is read for hints (some models want
 * `max_completion_tokens` instead of `max_tokens`, some accept no temperature) and retried once per hint, but its
 * body is never copied into an error: the messages are our own.
 */

export interface OpenAICompatibleOptions {
  baseUrl: string;
  /** Null for local servers that need no key. */
  apiKey: string | null;
  model: string;
  /** Whether the provider counts as configured: a key, or a base URL other than api.openai.com. */
  configured: boolean;
  fetch?: typeof fetch;
}

interface ChatBody {
  model: string;
  stream: true;
  messages: { role: 'system' | 'user' | 'assistant'; content: string }[];
  max_tokens?: number;
  max_completion_tokens?: number;
  temperature?: number;
}

interface ChatChunk {
  choices?: { delta?: { content?: unknown }; finish_reason?: string | null }[];
  error?: unknown;
}

const MAX_ADAPTATIONS = 2;

export class OpenAICompatibleProvider implements LLMProvider {
  readonly name = 'openai';
  readonly model: string;
  private readonly options: OpenAICompatibleOptions;

  constructor(options: OpenAICompatibleOptions) {
    this.options = options;
    this.model = options.model;
  }

  isConfigured(): boolean {
    return this.options.configured;
  }

  private url(): string {
    return `${this.options.baseUrl.replace(/\/+$/u, '')}/chat/completions`;
  }

  async *stream(request: LlmRequest): AsyncGenerator<string> {
    if (!this.options.configured) {
      throw new LlmError('LLM_UNAVAILABLE', 'No API key is configured for the language model.');
    }
    const body: ChatBody = {
      model: this.model,
      stream: true,
      messages: [{ role: 'system', content: request.system }, ...request.messages],
      max_tokens: request.maxTokens,
      temperature: request.temperature,
    };

    // One controller covers the caller's signal, the time to the first byte and stalls between chunks.
    const controller = new AbortController();
    const onAbort = (): void => controller.abort(abortError(request.signal));
    if (request.signal?.aborted === true) throw abortError(request.signal);
    request.signal?.addEventListener('abort', onAbort, { once: true });
    let timer: NodeJS.Timeout | undefined;
    let timedOut = false;
    const arm = (ms: number): void => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        timedOut = true;
        controller.abort(new DOMException('The language model stopped answering', 'TimeoutError'));
      }, ms);
    };
    try {
      let sent = body;
      let response = await this.post(sent, controller.signal, () => arm(LLM_FIRST_BYTE_TIMEOUT_MS));
      for (let adaptation = 0; !response.ok && adaptation < MAX_ADAPTATIONS; adaptation += 1) {
        const hint = await adaptationFor(response, sent);
        if (hint === null) break;
        sent = hint;
        response = await this.post(sent, controller.signal, () => arm(LLM_FIRST_BYTE_TIMEOUT_MS));
      }
      if (!response.ok) throw statusError(response.status);
      if (response.body === null) throw new LlmError('LLM_FAILED', 'The language model sent no answer.');

      const decoder = new TextDecoder();
      let buffer = '';
      let finished = false;
      let finishReason: string | null = null;
      const reader = response.body.getReader();
      try {
        while (!finished) {
          arm(LLM_STALL_TIMEOUT_MS);
          const chunk = await reader.read();
          if (chunk.done) break;
          buffer += decoder.decode(chunk.value as Uint8Array, { stream: true });
          let newline = buffer.indexOf('\n');
          while (newline !== -1) {
            const line = buffer.slice(0, newline).trim();
            buffer = buffer.slice(newline + 1);
            newline = buffer.indexOf('\n');
            if (!line.startsWith('data:')) continue; // comments, `event:` names, blank lines
            const data = line.slice('data:'.length).trim();
            if (data === '[DONE]') {
              finished = true;
              break;
            }
            finishReason = finishReasonOf(data) ?? finishReason;
            const text = textOf(data);
            if (text !== '') yield text;
          }
        }
      } finally {
        await reader.cancel().catch(() => undefined);
      }
      request.onFinish?.({
        reason: finishReason,
        truncated: finishReason === 'length' || finishReason === 'content_filter',
      });
    } catch (error) {
      throw mapFetchError(error, request.signal, timedOut);
    } finally {
      clearTimeout(timer);
      request.signal?.removeEventListener('abort', onAbort);
    }
  }

  private async post(body: ChatBody, signal: AbortSignal, onSent: () => void): Promise<Response> {
    const doFetch = this.options.fetch ?? fetch;
    onSent();
    return doFetch(this.url(), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'text/event-stream',
        ...(this.options.apiKey === null ? {} : { authorization: `Bearer ${this.options.apiKey}` }),
      },
      body: JSON.stringify(body),
      signal,
    });
  }
}

/** The `finish_reason` of one SSE data payload, when it carries one (`length` is the output limit). */
function finishReasonOf(data: string): string | null {
  try {
    const reason = (JSON.parse(data) as ChatChunk).choices?.[0]?.finish_reason;
    return typeof reason === 'string' ? reason : null;
  } catch {
    return null;
  }
}

/** The text of one SSE data payload, or '' for a frame without content (role announcements, finish frames). */
function textOf(data: string): string {
  let parsed: ChatChunk;
  try {
    parsed = JSON.parse(data) as ChatChunk;
  } catch {
    return '';
  }
  if (parsed.error !== undefined) {
    throw new LlmError('LLM_FAILED', 'The language model reported an error while answering.');
  }
  const content = parsed.choices?.[0]?.delta?.content;
  return typeof content === 'string' ? content : '';
}

/**
 * Some models reject a parameter the others need. A 400 whose body names it gives a changed request to try once:
 * `max_completion_tokens` replaces `max_tokens`, and a model that accepts no temperature is sent none.
 */
async function adaptationFor(response: Response, body: ChatBody): Promise<ChatBody | null> {
  if (response.status !== 400) return null;
  const text = (await response.text().catch(() => '')).toLowerCase();
  if (text.includes('max_completion_tokens') && body.max_tokens !== undefined) {
    const { max_tokens: maxTokens, ...rest } = body;
    return { ...rest, max_completion_tokens: maxTokens };
  }
  if (text.includes('temperature') && body.temperature !== undefined) {
    const { temperature: _dropped, ...rest } = body;
    return rest;
  }
  return null;
}

function statusError(status: number): LlmError {
  if (status === 401 || status === 403) {
    return new LlmError('LLM_UNAVAILABLE', 'The language model rejected this server’s credentials.', {
      status,
    });
  }
  if (status === 404) {
    return new LlmError('LLM_UNAVAILABLE', 'The configured language model is not available.', { status });
  }
  if (status === 429 || status >= 500) {
    return new LlmError(
      'LLM_UNAVAILABLE',
      'The language model service is busy or not reachable right now. Try again in a moment.',
      { status },
    );
  }
  return new LlmError('LLM_FAILED', 'The language model could not process this request.', { status });
}

function mapFetchError(error: unknown, signal: AbortSignal | undefined, timedOut: boolean): Error {
  if (error instanceof LlmError) return error;
  if (signal?.aborted === true) return abortError(signal);
  if (timedOut) {
    return new LlmError('LLM_UNAVAILABLE', 'The language model took too long to answer.', { cause: error });
  }
  if (isAbortError(error)) return error as Error;
  // fetch rejects with a TypeError for DNS failures, refused connections and resets.
  return new LlmError('LLM_UNAVAILABLE', 'The language model could not be reached.', { cause: error });
}
