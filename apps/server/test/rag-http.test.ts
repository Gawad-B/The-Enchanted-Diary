import type { AddressInfo } from 'node:net';
import {
  ApiErrorSchema,
  ConversationSchema,
  HealthSchema,
  PublicConfigSchema,
  type DocumentDetail,
} from '@enchanted/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, type Db } from '../src/db/client.js';
import { documentsRepo } from '../src/db/repositories/documents.js';
import { FakeEmbeddings } from './doubles/fake-embeddings.js';
import { ScriptedLlm, untilAborted } from './doubles/scripted-llm.js';
import { insertSession, testConfig } from './helpers.js';
import { startServer, waitUntil, type Client, type TestServer } from './http-helpers.js';
import { STAND_IN_THRESHOLDS, eventOf, ingestFixture, readAnswerSse } from './rag-helpers.js';

// The three routes (ask, reveal, conversation) through the real Fastify app: sessions, ownership, readiness, body
// validation, rate limits, DIARY_BUSY, the event stream over a real socket (heartbeats, abort), health and config.

// The grounding check has its own tests (rag-ask.test.ts); here the answer model is the only call a question makes.
const serverConfig = (env: Record<string, string> = {}) =>
  testConfig({ RAG_GROUNDING_CHECK: 'false', ...env });

let db: Db;
const embeddings = new FakeEmbeddings();
const llm = new ScriptedLlm();
let server: TestServer;
let origin: string;
let owner: Client;
let document: DocumentDetail;

beforeAll(async () => {
  db = await createDb(testConfig());
  server = await startServer(db, serverConfig(), {
    embeddings,
    deps: { llm, rag: { evidence: STAND_IN_THRESHOLDS }, answerHeartbeatMs: 40 },
  });
  await server.app.listen({ host: '127.0.0.1', port: 0 });
  origin = `http://127.0.0.1:${String((server.app.server.address() as AddressInfo).port)}`;
  ({ client: owner, document } = await ingestFixture(server, 'text-en.pdf'));
}, 120_000);
afterAll(async () => {
  await server.close();
  await db.close();
});

