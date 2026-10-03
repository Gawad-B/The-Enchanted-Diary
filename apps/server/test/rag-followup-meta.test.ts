import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createDb, type Db } from '../src/db/client.js';
import { runMigrations } from '../src/db/migrate.js';
import { conversationsRepo } from '../src/db/repositories/conversations.js';
import { runAsk } from '../src/rag/answer.js';
import { ScriptedLlm } from './doubles/scripted-llm.js';
import { testConfig } from './helpers.js';
import { STAND_IN_THRESHOLDS, collector, insertSyntheticDocument, ragDeps } from './rag-helpers.js';

/*
 * A follow-up whose only topic is a pronoun is a follow-up (fix round 4, review N3-3): it is rewritten from the earlier question,
 * not read as a request for the overview of the whole document, whose rewrite the pipeline skips. Without an earlier question the
 * same words are the overview. Real PGlite, the stand-in embedding model, the scripted answer model.
 */

let db: Db;
let documentId: string;
let doc: { id: string; filename: string; pageCount: number; primaryLanguage: string };

beforeAll(async () => {
  db = await createDb(testConfig());
  await runMigrations(db);
  const synthetic = await insertSyntheticDocument(db, [
    { page: 1, text: 'Alaric Thornquist founded the house on 14 March 1847.' },
    { page: 2, text: 'The Lost Archive holds the manuscript catalogued as MS-4471.' },
  ]);
  documentId = synthetic.documentId;
  doc = { id: documentId, filename: 'synthetic.pdf', pageCount: 2, primaryLanguage: 'en' };
});
afterAll(async () => {
  await db.close();
});
beforeEach(async () => {
  await conversationsRepo.clear(db, documentId);
});

async function ask(llm: ScriptedLlm, question: string): Promise<void> {
  const { emit } = collector();
  await runAsk(
    ragDeps(db, llm, testConfig({ RAG_GROUNDING_CHECK: 'false' }), { evidence: STAND_IN_THRESHOLDS }),
    { document: doc, question, signal: new AbortController().signal },
    emit,
  );
}

describe('a pronoun is the topic of a follow-up, and of nothing else (review N3-3)', () => {
  it('rewrites "What does the document say about it?" after an earlier question, and reads no overview', async () => {
    const llm = new ScriptedLlm([
      {
        when: (call) => call.kind === 'rewrite',
        reply: 'What does the document say about Alaric Thornquist?',
      },
    ]);
    await ask(llm, 'Who was Alaric Thornquist?');
    expect(llm.callsOf('rewrite')).toHaveLength(0); // the first question has nothing to resolve
    await ask(llm, 'What does the document say about him?');
    expect(llm.callsOf('rewrite')).toHaveLength(1);
    const last = (await conversationsRepo.list(db, (await conversationsRepo.find(db, documentId))!)).at(-1);
    expect(last?.retrieval?.rewrittenQuery).toBe('What does the document say about Alaric Thornquist?');
    expect(last?.retrieval?.meta).not.toBe(true);
  }, 120_000);

  it('reads the overview, with no rewrite, when the same words are the first question', async () => {
    const llm = new ScriptedLlm();
    await ask(llm, 'What does the document say about it?');
    expect(llm.callsOf('rewrite')).toHaveLength(0);
    const last = (await conversationsRepo.list(db, (await conversationsRepo.find(db, documentId))!)).at(-1);
    expect(last?.retrieval?.meta).toBe(true);
  }, 120_000);

  it('still reads the overview for a request that names the document, after an earlier question', async () => {
    const llm = new ScriptedLlm();
    await ask(llm, 'Who was Alaric Thornquist?');
    await ask(llm, 'What does this document say?');
    expect(llm.callsOf('rewrite')).toHaveLength(0);
    const last = (await conversationsRepo.list(db, (await conversationsRepo.find(db, documentId))!)).at(-1);
    expect(last?.retrieval?.meta).toBe(true);
  }, 120_000);
});
