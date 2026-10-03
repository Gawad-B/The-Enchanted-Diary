import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createDb, type Db } from '../src/db/client.js';
import { conversationsRepo } from '../src/db/repositories/conversations.js';
import { GeminiBudgets } from '../src/limits/gemini-budget.js';
import { pacificDayStart } from '../src/limits/quota-day.js';
import { AnswerSpend } from '../src/rag/spend.js';
import { FakeEmbeddings } from './doubles/fake-embeddings.js';
import { ScriptedLlm, failing, type ScriptRule } from './doubles/scripted-llm.js';
import { resetCounters, testConfig } from './helpers.js';
import { startServer, type Client, type TestServer } from './http-helpers.js';
import {
  STAND_IN_THRESHOLDS,
  STRICT_THRESHOLDS,
  insertSyntheticDocument,
  readAnswerSse,
} from './rag-helpers.js';

/*
 * What a question costs of the daily Gemini budgets (global §S.7, review NB-17 and NB-18): the budgets are taken once the
 * question is ACCEPTED (the document is the session's, the body is valid, no other answer of the session is in flight) and given
 * back when no model was asked; the small calls around an answer are reserved where they are made. Also the two ways a question
 * can be refused before it costs anything: a client that left during the lookup, and DIARY_BUSY.
 */

let db: Db;
const servers: TestServer[] = [];

beforeAll(async () => {
  db = await createDb(testConfig());
});
afterEach(async () => {
  await Promise.all(servers.splice(0).map((started) => started.close()));
  await resetCounters(db);
});
afterAll(async () => {
  await db.close();
});

interface Setup {
  llm: ScriptedLlm;
  client: Client;
  document: { id: string };
  origin: string;
  server: TestServer;
}

async function setup(
  env: Record<string, string>,
  options: {
    rules?: ScriptRule[];
    slow?: boolean;
    strict?: boolean;
    text?: string;
    wrapDb?: (inner: Db) => Db;
  } = {},
): Promise<Setup> {
  const llm = new ScriptedLlm(
    options.rules ??
      (options.slow === true
        ? [{ when: () => true, reply: 'Alaric founded the house [S1].', delayMs: 120 }]
        : []),
    options.slow === true ? { chunkChars: 6 } : {},
  );
  const started = await startServer(
    options.wrapDb === undefined ? db : options.wrapDb(db),
    testConfig({ RAG_GROUNDING_CHECK: 'false', ...env }),
    {
      embeddings: new FakeEmbeddings(),
      deps: { llm, rag: { evidence: options.strict === true ? STRICT_THRESHOLDS : STAND_IN_THRESHOLDS } },
    },
  );
  servers.push(started);
  await started.app.listen({ host: '127.0.0.1', port: 0 });
  const origin = `http://127.0.0.1:${String((started.app.server.address() as AddressInfo).port)}`;
  const synthetic = await insertSyntheticDocument(db, [
    { page: 1, text: options.text ?? 'Alaric Thornquist founded the house on 14 March 1847.' },
    { page: 2, text: 'The Lost Archive holds the manuscript catalogued as MS-4471.' },
  ]);
  return {
    llm,
    client: started.client().asSession(synthetic.sessionId),
    document: { id: synthetic.documentId },
    origin,
    server: started,
  };
}