const post = (client: Client, path: string, body: unknown, signal?: AbortSignal): Promise<Response> =>
  fetch(`${origin}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...client.cookieHeader() },
    body: JSON.stringify(body),
    ...(signal === undefined ? {} : { signal }),
  });

const ask = (client: Client, question: string, extra: object = {}, signal?: AbortSignal): Promise<Response> =>
  post(client, `/api/documents/${document.id}/ask`, { question, ...extra }, signal);

describe('POST /api/documents/:id/ask', () => {
  it('streams the answer as Server-Sent Events: no-store, event-stream, every frame a valid AnswerStreamEvent', async () => {
    const response = await ask(owner, 'Who was Alaric Thornquist?');
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    expect(response.headers.get('cache-control')).toBe('no-store, no-transform');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    const { events, ended } = await readAnswerSse(response);
    expect(ended).toBe(true);
    expect(events.map((event) => event.type)).toEqual(
      expect.arrayContaining(['status', 'retrieval', 'token', 'citations', 'done']),
    );
    expect(eventOf(events, 'done')).toMatchObject({ mode: 'answer', grounded: true });
  });

  it('sends a `: hb` comment every few seconds while the model is slow (here: every 40 ms)', async () => {
    const slow = new ScriptedLlm(
      [{ when: () => true, reply: 'Alaric founded the house [S1].', delayMs: 120 }],
      { chunkChars: 10 },
    );
    const slowServer = await startServer(db, serverConfig(), {
      embeddings,
      deps: { llm: slow, rag: { evidence: STAND_IN_THRESHOLDS }, answerHeartbeatMs: 40 },
    });
    try {
      await slowServer.app.listen({ host: '127.0.0.1', port: 0 });
      const slowOrigin = `http://127.0.0.1:${String((slowServer.app.server.address() as AddressInfo).port)}`;
      const { client, document: doc } = await ingestFixture(slowServer, 'text-en.pdf');
      const response = await fetch(`${slowOrigin}/api/documents/${doc.id}/ask`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...client.cookieHeader() },
        body: JSON.stringify({ question: 'Who was Alaric Thornquist?' }),
      });
      const { events, comments } = await readAnswerSse(response);
      expect(comments.length).toBeGreaterThanOrEqual(3);
      expect(new Set(comments)).toEqual(new Set(['hb']));
      expect(eventOf(events, 'done').mode).toBe('answer');
    } finally {
      await slowServer.close();
    }
  }, 120_000);

  it('uses the pages the reader sees from the request body', async () => {
    const { events } = await readAnswerSse(
      await ask(owner, 'What is this page about?', { context: { visiblePages: [5] } }),
    );
    expect(eventOf(events, 'retrieval').evidence).toBe('strong');
    expect(llm.callsOf('answer').at(-1)?.lastUser).toMatch(/<excerpt id="S1" page="5"/u);
  });

  it('answers 404 to another session, 404 to a malformed id, 409 to a document that is still being read', async () => {
    const stranger = server.client();
    const refused = await ask(stranger, 'Who was Alaric Thornquist?');
    expect(refused.status).toBe(404);
    expect(ApiErrorSchema.parse(await refused.json()).error.code).toBe('DOCUMENT_NOT_FOUND');
    const malformed = await post(owner, '/api/documents/not-a-uuid/ask', { question: 'x' });
    expect(malformed.status).toBe(404);

    const sessionId = server.app.unsignCookie(owner.cookie ?? '').value!;
    const processing = await documentsRepo.insert(db, {
      id: crypto.randomUUID(),
      sessionId,
      filename: 'wip.pdf',
      byteSize: 1,
      sha256: 'x'.repeat(64),
      pageCount: 1,
      storageKey: 'wip.pdf',
      expiresAt: new Date(Date.now() + 3_600_000),
    });
    for (const path of ['ask', 'reveal']) {
      const response = await post(
        owner,
        `/api/documents/${processing.id}/${path}`,
        path === 'ask' ? { question: 'x' } : { focus: 'manuscript' },
      );
      expect(response.status).toBe(409);
      expect(ApiErrorSchema.parse(await response.json()).error.code).toBe('DOCUMENT_NOT_READY');
    }
    await documentsRepo.remove(db, processing.id);
  });

  it('rejects an invalid body with 400 QUESTION_INVALID before any stream starts', async () => {
    const bodies: unknown[] = [
      {},
      { question: '' },
      { question: '   ' },
      { question: 'x'.repeat(2001) },
      { question: 'ok', context: { visiblePages: [1, 2, 3, 4, 5] } },
      { question: 'ok', context: { visiblePages: [0] } },
      { question: 42 },
    ];
    for (const body of bodies) {
      const response = await post(owner, `/api/documents/${document.id}/ask`, body);
      expect(response.status, JSON.stringify(body).slice(0, 60)).toBe(400);
      expect(response.headers.get('content-type')).toContain('application/json');
      expect(ApiErrorSchema.parse(await response.json()).error.code).toBe('QUESTION_INVALID');
    }
    // 2000 characters is allowed
    const exact = await ask(owner, 'x'.repeat(2000));
    expect(exact.status).toBe(200);
    await exact.body?.cancel();
  });

  it('stops the model when the connection closes', async () => {
    // (a first word that cannot begin the mandated refusal: "The " is held back until the next word tells, and this double
    // stops after its first word)
    const hanging = new ScriptedLlm([
      { when: () => true, reply: (_call, signal) => untilAborted(signal, 'Alaric ') },
    ]);
    const hangingServer = await startServer(db, serverConfig(), {
      embeddings,
      deps: { llm: hanging, rag: { evidence: STAND_IN_THRESHOLDS } },
    });
    try {
      await hangingServer.app.listen({ host: '127.0.0.1', port: 0 });
      const hangingOrigin = `http://127.0.0.1:${String((hangingServer.app.server.address() as AddressInfo).port)}`;
      const { client, document: doc } = await ingestFixture(hangingServer, 'text-en.pdf');
      const controller = new AbortController();
      const response = await fetch(`${hangingOrigin}/api/documents/${doc.id}/ask`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...client.cookieHeader() },
        body: JSON.stringify({ question: 'Who was Alaric Thornquist?' }),
        signal: controller.signal,
      });
      const reader = response.body?.getReader();
      // wait for the first token: the model is generating
      let text = '';
      while (!text.includes('"type":"token"')) {
        const chunk = await reader?.read();
        if (chunk === undefined || chunk.done) break;
        text += new TextDecoder().decode(chunk.value as Uint8Array);
      }
      expect(text).toContain('"type":"token"');
      expect(hanging.calls[0]?.aborted).toBe(false);
      controller.abort();
      await waitUntil(() => hanging.calls[0]?.aborted === true, 'the provider stream to be aborted', 10_000);
      expect(hanging.calls[0]?.completed).toBe(false);
    } finally {
      await hangingServer.close();
    }
  }, 120_000);
});

