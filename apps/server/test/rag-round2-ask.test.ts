import type { AnswerStreamEvent, DocumentDetail } from '@enchanted/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Config } from '../src/config.js';
import { createDb, type Db } from '../src/db/client.js';
import { conversationsRepo } from '../src/db/repositories/conversations.js';
import { runAsk, type AskInput, type RagDeps } from '../src/rag/answer.js';
import { NOT_IN_DOCUMENT } from '../src/rag/constants.js';
import { NOT_FOUND_MESSAGES } from '../src/rag/messages.js';
import { FakeEmbeddings } from './doubles/fake-embeddings.js';
import { ScriptedLlm, failing, type ScriptRule } from './doubles/scripted-llm.js';
import { testConfig } from './helpers.js';
import { startServer, type TestServer } from './http-helpers.js';
import {
  STAND_IN_THRESHOLDS,
  STRICT_THRESHOLDS,
  collector,
  eventOf,
  ingestFixture,
  insertSyntheticDocument,
  ragDeps,
} from './rag-helpers.js';

/*
 * Fix round 2, the pipeline's own behaviour (review NB-1, NB-2, NB-3, NB-9, NB-14, NB-16): what guard 1 reads after a failed rewrite,
 * a request that names a page and adds only a task, a summary of a topic, the language of a question nothing tells, and an
 * auxiliary reply the output limit cut off. Real PGlite + pgvector, real ingested fixtures, the stand-in embedding model.
 */

const config = (env: Record<string, string> = {}): Config =>
  testConfig({ RAG_GROUNDING_CHECK: 'false', ...env });
const GROUNDING_ON = (): Config => testConfig();

let db: Db;
let server: TestServer;
const embeddings = new FakeEmbeddings();
interface Doc {
  id: string;
  filename: string;
  pageCount: number;
  primaryLanguage: string;
}
let english: Doc;
const asDoc = (document: DocumentDetail): Doc => ({
  id: document.id,
  filename: document.filename,
  pageCount: document.pageCount,
  primaryLanguage: document.primaryLanguage,
});

beforeAll(async () => {
  db = await createDb(testConfig());
  server = await startServer(db, testConfig(), { embeddings });
  english = asDoc((await ingestFixture(server, 'text-en.pdf')).document);
}, 240_000);
afterAll(async () => {
  await server.close();
  await db.close();
});
beforeEach(async () => {
  await conversationsRepo.clear(db, english.id);
});

interface Asked {
  events: AnswerStreamEvent[];
  llm: ScriptedLlm;
  queries: string[];
}

/** One question; the embedding model is wrapped to say which texts were embedded for it. */
async function ask(
  document: Doc,
  question: string,
  options: {
    llm?: ScriptedLlm;
    rules?: ScriptRule[];
    config?: Config;
    evidence?: RagDeps['evidence'];
    /** Makes the embedding of the texts it says yes to fail (the join of a follow-up). */
    embedFails?: (text: string) => boolean;
    warnings?: string[];
  } = {},
): Promise<Asked> {
  const llm = options.llm ?? new ScriptedLlm(options.rules ?? []);
  const queries: string[] = [];
  const deps = ragDeps(db, llm, options.config ?? config(), {
    ...(options.evidence === undefined ? {} : { evidence: options.evidence }),
    ...(options.warnings === undefined
      ? {}
      : {
          log: {
            warn: (_object: object, message: string) => options.warnings?.push(message),
            error: () => undefined,
          },
        }),
    embeddings: {
      model: embeddings.model,
      embedQuery: (text: string, signal?: AbortSignal) => {
        queries.push(text);
        if (options.embedFails?.(text) === true)
          return Promise.reject(new Error('the embedding service is down'));
        return embeddings.embedQuery(text, signal);
      },
    },
  });
  const { events, emit } = collector();
  const input: AskInput = { document, question, signal: new AbortController().signal };
  await runAsk(deps, input, emit);
  return { events, llm, queries };
}

