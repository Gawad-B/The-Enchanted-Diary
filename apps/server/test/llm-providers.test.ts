import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { AnthropicProvider, acceptsEffort, acceptsTemperature } from '../src/llm/anthropic.js';
import { createLlmProvider } from '../src/llm/index.js';
import { OpenAICompatibleProvider } from '../src/llm/openai.js';
import { LlmError, NoLlmProvider, type LlmRequest } from '../src/llm/provider.js';
import { testConfig } from './helpers.js';

const REQUEST: LlmRequest = {
  system: 'You are a diary.',
  messages: [{ role: 'user', content: 'Hello?' }],
  maxTokens: 123,
  temperature: 0.2,
};
const SECRET = 'sk-test-secret-0123456789';

async function collect(stream: AsyncIterable<string>): Promise<string> {
  let text = '';
  for await (const piece of stream) text += piece;
  return text;
}

async function failureOf(stream: AsyncIterable<string>): Promise<unknown> {
  try {
    await collect(stream);
  } catch (error) {
    return error;
  }
  throw new Error('the stream did not fail');
}

// --- a tiny HTTP server that plays the part of a provider ----------------------------------------------------

interface Seen {
  method: string | undefined;
  url: string | undefined;
  headers: IncomingMessage['headers'];
  body: Record<string, unknown>;
}

type Handler = (seen: Seen, response: ServerResponse) => void;

const servers: Server[] = [];
async function startProvider(handler: Handler): Promise<{ origin: string; seen: Seen[] }> {
  const seen: Seen[] = [];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const entry: Seen = {
        method: request.method,
        url: request.url,
        headers: request.headers,
        body: JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as Record<string, unknown>,
      };
      seen.push(entry);
      handler(entry, response);
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { origin: `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`, seen };
}
afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        }),
    ),
  );
});

const sse = (response: ServerResponse, frames: string[], options: { keepOpen?: boolean } = {}): void => {
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  for (const frame of frames) response.write(frame);
  if (options.keepOpen !== true) response.end();
};

// --- Anthropic -----------------------------------------------------------------------------------------------