describe('limits', () => {
  it('limits questions per session per minute, one budget for ask and reveal', async () => {
    const limited = await startServer(db, serverConfig({ QUESTIONS_PER_MINUTE: '2' }), {
      embeddings,
      deps: { llm: new ScriptedLlm(), rag: { evidence: STAND_IN_THRESHOLDS } },
    });
    try {
      await limited.app.listen({ host: '127.0.0.1', port: 0 });
      const limitedOrigin = `http://127.0.0.1:${String((limited.app.server.address() as AddressInfo).port)}`;
      const { client, document: doc } = await ingestFixture(limited, 'text-en.pdf');
      const send = (path: string, body: object, who: Client = client): Promise<Response> =>
        fetch(`${limitedOrigin}/api/documents/${doc.id}/${path}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...who.cookieHeader() },
          body: JSON.stringify(body),
        });
      const statuses: number[] = [];
      for (const [path, body] of [
        ['ask', { question: 'Who was Alaric Thornquist?' }],
        ['reveal', { focus: 'manuscript' }],
        ['ask', { question: 'Who was Alaric Thornquist?' }],
      ] as const) {
        const response = await send(path, body);
        statuses.push(response.status);
        if (response.status === 200) await readAnswerSse(response);
        else {
          expect(ApiErrorSchema.parse(await response.json()).error.code).toBe('RATE_LIMITED');
          expect(response.headers.get('retry-after')).not.toBeNull();
        }
      }
      expect(statuses).toEqual([200, 200, 429]);
    } finally {
      await limited.close();
    }
  }, 120_000);

  it('refuses with 429 DIARY_BUSY a second question or reveal of a session that has an answer in flight, before opening a stream', async () => {
    const slow = new ScriptedLlm(
      [{ when: () => true, reply: 'Alaric founded the house [S1].', delayMs: 150 }],
      {
        chunkChars: 6,
      },
    );
    const busyServer = await startServer(db, serverConfig(), {
      embeddings,
      deps: { llm: slow, rag: { evidence: STAND_IN_THRESHOLDS } },
    });
    try {
      await busyServer.app.listen({ host: '127.0.0.1', port: 0 });
      const busyOrigin = `http://127.0.0.1:${String((busyServer.app.server.address() as AddressInfo).port)}`;
      const { client, document: doc } = await ingestFixture(busyServer, 'text-en.pdf');
      const other = await ingestFixture(busyServer, 'text-en.pdf'); // another session
      const send = (who: Client, id: string, path: 'ask' | 'reveal', payload: object) =>
        fetch(`${busyOrigin}/api/documents/${id}/${path}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...who.cookieHeader() },
          body: JSON.stringify(payload),
        });
      // the first question starts and is still being written
      const first = await send(client, doc.id, 'ask', { question: 'Who was Alaric Thornquist?' });
      expect(first.status).toBe(200);
      const reader = first.body?.getReader();
      await reader?.read();
      const callsWhileBusy = slow.calls.length;
      for (const [path, payload] of [
        ['ask', { question: 'Who founded Thornquist House?' }],
        ['reveal', { focus: 'manuscript' }],
      ] as const) {
        const refused = await send(client, doc.id, path, payload);
        expect(refused.status, path).toBe(429);
        expect(ApiErrorSchema.parse(await refused.json()).error.code, path).toBe('DIARY_BUSY');
      }
      expect(slow.calls.length).toBe(callsWhileBusy); // the refused ones spent nothing
      // another session is not in the way
      const unaffected = await send(other.client, other.document.id, 'ask', {
        question: 'Who was Alaric Thornquist?',
      });
      expect(unaffected.status).toBe(200);
      await readAnswerSse(unaffected);
      // finish the first one: the session may ask again
      while (!(await reader?.read())?.done) {
        /* drain */
      }
      const again = await send(client, doc.id, 'ask', { question: 'Who was Alaric Thornquist?' });
      expect(again.status).toBe(200);
      await readAnswerSse(again);
    } finally {
      await busyServer.close();
    }
  }, 120_000);

  it('lets the session ask again at once when the visitor goes away mid-answer', async () => {
    const slow = new ScriptedLlm([{ when: () => true, reply: (_call, signal) => untilAborted(signal) }]);
    const awayServer = await startServer(db, serverConfig(), {
      embeddings,
      deps: { llm: slow, rag: { evidence: STAND_IN_THRESHOLDS } },
    });
    try {
      await awayServer.app.listen({ host: '127.0.0.1', port: 0 });
      const awayOrigin = `http://127.0.0.1:${String((awayServer.app.server.address() as AddressInfo).port)}`;
      const { client, document: doc } = await ingestFixture(awayServer, 'text-en.pdf');
      const controller = new AbortController();
      const first = await fetch(`${awayOrigin}/api/documents/${doc.id}/ask`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...client.cookieHeader() },
        body: JSON.stringify({ question: 'Who was Alaric Thornquist?' }),
        signal: controller.signal,
      });
      await first.body?.getReader().read();
      controller.abort();
      await waitUntil(() => slow.calls[0]?.aborted === true, 'the provider stream to be aborted', 10_000);
      const second = await fetch(`${awayOrigin}/api/documents/${doc.id}/ask`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...client.cookieHeader() },
        body: JSON.stringify({ question: 'What is MS-4471?' }),
        signal: AbortSignal.timeout(5000),
      });
      expect(second.status).toBe(200); // not DIARY_BUSY: the first answer ended with the connection
      await second.body?.cancel();
    } finally {
      await awayServer.close();
    }
  }, 120_000);
});