describe('after a failed rewrite the raw question decides guard 1; the join only widens the search (NB-1)', () => {
  const down = [
    { when: (call: { kind: string }) => call.kind === 'rewrite', reply: failing('LLM_UNAVAILABLE', 'down') },
  ];

  it('stops an off-topic follow-up that the previous question’s words would have carried past the gate', async () => {
    // measured with the stand-in model: "What is the capital of Peru?" alone 0.39, glued to "Who was Alaric Thornquist?" 0.53,
    // against a floor of 0.45
    const llm = new ScriptedLlm(down);
    const options = { llm, config: GROUNDING_ON(), evidence: STRICT_THRESHOLDS };
    await ask(english, 'Who was Alaric Thornquist?', options);
    const second = await ask(english, 'What is the capital of Peru?', options);
    expect(eventOf(second.events, 'retrieval').evidence).toBe('none');
    expect(eventOf(second.events, 'done')).toMatchObject({ mode: 'not_found', refusedBy: 'evidence' });
    expect(llm.callsOf('answer')).toHaveLength(1); // only the first question reached the model
    // the join was still embedded, to widen the candidates (best effort), and the raw question is what the gate read
    expect(second.queries).toEqual([
      'What is the capital of Peru?',
      'Who was Alaric Thornquist? What is the capital of Peru?',
    ]);
  });

  it('still answers a follow-up with a topic of its own, and the join adds the previous question’s chunks to the candidates', async () => {
    const llm = new ScriptedLlm(down);
    const options = { llm, config: config(), evidence: STAND_IN_THRESHOLDS };
    await ask(english, 'Who was Alaric Thornquist?', options);
    const second = await ask(english, 'Who kept the green notebook?', options);
    expect(eventOf(second.events, 'done').mode).toBe('answer');
    expect(eventOf(second.events, 'retrieval').rewrittenQuery).toBe(
      'Who was Alaric Thornquist? Who kept the green notebook?',
    );
  });

  it('reads the model’s rewrite when it succeeded: its cosine decides, as the model resolved the reference', async () => {
    const rewrite = 'What is the capital of Peru in the history of Thornquist House?';
    const llm = new ScriptedLlm([{ when: (call) => call.kind === 'rewrite', reply: rewrite }]);
    const second = await (async () => {
      const options = { llm, config: config(), evidence: STRICT_THRESHOLDS };
      await ask(english, 'Who was Alaric Thornquist?', options);
      return ask(english, 'What is the capital of Peru?', options);
    })();
    // embedded once, as rewritten (no join, no second embedding)
    expect(second.queries).toEqual([rewrite]);
  });
});

describe('a request that names an existing page and adds only a task points at the page (NB-2)', () => {
  it.each([
    'Summarize page 2',
    'Summarise page 2 please',
    'Translate page 2',
    'Read page 2',
    'Give me a summary of page 2',
    'List the items on page 2',
    'What does page 2 talk about?',
    'لخص الصفحة 2',
    'ماذا تقول الصفحة 2؟',
  ])('is answered from page 2, with strong evidence and no grounding check: %s', async (question) => {
    const { events, llm } = await ask(english, question, { evidence: STRICT_THRESHOLDS });
    expect(eventOf(events, 'retrieval')).toMatchObject({ evidence: 'strong' });
    expect(eventOf(events, 'retrieval').pages).toContain(2);
    expect(llm.callsOf('answer')).toHaveLength(1);
  });

  it('does not let a page name carry a question about something else past guard 1', async () => {
    const { events, llm } = await ask(english, 'What is the capital of Peru on page 2?', {
      evidence: STRICT_THRESHOLDS,
    });
    expect(eventOf(events, 'retrieval').evidence).not.toBe('strong');
    expect(llm.callsOf('answer')).toHaveLength(0);
  });
});

