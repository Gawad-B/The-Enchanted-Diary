import type { AnswerStreamEvent } from '@enchanted/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, isAbortError } from '../../src/api/client';
import { ASK_STALL_MS, askStream, type AskError } from '../../src/api/ask';
import { apiError, installFetch } from '../helpers/network';

const DOCUMENT_ID = '3b6f1f0e-8a52-4d6b-9d0c-6f1f6d0b7e11';
const MESSAGE_ID = '0c9b1e52-4a0b-4f0f-b9f6-2f1d5c3a9e77';
const CHUNK_ID = '5d0a3d1c-7f31-4c1e-8f7e-0d9d3a9d6b11';

const frame = (event: AnswerStreamEvent): string => `data: ${JSON.stringify(event)}\n\n`;
const encoder = new TextEncoder();

const done: AnswerStreamEvent = {
  type: 'done',
  messageId: MESSAGE_ID,
  answer: 'Hello.',
  mode: 'answer',
  grounded: true,
  refusedBy: null,
  timingsMs: { retrieval: 10, firstToken: 20, total: 30 },
};

/** A streaming response whose chunks the test pushes by hand (so a frame can be split anywhere, and time can pass). */
function openStream() {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
  });
  return {
    response: new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } }),
    push: (text: string) => {
      controller.enqueue(encoder.encode(text));
    },
    close: () => {
      controller.close();
    },
    error: (reason: unknown) => {
      controller.error(reason);
    },
  };
}

const collect = () => {
  const events: AnswerStreamEvent[] = [];
  return { events, onEvent: (event: AnswerStreamEvent) => events.push(event) };
};