describe('POST /api/documents/:id/reveal', () => {
  it('streams the outline first, then the memory; rejects an unknown focus', async () => {
    const response = await post(owner, `/api/documents/${document.id}/reveal`, { focus: 'manuscript' });
    expect(response.status).toBe(200);
    const { events } = await readAnswerSse(response);
    expect(events[0]).toMatchObject({ type: 'outline', pageCount: 5 });
    expect(eventOf(events, 'done').mode).toBe('answer');
    const invalid = await post(owner, `/api/documents/${document.id}/reveal`, { focus: 'everything' });
    expect(invalid.status).toBe(400);
    expect(ApiErrorSchema.parse(await invalid.json()).error.code).toBe('QUESTION_INVALID');
    const stranger = await post(server.client(), `/api/documents/${document.id}/reveal`, {
      focus: 'manuscript',
    });
    expect(stranger.status).toBe(404);
  });
});

describe('the conversation', () => {
  it('lists the questions, the answers and the reveals; clearing it leaves the document', async () => {
    const { client, document: doc } = await ingestFixture(server, 'text-en.pdf');
    const empty = await client.get(`/api/documents/${doc.id}/conversation`);
    expect(empty.statusCode).toBe(200);
    expect(ConversationSchema.parse(empty.json())).toEqual({ documentId: doc.id, messages: [] });

    await readAnswerSse(
      await post(client, `/api/documents/${doc.id}/ask`, { question: 'Who was Alaric Thornquist?' }),
    );
    await readAnswerSse(await post(client, `/api/documents/${doc.id}/reveal`, { focus: 'manuscript' }));
    await readAnswerSse(
      await post(client, `/api/documents/${doc.id}/ask`, { question: 'What is the capital of Peru?' }),
    );
    const listed = await client.get(`/api/documents/${doc.id}/conversation`);
    expect(listed.headers['cache-control']).toBe('no-store');
    const conversation = ConversationSchema.parse(listed.json());
    expect(conversation.documentId).toBe(doc.id);
    expect(conversation.messages.map((message) => [message.role, message.kind, message.mode])).toEqual([
      ['user', 'question', undefined],
      ['assistant', 'answer', 'answer'],
      ['assistant', 'reveal', 'answer'],
      ['user', 'question', undefined],
      ['assistant', 'answer', 'answer'],
    ]);
    expect(conversation.messages[0]?.content).toBe('Who was Alaric Thornquist?');
    expect(conversation.messages[1]?.citations.length).toBeGreaterThan(0);
    expect(conversation.messages[1]?.grounded).toBe(true);
    const times = conversation.messages.map((message) => Date.parse(message.createdAt));
    expect(times).toEqual([...times].sort((a, b) => a - b));

    const cleared = await client.delete(`/api/documents/${doc.id}/conversation`);
    expect(cleared.statusCode).toBe(204);
    expect(cleared.body).toBe('');
    expect(
      ConversationSchema.parse((await client.get(`/api/documents/${doc.id}/conversation`)).json()).messages,
    ).toEqual([]);
    expect((await client.get(`/api/documents/${doc.id}`)).statusCode).toBe(200);
    // and a new question starts a new conversation without any history
    const calls = llm.calls.length;
    await readAnswerSse(await post(client, `/api/documents/${doc.id}/ask`, { question: 'What is MS-4471?' }));
    expect(llm.calls.slice(calls).map((call) => call.kind)).toEqual(['answer']);
  });

  it('is not visible to, and cannot be cleared by, another session', async () => {
    const stranger = server.client();
    expect((await stranger.get(`/api/documents/${document.id}/conversation`)).statusCode).toBe(404);
    expect((await stranger.delete(`/api/documents/${document.id}/conversation`)).statusCode).toBe(404);
    expect((await owner.get('/api/documents/not-a-uuid/conversation')).statusCode).toBe(404);
  });
});