describe('a content-free follow-up does not inherit "page only" from the rewrite (NB-9)', () => {
  it('judges a rewrite’s pages by the rewrite’s own words: "tell me more" after a page question is checked like any question', async () => {
    const rewrite = 'Does page 1 mention online programs?';
    const llm = new ScriptedLlm([{ when: (call) => call.kind === 'rewrite', reply: rewrite }]);
    const options = { llm, config: GROUNDING_ON(), evidence: STAND_IN_THRESHOLDS };
    await ask(english, 'Does page 1 mention online programs?', options);
    const second = await ask(english, 'Tell me more', options);
    expect(eventOf(second.events, 'retrieval').evidence).not.toBe('strong');
    // and the grounding check ran, which a page-only question skips
    expect(llm.callsOf('grounding').length).toBe(2);
  });
});

describe('a summary of a topic is an ordinary question; only a whole-document request reads the overview (NB-3)', () => {
  it('finds the lost archive for "summarize the lost archive" and reads the overview for "give me a summary"', async () => {
    const focused = await ask(english, 'Summarize the lost archive', { evidence: STAND_IN_THRESHOLDS });
    const retrieval = eventOf(focused.events, 'retrieval');
    expect(retrieval.pages).toContain(4); // the page that has MS-4471 and the archive
    // it was SEARCHED (the overview of a whole document is read, not searched)
    expect(focused.queries).toEqual(['Summarize the lost archive']);
    await conversationsRepo.clear(db, english.id);
    const whole = await ask(english, 'Give me a summary', { evidence: STRICT_THRESHOLDS });
    expect(eventOf(whole.events, 'retrieval')).toMatchObject({ evidence: 'strong', retrievedChunks: 5 });
    expect(whole.llm.callsOf('answer')[0]?.lastUser).toMatch(/<excerpt id="S1" page="1"/u); // document order: the opening first
    expect(whole.queries).toEqual([]); // nothing was searched: the overview is read
  });
});

describe('the language of a question nothing tells (NB-14)', () => {
  it('asks for "the language of the question", never "Answer in English", and refuses in the document’s language', async () => {
    const document = await insertSyntheticDocument(
      db,
      [{ page: 1, text: 'The capital of Peru is the city of Lima.' }],
      { primaryLanguage: 'en' },
    );
    const doc: Doc = { id: document.documentId, filename: 'e.pdf', pageCount: 1, primaryLanguage: 'en' };
    const { events, llm } = await ask(doc, 'Peru?', {
      rules: [{ when: (call) => call.kind === 'answer', reply: NOT_IN_DOCUMENT }],
    });
    expect(llm.callsOf('answer')[0]?.lastUser.endsWith('Answer in the language of the question:')).toBe(true);
    expect(eventOf(events, 'done').answer).toBe(NOT_FOUND_MESSAGES.en);
  });

  it('refuses in Italian, Portuguese and Turkish when the question is in one of them', async () => {
    for (const [question, text] of [
      ['Chi ha fondato la biblioteca?', NOT_FOUND_MESSAGES.it],
      ['Quem fundou a biblioteca?', NOT_FOUND_MESSAGES.pt],
      ['Kütüphaneyi kim kurdu?', NOT_FOUND_MESSAGES.tr],
    ] as const) {
      expect(text, question).toBeTruthy();
      expect(text).not.toBe(NOT_FOUND_MESSAGES.en);
      const { events } = await ask(english, question, {
        rules: [{ when: (call) => call.kind === 'answer', reply: NOT_IN_DOCUMENT }],
        evidence: STAND_IN_THRESHOLDS,
      });
      // (the question may be stopped by the gate before the model is asked: either way the sentence is the question's language)
      expect(eventOf(events, 'done').answer, question).toBe(text);
    }
  });
});

describe('an auxiliary reply the output limit cut off is a failure (NB-16)', () => {
  it('uses the heuristic join, and says why, when the rewrite was cut off', async () => {
    const llm = new ScriptedLlm([
      {
        when: (call) => call.kind === 'rewrite',
        reply: 'What evidence supports that Alaric Thorn',
        finish: { reason: 'MAX_TOKENS', truncated: true },
      },
    ]);
    const options = { llm, config: config(), evidence: STAND_IN_THRESHOLDS };
    await ask(english, 'Who was Alaric Thornquist?', options);
    const second = await ask(english, 'What evidence supports it?', options);
    expect(eventOf(second.events, 'retrieval').rewrittenQuery).toBe(
      'Who was Alaric Thornquist? What evidence supports it?',
    );
    const stored = await conversationsRepo.list(db, (await conversationsRepo.find(db, english.id))!);
    expect(stored.at(-1)?.retrieval).toMatchObject({
      rewriteSource: 'heuristic',
      rewriteReason: 'truncated',
    });
  });
});

