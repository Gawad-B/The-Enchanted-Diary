import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createDb, type Db } from '../src/db/client.js';
import { FakeEmbeddings } from './doubles/fake-embeddings.js';
import { ScriptedLlm } from './doubles/scripted-llm.js';
import { resetCounters, testConfig } from './helpers.js';
import { startServer, type Client, type TestServer } from './http-helpers.js';
import { insertSyntheticDocument, readAnswerSse } from './rag-helpers.js';

/*
 * The app-wide daily budgets of the Gemini quotas in front of the routes that use them: an answer is one request of the answer
 * model and one embedded text, a reveal one request of the answer model. A refused question never reaches the model.
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

async function setup(
  env: Record<string, string>,
): Promise<{ llm: ScriptedLlm; client: Client; document: { id: string }; origin: string }> {
  const llm = new ScriptedLlm();
  const started = await startServer(db, testConfig({ RAG_GROUNDING_CHECK: 'false', ...env }), {
    embeddings: new FakeEmbeddings(),
    deps: { llm },
  });
  servers.push(started);
  await started.app.listen({ host: '127.0.0.1', port: 0 });
  const origin = `http://127.0.0.1:${String((started.app.server.address() as AddressInfo).port)}`;
  // A ready document written straight into the database: these tests are about the budgets, not about reading a PDF.
  const synthetic = await insertSyntheticDocument(db, [
    { page: 1, text: 'Alaric Thornquist founded the house on 14 March 1847.' },
    { page: 2, text: 'The Lost Archive holds the manuscript catalogued as MS-4471.' },
  ]);
  return {
    llm,
    client: started.client().asSession(synthetic.sessionId),
    document: { id: synthetic.documentId },
    origin,
  };
}

const post = (origin: string, client: Client, path: string, body: unknown): Promise<Response> =>
  fetch(`${origin}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...client.cookieHeader() },
    body: JSON.stringify(body),
  });

describe('the daily budget of answers', () => {
  it('lets the day’s budget of questions through, then refuses with RATE_LIMITED "daily quota reached" before the model is asked', async () => {
    const { llm, client, document, origin } = await setup({ GEMINI_DAILY_BUDGET_LLM: '2' });
    const ask = (): Promise<Response> =>
      post(origin, client, `/api/documents/${document.id}/ask`, { question: 'Who was Alaric Thornquist?' });
    for (let i = 0; i < 2; i += 1) {
      const response = await ask();
      expect(response.status).toBe(200);
      expect((await readAnswerSse(response)).ended).toBe(true);
    }
    const asked = llm.calls.length;
    const refused = await ask();
    expect(refused.status).toBe(429);
    expect(refused.headers.get('content-type')).toContain('application/json');
    const body = (await refused.json()) as { error: { code: string; detail?: string } };
    expect(body.error).toMatchObject({ code: 'RATE_LIMITED', detail: 'daily quota reached' });
    expect(llm.calls.length).toBe(asked); // nothing was sent to the model
  }, 120_000);

  it('counts a reveal against the same budget', async () => {
    const { client, document, origin } = await setup({ GEMINI_DAILY_BUDGET_LLM: '1' });
    const reveal = await post(origin, client, `/api/documents/${document.id}/reveal`, {
      focus: 'manuscript',
    });
    expect(reveal.status).toBe(200);
    await readAnswerSse(reveal);
    const refused = await post(origin, client, `/api/documents/${document.id}/ask`, {
      question: 'Who was Alaric?',
    });
    expect(refused.status).toBe(429);
    expect(((await refused.json()) as { error: { detail?: string } }).error.detail).toBe(
      'daily quota reached',
    );
  }, 120_000);

  it('counts the embedded question too, and gives back what it took of the answers when that is what is used up', async () => {
    const { client, document, origin } = await setup({
      GEMINI_DAILY_BUDGET_LLM: '5',
      GEMINI_DAILY_BUDGET_EMBED: '1',
    });
    const ask = (): Promise<Response> =>
      post(origin, client, `/api/documents/${document.id}/ask`, { question: 'Who was Alaric Thornquist?' });
    const first = await ask();
    expect(first.status).toBe(200);
    await readAnswerSse(first);
    for (let i = 0; i < 3; i += 1) expect((await ask()).status).toBe(429); // the embedding budget is gone
    // The three refusals took nothing of the 5 answers: one was used, four are left.
    const used = await db.query<{ count: number }>(
      `SELECT count FROM rate_counters WHERE key = 'gemini:llm'`,
    );
    expect(used.rows).toEqual([{ count: 1 }]);
  }, 120_000);

  it('does not budget a provider that is not Gemini', async () => {
    const { client, document, origin } = await setup({
      GEMINI_DAILY_BUDGET_LLM: '1',
      GEMINI_DAILY_BUDGET_EMBED: '1',
      LLM_PROVIDER: 'anthropic',
      EMBEDDING_PROVIDER: 'openai',
      EMBEDDING_MODEL: 'text-embedding-3-small',
    });
    for (let i = 0; i < 3; i += 1) {
      const response = await post(origin, client, `/api/documents/${document.id}/ask`, {
        question: 'Who was Alaric Thornquist?',
      });
      expect(response.status).toBe(200);
      await readAnswerSse(response);
    }
  }, 120_000);

  it('is not spent on a question about a document that is not the session’s', async () => {
    const { client, document, origin } = await setup({ GEMINI_DAILY_BUDGET_LLM: '1' });
    const stranger = servers[0]!.client();
    const refused = await post(origin, stranger, `/api/documents/${document.id}/ask`, { question: 'Who?' });
    expect(refused.status).toBe(404);
    expect(((await refused.json()) as { error: { code: string } }).error.code).toBe('DOCUMENT_NOT_FOUND');
    expect((await db.query(`SELECT 1 FROM rate_counters WHERE key = 'gemini:llm'`)).rowCount).toBe(0);
    // The owner's single answer is still there.
    const real = await post(origin, client, `/api/documents/${document.id}/ask`, {
      question: 'Who was Alaric?',
    });
    expect(real.status).toBe(200);
    await readAnswerSse(real);
  }, 120_000);
});