describe('health and configuration', () => {
  it('report the language model that is really wired in', async () => {
    const health = HealthSchema.parse((await server.app.inject('/api/health')).json());
    expect(health.providers.llm).toBe('scripted:scripted-1');
    const config = PublicConfigSchema.parse((await server.app.inject('/api/config')).json());
    expect(config.llm).toEqual({
      provider: 'scripted',
      model: 'scripted-1',
      available: true,
      profile: 'standard',
      // the stand-ins (the scripted model and the fake embeddings) send nothing to Gemini: no notice
      freeTierNotice: false,
    });
    expect(config.embeddings).toMatchObject({ provider: 'fake', available: true });

    const none = await startServer(db, serverConfig({ LLM_PROVIDER: 'none' }));
    try {
      expect(HealthSchema.parse((await none.app.inject('/api/health')).json()).providers.llm).toBe('none');
      expect(PublicConfigSchema.parse((await none.app.inject('/api/config')).json()).llm).toMatchObject({
        provider: 'none',
        available: false,
      });
    } finally {
      await none.close();
    }
    const unconfigured = await startServer(db, serverConfig());
    try {
      expect(HealthSchema.parse((await unconfigured.app.inject('/api/health')).json()).providers.llm).toBe(
        'unconfigured',
      );
      expect(
        PublicConfigSchema.parse((await unconfigured.app.inject('/api/config')).json()).llm.available,
      ).toBe(false);
    } finally {
      await unconfigured.close();
    }
  });

  it('tells the UI about the free-tier data terms only while something is sent to a free-tier Gemini key', async () => {
    const notice = async (env: Record<string, string>): Promise<boolean | undefined> => {
      const configured = await startServer(db, serverConfig(env));
      try {
        return PublicConfigSchema.parse((await configured.app.inject('/api/config')).json()).llm
          .freeTierNotice;
      } finally {
        await configured.close();
      }
    };
    expect(await notice({ GEMINI_API_KEY: 'k' })).toBe(true);
    expect(await notice({ GEMINI_API_KEY: 'k', GEMINI_FREE_TIER: 'false' })).toBe(false);
    // nothing goes to Gemini: no notice
    expect(
      await notice({
        LLM_PROVIDER: 'none',
        EMBEDDING_PROVIDER: 'openai',
        EMBEDDING_MODEL: 'text-embedding-3-small',
        OCR_PROVIDER: 'none',
      }),
    ).toBe(false);
  });

  it('never exposes a session for these probes', async () => {
    const sessionsBefore = (await db.query('SELECT 1 FROM sessions')).rowCount;
    await server.app.inject('/api/health');
    expect((await db.query('SELECT 1 FROM sessions')).rowCount).toBe(sessionsBefore);
    expect(await insertSession(db)).toMatch(/^[0-9a-f-]{36}$/u);
  });
});