beforeEach(() => {
  vi.useRealTimers();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('askStream: the answer stream of POST /api/documents/:id/ask', () => {
  it('posts the question with the pages in view and a streaming accept header', async () => {
    const stream = openStream();
    const { calls } = installFetch({
      [`POST /api/documents/${DOCUMENT_ID}/ask`]: () => stream.response,
    });
    stream.push(frame(done));
    stream.close();
    await askStream({
      documentId: DOCUMENT_ID,
      question: 'Who founded it?',
      visiblePages: [3, 4],
      ...collect(),
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.body).toEqual({ question: 'Who founded it?', context: { visiblePages: [3, 4] } });
    expect(calls[0]?.headers['content-type']).toContain('application/json');
    expect(calls[0]?.headers.accept).toContain('text/event-stream');
  });

  it('sends no context when no page is in view', async () => {
    const stream = openStream();
    const { calls } = installFetch({
      [`POST /api/documents/${DOCUMENT_ID}/ask`]: () => stream.response,
    });
    stream.push(frame(done));
    stream.close();
    await askStream({ documentId: DOCUMENT_ID, question: 'Q', visiblePages: [], ...collect() });
    expect(calls[0]?.body).toEqual({ question: 'Q' });
  });

  it('delivers every event type, in order, parsed by the shared schema', async () => {
    const stream = openStream();
    installFetch({ [`POST /api/documents/${DOCUMENT_ID}/ask`]: () => stream.response });
    const { events, onEvent } = collect();
    const pending = askStream({ documentId: DOCUMENT_ID, question: 'Q', visiblePages: [], onEvent });
    const sent: AnswerStreamEvent[] = [
      { type: 'status', stage: 'retrieving', elapsedMs: 3 },
      {
        type: 'retrieval',
        query: 'Q',
        rewrittenQuery: null,
        searchedChunks: 312,
        retrievedChunks: 6,
        pages: [3, 7, 12],
        evidence: 'strong',
        timingsMs: { embed: 1, semantic: 2, lexical: 1, total: 5 },
      },
      { type: 'status', stage: 'generating', elapsedMs: 9 },
      { type: 'token', text: 'Hel' },
      { type: 'token', text: 'lo.' },
      {
        type: 'citations',
        citations: [
          {
            marker: 'S1',
            chunkId: CHUNK_ID,
            pageStart: 3,
            pageEnd: 3,
            sectionTitle: null,
            snippet: 'x',
            language: 'en',
            direction: 'ltr',
            highlights: [],
          },
        ],
        consulted: [{ page: 3 }],
      },
      done,
    ];
    for (const event of sent) stream.push(frame(event));
    stream.close();
    await pending;
    expect(events).toEqual(sent);
  });

  it('survives a frame split across chunks (a byte-level split inside a multi-byte character)', async () => {
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        controller = c;
      },
    });
    installFetch({
      [`POST /api/documents/${DOCUMENT_ID}/ask`]: () =>
        new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } }),
    });
    const { events, onEvent } = collect();
    const pending = askStream({ documentId: DOCUMENT_ID, question: 'Q', visiblePages: [], onEvent });
    const bytes = encoder.encode(frame({ type: 'token', text: 'مرحبا' }) + frame(done));
    for (const [from, to] of [
      [0, 20],
      [20, 21], // inside the first Arabic letter's two bytes
      [21, 22],
      [22, bytes.length],
    ] as const) {
      controller.enqueue(bytes.slice(from, to));
    }
    controller.close();
    await pending;
    expect(events.map((event) => event.type)).toEqual(['token', 'done']);
    expect(events[0]).toEqual({ type: 'token', text: 'مرحبا' });
  });

  it('ignores frames it cannot read or does not know, and an event of a known type in the wrong shape', async () => {
    const stream = openStream();
    installFetch({ [`POST /api/documents/${DOCUMENT_ID}/ask`]: () => stream.response });
    const { events, onEvent } = collect();
    const pending = askStream({ documentId: DOCUMENT_ID, question: 'Q', visiblePages: [], onEvent });
    stream.push('data: {not json\n\n');
    stream.push('data: {"type":"sparkle","magic":1}\n\n');
    stream.push('data: {"type":"token"}\n\n'); // a token without text
    stream.push(frame({ type: 'token', text: 'ok' }));
    stream.push(frame(done));
    stream.close();
    await pending;
    expect(events.map((event) => event.type)).toEqual(['token', 'done']);
  });

  it('reports every byte as activity, heartbeat comments included', async () => {
    const stream = openStream();
    installFetch({ [`POST /api/documents/${DOCUMENT_ID}/ask`]: () => stream.response });
    const onActivity = vi.fn();
    const pending = askStream({
      documentId: DOCUMENT_ID,
      question: 'Q',
      visiblePages: [],
      onEvent: () => undefined,
      onActivity,
    });
    stream.push(': hb\n\n');
    stream.push(': hb\n\n');
    stream.push(frame(done));
    stream.close();
    await pending;
    expect(onActivity.mock.calls.length).toBeGreaterThanOrEqual(3);
  });

  it('ends with an error when the stream closes without a done or error event', async () => {
    const stream = openStream();
    installFetch({ [`POST /api/documents/${DOCUMENT_ID}/ask`]: () => stream.response });
    const pending = askStream({
      documentId: DOCUMENT_ID,
      question: 'Q',
      visiblePages: [],
      onEvent: () => undefined,
    });
    stream.push(frame({ type: 'token', text: 'half' }));
    stream.close();
    await expect(pending).rejects.toMatchObject({ code: 'NETWORK' });
  });

  it('is finished as soon as the done event has arrived, without waiting for the connection to close', async () => {
    const stream = openStream();
    installFetch({ [`POST /api/documents/${DOCUMENT_ID}/ask`]: () => stream.response });
    const { events, onEvent } = collect();
    const pending = askStream({ documentId: DOCUMENT_ID, question: 'Q', visiblePages: [], onEvent });
    stream.push(frame({ type: 'token', text: 'ok' }) + frame(done)); // and the stream is NOT closed
    await pending;
    expect(events.map((event) => event.type)).toEqual(['token', 'done']);
  });

  it('treats an error event as the end of the stream (the caller got it as an event)', async () => {
    const stream = openStream();
    installFetch({ [`POST /api/documents/${DOCUMENT_ID}/ask`]: () => stream.response });
    const { events, onEvent } = collect();
    const pending = askStream({ documentId: DOCUMENT_ID, question: 'Q', visiblePages: [], onEvent });
    stream.push(frame({ type: 'error', error: { code: 'LLM_FAILED', message: 'upstream', detail: 'x' } }));
    stream.close();
    await pending;
    expect(events).toEqual([
      { type: 'error', error: { code: 'LLM_FAILED', message: 'upstream', detail: 'x' } },
    ]);
  });

  it('keeps reading after an error event when a done event follows (an output block says why, then answers)', async () => {
    const stream = openStream();
    installFetch({ [`POST /api/documents/${DOCUMENT_ID}/ask`]: () => stream.response });
    const { events, onEvent } = collect();
    const pending = askStream({ documentId: DOCUMENT_ID, question: 'Q', visiblePages: [], onEvent });
    stream.push(frame({ type: 'error', error: { code: 'OUTPUT_BLOCKED', message: 'held back' } }));
    stream.push(frame(done));
    stream.close();
    await pending;
    expect(events.map((event) => event.type)).toEqual(['error', 'done']);
  });
});