function anthropicFrames(texts: string[], stopReason = 'end_turn'): string[] {
  const frame = (type: string, data: object): string =>
    `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
  return [
    frame('message_start', {
      message: {
        id: 'msg_1',
        type: 'message',
        role: 'assistant',
        model: 'claude-sonnet-5-5',
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: 1 },
      },
    }),
    frame('content_block_start', { index: 0, content_block: { type: 'text', text: '' } }),
    ...texts.map((text) => frame('content_block_delta', { index: 0, delta: { type: 'text_delta', text } })),
    frame('content_block_stop', { index: 0 }),
    frame('message_delta', {
      delta: { stop_reason: stopReason, stop_sequence: null, stop_details: null },
      usage: { output_tokens: 5 },
    }),
    frame('message_stop', {}),
  ];
}

describe('AnthropicProvider (through the real SDK, against a local stand-in for the API)', () => {
  it('streams the text deltas and sends the request the newest models accept', async () => {
    const api = await startProvider((_seen, response) =>
      sse(response, anthropicFrames(['The doc', 'ument states', ' it.'])),
    );
    const provider = new AnthropicProvider({
      apiKey: SECRET,
      model: 'claude-sonnet-5-5',
      baseUrl: api.origin,
    });
    expect(provider).toMatchObject({ name: 'anthropic', model: 'claude-sonnet-5-5' });
    expect(provider.isConfigured()).toBe(true);
    expect(await collect(provider.stream(REQUEST))).toBe('The document states it.');
    const [seen] = api.seen;
    expect(seen?.url).toBe('/v1/messages');
    expect(seen?.headers['x-api-key']).toBe(SECRET);
    expect(seen?.body).toMatchObject({
      model: 'claude-sonnet-5-5',
      max_tokens: 123,
      stream: true,
      system: 'You are a diary.',
      messages: [{ role: 'user', content: 'Hello?' }],
      output_config: { effort: 'low' },
    });
    // Claude Sonnet 5.5 rejects any temperature but the default: none is sent
    expect(seen?.body).not.toHaveProperty('temperature');
    expect(seen?.body).not.toHaveProperty('thinking');
  });

  it('sends the temperature, and no effort, to models that take one and not the other', async () => {
    const api = await startProvider((_seen, response) => sse(response, anthropicFrames(['ok'])));
    await collect(
      new AnthropicProvider({ apiKey: SECRET, model: 'claude-haiku-4-5', baseUrl: api.origin }).stream(
        REQUEST,
      ),
    );
    await collect(
      new AnthropicProvider({ apiKey: SECRET, model: 'claude-sonnet-4-6', baseUrl: api.origin }).stream(
        REQUEST,
      ),
    );
    expect(api.seen[0]?.body).toMatchObject({ temperature: 0.2 });
    expect(api.seen[0]?.body).not.toHaveProperty('output_config');
    expect(api.seen[1]?.body).toMatchObject({ temperature: 0.2, output_config: { effort: 'low' } });
    expect(
      [
        'claude-sonnet-5-5',
        'claude-opus-5-5',
        'claude-fable-5-1',
        'claude-sonnet-5',
        'claude-opus-4-8',
        'claude-opus-4-7',
      ].map(acceptsTemperature),
    ).toEqual(Array<boolean>(6).fill(false));
    expect(
      ['claude-opus-4-6', 'claude-sonnet-4-6', 'claude-haiku-4-5', 'claude-sonnet-4-5'].map(
        acceptsTemperature,
      ),
    ).toEqual(Array<boolean>(4).fill(true));
    expect(
      ['claude-sonnet-5-5', 'claude-opus-4-5', 'claude-sonnet-4-6', 'claude-fable-5'].map(acceptsEffort),
    ).toEqual(Array<boolean>(4).fill(true));
    expect(['claude-haiku-4-5', 'claude-sonnet-4-5'].map(acceptsEffort)).toEqual([false, false]);
  });

  it('turns a refusal (HTTP 200, stop_reason refusal) into an error, never an empty answer', async () => {
    const api = await startProvider((_seen, response) => sse(response, anthropicFrames([], 'refusal')));
    const failure = await failureOf(
      new AnthropicProvider({ apiKey: SECRET, model: 'claude-sonnet-5-5', baseUrl: api.origin }).stream(
        REQUEST,
      ),
    );
    expect(failure).toBeInstanceOf(LlmError);
    expect((failure as LlmError).code).toBe('LLM_FAILED');
  });

  it.each([
    [401, 'LLM_UNAVAILABLE'],
    [403, 'LLM_UNAVAILABLE'],
    [404, 'LLM_UNAVAILABLE'],
    [429, 'LLM_UNAVAILABLE'],
    [529, 'LLM_UNAVAILABLE'],
    [400, 'LLM_FAILED'],
    [422, 'LLM_FAILED'],
  ] as const)(
    'maps an HTTP %i to %s with one of our own sentences, never the key or the provider’s text',
    async (status, code) => {
      const api = await startProvider((_seen, response) => {
        response.writeHead(status, { 'content-type': 'application/json', 'x-should-retry': 'false' });
        response.end(
          JSON.stringify({
            type: 'error',
            error: { type: 'x', message: `invalid x-api-key ${SECRET} for org secret-org` },
          }),
        );
      });
      const failure = (await failureOf(
        new AnthropicProvider({ apiKey: SECRET, model: 'claude-sonnet-5-5', baseUrl: api.origin }).stream(
          REQUEST,
        ),
      )) as LlmError;
      expect(failure).toBeInstanceOf(LlmError);
      expect(failure.code).toBe(code);
      expect(failure.status).toBe(status);
      expect(failure.message).not.toContain(SECRET);
      expect(failure.message).not.toContain('secret-org');
      expect(
        JSON.stringify({ message: failure.message, code: failure.code, status: failure.status }),
      ).not.toContain(SECRET);
    },
  );

  it('maps a connection failure to LLM_UNAVAILABLE', async () => {
    const provider = new AnthropicProvider({
      apiKey: SECRET,
      model: 'claude-sonnet-5-5',
      baseUrl: 'http://127.0.0.1:9',
    });
    const failure = (await failureOf(provider.stream(REQUEST))) as LlmError;
    expect(failure.code).toBe('LLM_UNAVAILABLE');
    expect(failure.message).not.toContain(SECRET);
  }, 30_000);

  it('stops when its request is aborted, with an AbortError', async () => {
    const api = await startProvider((_seen, response) =>
      sse(response, anthropicFrames(['Hel']).slice(0, 3), { keepOpen: true }),
    );
    const controller = new AbortController();
    const provider = new AnthropicProvider({
      apiKey: SECRET,
      model: 'claude-sonnet-5-5',
      baseUrl: api.origin,
    });
    const received: string[] = [];
    const failure = await (async () => {
      try {
        for await (const piece of provider.stream({ ...REQUEST, signal: controller.signal })) {
          received.push(piece);
          controller.abort();
        }
      } catch (error) {
        return error;
      }
      return null;
    })();
    expect(received).toEqual(['Hel']);
    expect((failure as Error).name).toBe('AbortError');
    expect(failure).not.toBeInstanceOf(LlmError);
  });

  it('is not configured without a key, and fails without any network call', async () => {
    const provider = new AnthropicProvider({ apiKey: null, model: 'claude-sonnet-5-5' });
    expect(provider.isConfigured()).toBe(false);
    expect(((await failureOf(provider.stream(REQUEST))) as LlmError).code).toBe('LLM_UNAVAILABLE');
  });
});

// --- OpenAI-compatible ---------------------------------------------------------------------------------------

const chat = (content: string | null, extra: object = {}): string =>
  `data: ${JSON.stringify({ choices: [{ delta: content === null ? { role: 'assistant' } : { content }, ...extra }] })}\n\n`;

describe('how a reply ended, for the providers that are not Gemini (review NB-16)', () => {
  it('Anthropic reports the output limit as a truncated reply, and a normal end as a complete one', async () => {
    const ends: { reason: string | null; truncated: boolean }[] = [];
    for (const stopReason of ['max_tokens', 'end_turn']) {
      const api = await startProvider((_seen, response) =>
        sse(response, anthropicFrames(['The doc', 'ument'], stopReason)),
      );
      const provider = new AnthropicProvider({
        apiKey: SECRET,
        model: 'claude-sonnet-5-5',
        baseUrl: api.origin,
      });
      await collect(provider.stream({ ...REQUEST, onFinish: (info) => ends.push(info) }));
    }
    expect(ends).toEqual([
      { reason: 'max_tokens', truncated: true },
      { reason: 'end_turn', truncated: false },
    ]);
  });

  it('an OpenAI-compatible endpoint reports finish_reason "length" as a truncated reply', async () => {
    const ends: { reason: string | null; truncated: boolean }[] = [];
    for (const finish of ['length', 'content_filter', 'stop']) {
      const api = await startProvider((_seen, response) =>
        sse(response, [
          chat('The doc'),
          chat('ument'),
          chat('', { finish_reason: finish }),
          'data: [DONE]\n\n',
        ]),
      );
      const provider = new OpenAICompatibleProvider({
        baseUrl: `${api.origin}/v1/`,
        apiKey: SECRET,
        model: 'llama3.2',
        configured: true,
      });
      await collect(provider.stream({ ...REQUEST, onFinish: (info) => ends.push(info) }));
    }
    expect(ends).toEqual([
      { reason: 'length', truncated: true },
      { reason: 'content_filter', truncated: true },
      { reason: 'stop', truncated: false },
    ]);
  });
});

describe('OpenAICompatibleProvider', () => {
  const make = (origin: string, apiKey: string | null = SECRET, extra: object = {}) =>
    new OpenAICompatibleProvider({
      baseUrl: `${origin}/v1/`,
      apiKey,
      model: 'llama3.2',
      configured: true,
      ...extra,
    });

  it('streams the content deltas of a chat completion and sends the key only as a bearer token', async () => {
    const api = await startProvider((_seen, response) =>
      sse(response, [
        chat(null),
        chat('The doc'),
        ': keep-alive\n\n',
        chat('ument'),
        chat('', { finish_reason: 'stop' }),
        'data: [DONE]\n\n',
      ]),
    );
    expect(await collect(make(api.origin).stream(REQUEST))).toBe('The document');
    const [seen] = api.seen;
    expect(seen).toMatchObject({ method: 'POST', url: '/v1/chat/completions' });
    expect(seen?.headers.authorization).toBe(`Bearer ${SECRET}`);
    expect(seen?.body).toMatchObject({
      model: 'llama3.2',
      stream: true,
      max_tokens: 123,
      temperature: 0.2,
      messages: [
        { role: 'system', content: 'You are a diary.' },
        { role: 'user', content: 'Hello?' },
      ],
    });
    expect(JSON.stringify(seen?.body)).not.toContain(SECRET);
  });

  it('works with a local server that needs no key, and reassembles frames split across network chunks', async () => {
    const api = await startProvider((_seen, response) => {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      const text = `${chat('Alaric')}${chat(' Thornquist')}data: [DONE]\n\n`;
      for (let index = 0; index < text.length; index += 7) response.write(text.slice(index, index + 7));
      response.end();
    });
    const provider = make(api.origin, null);
    expect(await collect(provider.stream(REQUEST))).toBe('Alaric Thornquist');
    expect(api.seen[0]?.headers.authorization).toBeUndefined();
  });

  it('adapts once to a model that wants max_completion_tokens, and to one that takes no temperature', async () => {
    const api = await startProvider((seen, response) => {
      if ('max_tokens' in seen.body) {
        response.writeHead(400, { 'content-type': 'application/json' });
        response.end(
          '{"error":{"message":"Unsupported parameter: max_tokens. Use max_completion_tokens instead."}}',
        );
      } else if ('temperature' in seen.body) {
        response.writeHead(400, { 'content-type': 'application/json' });
        response.end('{"error":{"message":"temperature does not support 0.2 with this model"}}');
      } else sse(response, [chat('fine'), 'data: [DONE]\n\n']);
    });
    expect(await collect(make(api.origin).stream(REQUEST))).toBe('fine');
    expect(api.seen).toHaveLength(3);
    expect(api.seen[1]?.body).toMatchObject({ max_completion_tokens: 123 });
    expect(api.seen[1]?.body).not.toHaveProperty('max_tokens');
    expect(api.seen[2]?.body).not.toHaveProperty('temperature');
  });

  it.each([
    [401, 'LLM_UNAVAILABLE'],
    [404, 'LLM_UNAVAILABLE'],
    [429, 'LLM_UNAVAILABLE'],
    [503, 'LLM_UNAVAILABLE'],
    [400, 'LLM_FAILED'],
    [422, 'LLM_FAILED'],
  ] as const)('maps HTTP %i to %s without copying the body or the key', async (status, code) => {
    const api = await startProvider((_seen, response) => {
      response.writeHead(status, { 'content-type': 'application/json' });
      response.end(`{"error":{"message":"bad key ${SECRET} rejected by internal-host-7"}}`);
    });
    const failure = (await failureOf(make(api.origin).stream(REQUEST))) as LlmError;
    expect(failure).toBeInstanceOf(LlmError);
    expect([failure.code, failure.status]).toEqual([code, status]);
    expect(failure.message).not.toContain(SECRET);
    expect(failure.message).not.toContain('internal-host-7');
  });

  it('maps a refused connection to LLM_UNAVAILABLE and an error frame to LLM_FAILED', async () => {
    expect(((await failureOf(make('http://127.0.0.1:9').stream(REQUEST))) as LlmError).code).toBe(
      'LLM_UNAVAILABLE',
    );
    const api = await startProvider((_seen, response) =>
      sse(response, [chat('Hi'), `data: ${JSON.stringify({ error: { message: 'boom' } })}\n\n`]),
    );
    const failure = (await failureOf(make(api.origin).stream(REQUEST))) as LlmError;
    expect(failure.code).toBe('LLM_FAILED');
    expect(failure.message).not.toContain('boom');
  });

  it('stops when its request is aborted, and does not start for an already aborted one', async () => {
    const api = await startProvider((_seen, response) => sse(response, [chat('One ')], { keepOpen: true }));
    const controller = new AbortController();
    const received: string[] = [];
    const failure = await (async () => {
      try {
        for await (const piece of make(api.origin).stream({ ...REQUEST, signal: controller.signal })) {
          received.push(piece);
          controller.abort();
        }
      } catch (error) {
        return error;
      }
      return null;
    })();
    expect(received).toEqual(['One ']);
    expect((failure as Error).name).toBe('AbortError');
    const already = AbortSignal.abort();
    expect(((await failureOf(make(api.origin).stream({ ...REQUEST, signal: already }))) as Error).name).toBe(
      'AbortError',
    );
  });

  it('is not configured when the operator gave neither a key nor another base URL', async () => {
    const provider = new OpenAICompatibleProvider({
      baseUrl: 'https://api.openai.com/v1',
      apiKey: null,
      model: 'm',
      configured: false,
    });
    expect(provider.isConfigured()).toBe(false);
    expect(((await failureOf(provider.stream(REQUEST))) as LlmError).code).toBe('LLM_UNAVAILABLE');
  });
});

// --- the factory ----------------------------------------------------------------------------------------------

describe('createLlmProvider', () => {
  it('builds the provider the configuration asks for, and says whether it can answer', () => {
    const anthropic = createLlmProvider(testConfig({ LLM_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: SECRET }));
    expect(anthropic).toMatchObject({ name: 'anthropic', model: 'claude-sonnet-5-5' });
    expect(anthropic.isConfigured()).toBe(true);
    expect(createLlmProvider(testConfig({ LLM_PROVIDER: 'anthropic' })).isConfigured()).toBe(false);

    const hosted = createLlmProvider(testConfig({ LLM_PROVIDER: 'openai', LLM_MODEL: 'gpt-x' }));
    expect(hosted).toMatchObject({ name: 'openai', model: 'gpt-x' });
    expect(hosted.isConfigured()).toBe(false);
    expect(
      createLlmProvider(
        testConfig({ LLM_PROVIDER: 'openai', LLM_MODEL: 'gpt-x', OPENAI_API_KEY: SECRET }),
      ).isConfigured(),
    ).toBe(true);
    expect(
      createLlmProvider(
        testConfig({
          LLM_PROVIDER: 'openai',
          LLM_MODEL: 'llama3.2',
          OPENAI_BASE_URL: 'http://localhost:11434/v1',
        }),
      ).isConfigured(),
    ).toBe(true);

    const gemini = createLlmProvider(testConfig({ GEMINI_API_KEY: SECRET }));
    expect(gemini).toMatchObject({ name: 'gemini', model: 'gemini-3.5-flash-lite' });
    expect(gemini.isConfigured()).toBe(true);
    expect(createLlmProvider(testConfig()).isConfigured()).toBe(false);

    const none = createLlmProvider(testConfig({ LLM_PROVIDER: 'none' }));
    expect(none).toBeInstanceOf(NoLlmProvider);
    expect(none.isConfigured()).toBe(false);
  });

  it('a provider that is not configured refuses to stream with LLM_UNAVAILABLE', async () => {
    expect(((await failureOf(new NoLlmProvider().stream())) as LlmError).code).toBe('LLM_UNAVAILABLE');
  });
});