const post = (
  origin: string,
  client: Client,
  path: string,
  body: unknown,
  signal?: AbortSignal,
): Promise<Response> =>
  fetch(`${origin}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...client.cookieHeader() },
    body: JSON.stringify(body),
    ...(signal === undefined ? {} : { signal }),
  });

const used = async (kind: 'llm' | 'embed' | 'aux'): Promise<number> => {
  const row = await db.query<{ count: number }>(`SELECT count FROM rate_counters WHERE key = $1`, [
    `gemini:${kind}`,
  ]);
  return row.rows[0]?.count ?? 0;
};

describe('the budgets are taken only for a question that is accepted', () => {
  it('takes nothing for a request whose body is not a question', async () => {
    const { client, document, origin } = await setup({});
    const invalid = await post(origin, client, `/api/documents/${document.id}/ask`, { question: '   ' });
    expect(invalid.status).toBe(400);
    expect(await used('llm')).toBe(0);
    expect(await used('embed')).toBe(0);
  }, 120_000);

  it('takes nothing for a question refused with DIARY_BUSY, and does not count it against QUESTIONS_PER_MINUTE (NB-18)', async () => {
    const { client, document, origin, llm } = await setup({ QUESTIONS_PER_MINUTE: '2' }, { slow: true });
    const path = `/api/documents/${document.id}/ask`;
    const first = await post(origin, client, path, { question: 'Who was Alaric Thornquist?' });
    expect(first.status).toBe(200);
    const reader = first.body?.getReader();
    await reader?.read();
    const callsWhileBusy = llm.calls.length;
    // five more while the first is being written: every one is DIARY_BUSY, none is "too many questions" (the limit is 2 a minute)
    for (let i = 0; i < 5; i += 1) {
      const refused = await post(origin, client, path, { question: 'Who founded Thornquist House?' });
      expect(refused.status).toBe(429);
      expect(((await refused.json()) as { error: { code: string } }).error.code).toBe('DIARY_BUSY');
    }
    expect(llm.calls.length).toBe(callsWhileBusy);
    while (!(await reader?.read())?.done) {
      /* drain */
    }
    // the budget and the minute's allowance are as the one accepted question left them: the visitor may ask a second one now
    const second = await post(origin, client, path, { question: 'Who was Alaric Thornquist?' });
    expect(second.status).toBe(200);
    await readAnswerSse(second);
    expect(await used('llm')).toBe(2);
    const third = await post(origin, client, path, { question: 'Who was Alaric Thornquist?' });
    expect(((await third.json()) as { error: { code: string } }).error.code).toBe('RATE_LIMITED'); // two questions in the minute
  }, 120_000);

  it('counts a double submit once: two simultaneous questions of one session are one question and one DIARY_BUSY (m-5)', async () => {
    const { client, document, origin } = await setup({ QUESTIONS_PER_MINUTE: '2' }, { slow: true });
    const path = `/api/documents/${document.id}/ask`;
    const both = await Promise.all([
      post(origin, client, path, { question: 'Who was Alaric Thornquist?' }),
      post(origin, client, path, { question: 'Who was Alaric Thornquist?' }),
    ]);
    const statuses = both.map((response) => response.status).sort();
    expect(statuses).toEqual([200, 429]);
    const refused = both.find((response) => response.status === 429)!;
    expect(((await refused.json()) as { error: { code: string } }).error.code).toBe('DIARY_BUSY');
    await readAnswerSse(both.find((response) => response.status === 200)!);
    // one question was counted, not two: a second is allowed, a third is "too many questions"
    const second = await post(origin, client, path, { question: 'Who was Alaric Thornquist?' });
    expect(second.status).toBe(200);
    await readAnswerSse(second);
    const third = await post(origin, client, path, { question: 'Who was Alaric Thornquist?' });
    expect(((await third.json()) as { error: { code: string } }).error.code).toBe('RATE_LIMITED');
  }, 120_000);

  it('gives back the answer and what it did not use when the evidence gate stopped the question before any model call', async () => {
    const { client, document, origin, llm } = await setup({ GEMINI_DAILY_BUDGET_LLM: '5' }, { strict: true });
    const stopped = await post(origin, client, `/api/documents/${document.id}/ask`, {
      question: 'What is the capital of Peru?',
    });
    expect(stopped.status).toBe(200);
    const events = (await readAnswerSse(stopped)).events;
    expect(events.find((event) => event.type === 'done')).toMatchObject({
      mode: 'not_found',
      refusedBy: 'evidence',
    });
    expect(llm.calls).toHaveLength(0);
    expect(await used('llm')).toBe(0); // reserved, then given back: no request was made
    expect(await used('embed')).toBe(1); // the question WAS embedded
  }, 120_000);

  it('gives back the embedded text when the question was not searched at all (a question about the whole document)', async () => {
    const { client, document, origin } = await setup({ GEMINI_DAILY_BUDGET_EMBED: '5' });
    const meta = await post(origin, client, `/api/documents/${document.id}/ask`, {
      question: 'Give me a summary',
    });
    await readAnswerSse(meta);
    expect(await used('llm')).toBe(1);
    expect(await used('embed')).toBe(0);
  }, 120_000);

  it('charges the second text a failed rewrite makes (the question and its join), beyond the one it reserved', async () => {
    const { client, document, origin } = await setup(
      { GEMINI_DAILY_BUDGET_EMBED: '10', GEMINI_DAILY_BUDGET_AUX: '10' },
      { rules: [{ when: (call) => call.kind === 'rewrite', reply: failing('LLM_UNAVAILABLE', 'down') }] },
    );
    const path = `/api/documents/${document.id}/ask`;
    await readAnswerSse(await post(origin, client, path, { question: 'Who was Alaric Thornquist?' }));
    expect(await used('embed')).toBe(1);
    await readAnswerSse(await post(origin, client, path, { question: 'Who kept the notebook?' }));
    expect(await used('embed')).toBe(1 + 2); // the first question; the follow-up's own text and the join
    expect(await used('aux')).toBe(1); // the rewrite (the grounding check is off in this setup)
  }, 120_000);
});

describe('the small calls are reserved on their own budget, where they are made', () => {
  it('reserves the grounding check and the rewrite one by one', async () => {
    const { client, document, origin } = await setup(
      { RAG_GROUNDING_CHECK: 'true', GEMINI_DAILY_BUDGET_AUX: '10' },
      { rules: [{ when: (call) => call.kind === 'rewrite', reply: 'Who founded Thornquist House?' }] },
    );
    const path = `/api/documents/${document.id}/ask`;
    await readAnswerSse(await post(origin, client, path, { question: 'Who was Alaric Thornquist?' }));
    expect(await used('aux')).toBe(1); // the grounding check
    await readAnswerSse(await post(origin, client, path, { question: 'Who founded it?' }));
    expect(await used('aux')).toBe(3); // + the rewrite and its grounding check
  }, 120_000);

  it('answers anyway when the auxiliary budget is used up: the call fails, the question is not refused', async () => {
    const { client, document, origin, llm } = await setup(
      { RAG_GROUNDING_CHECK: 'true', GEMINI_DAILY_BUDGET_AUX: '1' },
      {
        rules: [
          { when: (call) => call.kind === 'answer', reply: 'Alaric Thornquist founded the house [S1].' },
        ],
      },
    );
    const path = `/api/documents/${document.id}/ask`;
    const first = await readAnswerSse(
      await post(origin, client, path, { question: 'Who was Alaric Thornquist?' }),
    );
    expect(first.events.find((event) => event.type === 'done')).toMatchObject({ mode: 'answer' });
    const second = await readAnswerSse(
      await post(origin, client, path, { question: 'Who was Alaric Thornquist?' }),
    );
    expect(second.events.find((event) => event.type === 'done')).toMatchObject({
      mode: 'answer',
      grounded: true,
    });
    // the second question's grounding check was refused by the budget (never sent to the model), and says so in the record
    expect(llm.callsOf('grounding')).toHaveLength(1);
    const stored = await conversationsRepo.list(db, (await conversationsRepo.find(db, document.id))!);
    expect(stored.at(-1)?.retrieval).toMatchObject({ grounding: 'skipped', groundingReason: 'error' });
  }, 120_000);
});

describe('a client that left while its question was being looked up costs nothing (M-19, NB-17)', () => {
  /** A database whose lookup of a document takes half a second. */
  const slowLookups = (inner: Db): Db =>
    new Proxy(inner, {
      get(target, property, receiver) {
        if (property !== 'query') return Reflect.get(target, property, receiver) as unknown;
        return async (sql: string, params?: unknown[]) => {
          if (/FROM\s+documents/iu.test(sql)) await new Promise((resolve) => setTimeout(resolve, 500));
          return target.query(sql, params);
        };
      },
    });

  it('asks the model nothing and stores nothing when the connection closes during the document lookup', async () => {
    const { client, document, origin, llm } = await setup(
      { GEMINI_DAILY_BUDGET_LLM: '5' },
      { wrapDb: slowLookups },
    );
    const controller = new AbortController();
    const pending = post(
      origin,
      client,
      `/api/documents/${document.id}/ask`,
      { question: 'Who was Alaric Thornquist?' },
      controller.signal,
    ).catch((error: unknown) => error);
    await new Promise((resolve) => setTimeout(resolve, 150));
    controller.abort();
    await pending;
    await new Promise((resolve) => setTimeout(resolve, 1200)); // long enough for the lookup to end and a handler without the early watch to go on
    expect(llm.calls).toHaveLength(0);
    expect(await conversationsRepo.find(db, document.id)).toBeNull();
    expect(await used('llm')).toBe(0);
  }, 120_000);
});

describe('the session keeps its place until its pipeline has ended, whether or not the visitor is still there (budgets review N-2)', () => {
  it('refuses a second question while the first is still unwinding after its visitor left, and takes one once it has ended', async () => {
    let letGo!: () => void;
    const held = new Promise<void>((resolve) => {
      letGo = resolve;
    });
    const { client, document, origin, llm } = await setup(
      { QUESTIONS_PER_MINUTE: '20' },
      {
        // a model call that does not notice the visitor has gone (a request already out): it ends when it is let go
        rules: [
          {
            when: (call) => call.kind === 'answer',
            reply: () =>
              (async function* () {
                await held;
                yield 'Alaric Thornquist founded the house [S1].';
              })(),
          },
        ],
      },
    );
    const path = `/api/documents/${document.id}/ask`;
    const controller = new AbortController();
    const first = post(
      origin,
      client,
      path,
      { question: 'Who was Alaric Thornquist?' },
      controller.signal,
    ).catch((error: unknown) => error);
    await vi.waitFor(() => expect(llm.calls.length).toBeGreaterThan(0), { timeout: 20_000, interval: 25 });
    controller.abort();
    await first;
    await new Promise((resolve) => setTimeout(resolve, 150)); // the server has seen the connection close
    const busy = await post(origin, client, path, { question: 'Who was Alaric Thornquist?' });
    expect(busy.status).toBe(429);
    expect(((await busy.json()) as { error: { code: string } }).error.code).toBe('DIARY_BUSY');
    letGo();
    // the first pipeline ends (its model call stops at the abort); only then is the place free
    await vi.waitFor(
      async () => {
        const again = await post(origin, client, path, { question: 'Who was Alaric Thornquist?' });
        expect(again.status).toBe(200);
        await readAnswerSse(again);
      },
      { timeout: 20_000, interval: 50 },
    );
  }, 120_000);
});

describe('what a question gives back goes to the Pacific day it was taken in, on the real budgets (budgets review N-1)', () => {
  it('leaves the other visitor’s unit of the new day alone when a question reserved before midnight is settled after it', async () => {
    let now = new Date('2026-10-03T06:59:59Z'); // 23:59:59 Pacific
    const budgets = new GeminiBudgets(db, { llm: 5, embed: 5, ocr: 0, aux: 5 }, () => now);
    const oldDay = pacificDayStart(now);
    const first = new AnswerSpend(budgets, 'ask');
    await first.reserve();
    now = new Date('2026-10-03T07:00:05Z'); // 00:00:05 Pacific: a new quota day
    const newDay = pacificDayStart(now);
    expect(newDay.getTime()).toBeGreaterThan(oldDay.getTime());
    const second = new AnswerSpend(budgets, 'ask');
    await second.reserve();
    // the first question is stopped by the evidence gate: its question was embedded, no model was asked
    await first
      .wrap({
        embeddings: { model: 'x', embedQuery: () => Promise.resolve([1]) },
        llm: new ScriptedLlm(),
      } as never)
      .embeddings.embedQuery('q');
    await first.settle();
    expect(await budgets.used('llm', oldDay)).toBe(0); // given back where it was taken
    expect(await budgets.used('llm', newDay)).toBe(1); // the second question's unit is untouched
    expect(await budgets.used('embed', oldDay)).toBe(1); // spent
    expect(await budgets.used('embed', newDay)).toBe(1);
  }, 120_000);
});