describe('a proper name counts as evidence only when the document spells it with a capital too (NB-10)', () => {
  const signalsOf = async (text: string, question: string) => {
    const synthetic = await insertSyntheticDocument(db, [
      { page: 1, text },
      { page: 2, text: 'Nothing else is said here about anything at all, only filler words for the chunk.' },
      {
        page: 3,
        text: 'Another page of plain filler text, with no names in it, to keep the document longer.',
      },
    ]);
    const { retrieve } = await import('../src/rag/retrieve.js');
    return (
      await retrieve(
        { db, embeddings },
        {
          documentId: synthetic.documentId,
          query: question,
          topK: 6,
          candidates: 24,
          contextCharBudget: 9000,
          pageCount: 3,
        },
      )
    ).signals;
  };

  it('finds the name the document capitalises, and not a word it only writes in lower case', async () => {
    expect(
      (await signalsOf('The capital of Peru is the city of Lima.', 'What is the capital of Peru?'))
        .properNameHit,
    ).toBe(true);
    // the document says "peru" in lower case only (a food, say): the question's "Peru" is not that
    expect(
      (await signalsOf('Add peru leaves to the stew and stir.', 'What is the capital of Peru?'))
        .properNameHit,
    ).toBe(false);
  });

  it('wants the whole name of several words: a brochure with "World Bank" is not about a "World Cup" (review NB-10)', async () => {
    const brochure =
      'Prof. Rana Khalil (Economics): World Bank consultant and author of three books on development.';
    expect((await signalsOf(brochure, 'Who won the 2018 football World Cup?')).properNameHit).toBe(false);
    expect((await signalsOf(brochure, 'Which World Bank projects did she advise?')).properNameHit).toBe(true);
    // a name split over two lines in the document is still the same name
    expect(
      (await signalsOf('Alaric\nThornquist founded the house in 1847.', 'Who was Alaric Thornquist?'))
        .properNameHit,
    ).toBe(true);
  });

  it('does not count the word of a request ("summarize") that the document lacks as a word it failed to cover (review N-6)', async () => {
    const signals = await signalsOf(
      'The scholarships cover tuition for graduate students.',
      'Summarize the scholarships',
    );
    expect(signals.lexicalCoverage).toBe(1);
  });

  it('finds none in a Title Case question, nor in a German one (every noun there has a capital)', async () => {
    expect(
      (await signalsOf('The capital of Peru is the city of Lima.', 'What Is The Capital Of Peru?'))
        .properNameHit,
    ).toBe(false);
    expect(
      (
        await signalsOf(
          'Die Hauptstadt von Peru ist die Stadt Lima, und die Bibliothek ist alt.',
          'Wie backe ich ein Brot für die Bibliothek?',
        )
      ).properNameHit,
    ).toBe(false);
  });
});