describe('askStream: failures before and during the stream', () => {
  it('maps an error body to an ApiError with the code, detail and Retry-After', async () => {
    installFetch({
      [`POST /api/documents/${DOCUMENT_ID}/ask`]: () => {
        const response = apiError(429, 'RATE_LIMITED', 'slow down', 'retry after 7 seconds');
        response.headers.set('Retry-After', '7');
        return response;
      },
    });
    const error = (await askStream({
      documentId: DOCUMENT_ID,
      question: 'Q',
      visiblePages: [],
      onEvent: () => undefined,
    }).catch((caught: unknown) => caught)) as AskError;
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({
      code: 'RATE_LIMITED',
      status: 429,
      detail: 'retry after 7 seconds',
      retryAfterSeconds: 7,
    });
  });

  it('reads DIARY_BUSY (one answer at a time per session) as an error before any stream', async () => {
    installFetch({
      [`POST /api/documents/${DOCUMENT_ID}/ask`]: () => apiError(429, 'DIARY_BUSY', 'still writing'),
    });
    await expect(
      askStream({ documentId: DOCUMENT_ID, question: 'Q', visiblePages: [], onEvent: () => undefined }),
    ).rejects.toMatchObject({ code: 'DIARY_BUSY' });
  });

  it('maps a network failure to NETWORK', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));
    await expect(
      askStream({ documentId: DOCUMENT_ID, question: 'Q', visiblePages: [], onEvent: () => undefined }),
    ).rejects.toMatchObject({ code: 'NETWORK' });
  });

  it('maps a connection that breaks in the middle of the stream to NETWORK', async () => {
    const stream = openStream();
    installFetch({ [`POST /api/documents/${DOCUMENT_ID}/ask`]: () => stream.response });
    const pending = askStream({
      documentId: DOCUMENT_ID,
      question: 'Q',
      visiblePages: [],
      onEvent: () => undefined,
    });
    stream.push(frame({ type: 'token', text: 'a' }));
    stream.error(new TypeError('network error'));
    await expect(pending).rejects.toMatchObject({ code: 'NETWORK' });
  });

  it('rejects with an AbortError when the caller aborts, and aborts the request', async () => {
    const stream = openStream();
    const { calls } = installFetch({ [`POST /api/documents/${DOCUMENT_ID}/ask`]: () => stream.response });
    const controller = new AbortController();
    const pending = askStream({
      documentId: DOCUMENT_ID,
      question: 'Q',
      visiblePages: [],
      onEvent: () => undefined,
      signal: controller.signal,
    });
    await vi.waitFor(() => {
      expect(calls).toHaveLength(1);
    });
    controller.abort();
    const caught = await pending.catch((error: unknown) => error);
    expect(isAbortError(caught)).toBe(true);
    expect(calls[0]?.signal?.aborted).toBe(true);
  });

  describe('the stall watchdog (I13): 20 s without ANY byte', () => {
    it('is 20 seconds', () => {
      expect(ASK_STALL_MS).toBe(20_000);
    });

    it('fails with NETWORK after 20 s of silence, and is kept alive by heartbeats', async () => {
      vi.useFakeTimers();
      const stream = openStream();
      const { calls } = installFetch({ [`POST /api/documents/${DOCUMENT_ID}/ask`]: () => stream.response });
      const pending = askStream({
        documentId: DOCUMENT_ID,
        question: 'Q',
        visiblePages: [],
        onEvent: () => undefined,
      });
      const outcome = pending.then(
        () => 'resolved',
        (error: unknown) => error,
      );
      await vi.advanceTimersByTimeAsync(15_000);
      stream.push(': hb\n\n'); // a heartbeat at 15 s: the clock starts over
      await vi.advanceTimersByTimeAsync(15_000); // 30 s since the start, 15 s since the heartbeat
      let settled = false;
      void outcome.then(() => {
        settled = true;
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(5_001); // 20 s of silence now
      const result = await outcome;
      expect(result).toMatchObject({ code: 'NETWORK' });
      expect(calls[0]?.signal?.aborted).toBe(true);
    });

    it('counts the wait for the response headers as silence too', async () => {
      vi.useFakeTimers();
      installFetch({
        [`POST /api/documents/${DOCUMENT_ID}/ask`]: () => new Promise<Response>(() => undefined),
      });
      const pending = askStream({
        documentId: DOCUMENT_ID,
        question: 'Q',
        visiblePages: [],
        onEvent: () => undefined,
      });
      const outcome = pending.then(
        () => 'resolved',
        (error: unknown) => error,
      );
      await vi.advanceTimersByTimeAsync(21_000); // no response headers for 21 s: that is silence too
      expect(await outcome).toMatchObject({ code: 'NETWORK' });
    });
  });
});