describe('a phrase that names the document and then a topic is searched, not read as an overview (N-1)', () => {
  it('"What does the document say about the lost archive?" is a search that finds page 4; "What does the document say?" reads the overview', async () => {
    const topical = await ask(english, 'What does the document say about the lost archive?', {
      evidence: STAND_IN_THRESHOLDS,
    });
    expect(topical.queries).toEqual(['What does the document say about the lost archive?']);
    expect(eventOf(topical.events, 'retrieval').pages).toContain(4);
    await conversationsRepo.clear(db, english.id);
    const whole = await ask(english, 'What does the document say?', { evidence: STRICT_THRESHOLDS });
    expect(whole.queries).toEqual([]);
    expect(eventOf(whole.events, 'retrieval')).toMatchObject({ evidence: 'strong', retrievedChunks: 5 });
  });

  it('"Tell me about the text on page 2" is page-directed: page 2 is boosted, strong evidence, no grounding check', async () => {
    const { events, llm } = await ask(english, 'Tell me about the text on page 2', {
      config: GROUNDING_ON(),
      evidence: STRICT_THRESHOLDS,
    });
    expect(eventOf(events, 'retrieval')).toMatchObject({ evidence: 'strong' });
    expect(eventOf(events, 'retrieval').pages).toContain(2);
    expect(llm.callsOf('grounding')).toHaveLength(0);
    expect(llm.callsOf('answer')).toHaveLength(1);
  });

  it('after a failed rewrite a pronoun follow-up is judged on its own cosine (review N-4): an honest "not found", not the previous question’s evidence', async () => {
    const down = [
      {
        when: (call: { kind: string }) => call.kind === 'rewrite',
        reply: failing('LLM_UNAVAILABLE', 'down'),
      },
    ];
    const llm = new ScriptedLlm(down);
    const options = { llm, config: config(), evidence: STRICT_THRESHOLDS };
    await ask(english, 'Who was Alaric Thornquist?', options);
    const second = await ask(english, 'Why?', options);
    expect(eventOf(second.events, 'retrieval').evidence).toBe('none');
    // with the model's own rewrite the same follow-up is answered: the reference was resolved
    const good = new ScriptedLlm([
      { when: (call) => call.kind === 'rewrite', reply: 'Why did Alaric Thornquist found Thornquist House?' },
    ]);
    await conversationsRepo.clear(db, english.id);
    const goodOptions = { llm: good, config: config(), evidence: STRICT_THRESHOLDS };
    await ask(english, 'Who was Alaric Thornquist?', goodOptions);
    const resolved = await ask(english, 'Why?', goodOptions);
    expect(eventOf(resolved.events, 'retrieval').evidence).not.toBe('none');
    expect(eventOf(resolved.events, 'done').mode).toBe('answer');
  });
});

describe('a best-effort step that fails says so (m-8)', () => {
  it('logs a join that could not be embedded, and still answers from the raw question', async () => {
    const llm = new ScriptedLlm([
      { when: (call) => call.kind === 'rewrite', reply: failing('LLM_UNAVAILABLE', 'down') },
    ]);
    const options = { llm, config: config(), evidence: STAND_IN_THRESHOLDS };
    await ask(english, 'Who was Alaric Thornquist?', options);
    const warnings: string[] = [];
    const second = await ask(english, 'Who kept the green notebook?', {
      ...options,
      warnings,
      embedFails: (text) => text.includes('Who was Alaric Thornquist?'),
    });
    expect(eventOf(second.events, 'done').mode).toBe('answer');
    expect(warnings.some((message) => message.includes('joined follow-up could not be embedded'))).toBe(true);
  });
});

describe('a bare "No" the output limit cut off is still a refusal (N-5)', () => {
  it.each(['No', 'لا', 'Not'])('refuses by the grounding check after a truncated "%s"', async (reply) => {
    const llm = new ScriptedLlm([
      { when: (call) => call.kind === 'grounding', reply, finish: { reason: 'MAX_TOKENS', truncated: true } },
    ]);
    const { events } = await ask(english, 'Who was Alaric Thornquist?', {
      llm,
      config: GROUNDING_ON(),
      evidence: STAND_IN_THRESHOLDS,
    });
    expect(eventOf(events, 'done')).toMatchObject({ mode: 'not_found', refusedBy: 'grounding' });
    expect(llm.callsOf('answer')).toHaveLength(0);
  });

  it('still fails open for a cut-off reply that says nothing certain', async () => {
    const llm = new ScriptedLlm([
      {
        when: (call) => call.kind === 'grounding',
        reply: 'Yes, the exc',
        finish: { reason: 'MAX_TOKENS', truncated: true },
      },
    ]);
    const { events } = await ask(english, 'Who was Alaric Thornquist?', {
      llm,
      config: GROUNDING_ON(),
      evidence: STAND_IN_THRESHOLDS,
    });
    expect(eventOf(events, 'done').mode).toBe('answer');
  });
});
