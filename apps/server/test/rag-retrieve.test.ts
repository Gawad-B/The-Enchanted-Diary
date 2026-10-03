import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, type Db } from '../src/db/client.js';
import { RRF_K } from '../src/rag/constants.js';
import { normalizeQuery, parsePageReferences, queryTokens, refersToVisiblePages } from '../src/rag/query.js';
import { retrieve, truncateAtBoundary, type RetrievalDeps } from '../src/rag/retrieve.js';
import { reciprocalRankFusion } from '../src/rag/rrf.js';
import { evenlySpaced, selectRepresentativeChunks } from '../src/rag/sampling.js';
import { FakeEmbeddings } from './doubles/fake-embeddings.js';
import { ingestFixture, insertSyntheticDocument } from './rag-helpers.js';
import { startServer, type TestServer } from './http-helpers.js';
import { testConfig } from './helpers.js';

// The retrieval module on real PGlite + pgvector, with the stand-in embedding model. What these tests establish is
// the lexical channel, the fusion, the idf weighting and the page boost; semantic quality is measured with the real
// model by the live calibration and evals (test/evals), which are the only tests that call Gemini.

let db: Db;
let server: TestServer;
let english: { documentId: string; pageCount: number };
let arabic: { documentId: string; pageCount: number };
const embeddings = new FakeEmbeddings();
const deps = (): RetrievalDeps => ({ db, embeddings });

beforeAll(async () => {
  db = await createDb(testConfig());
  server = await startServer(db, testConfig(), { embeddings });
  const en = await ingestFixture(server, 'text-en.pdf');
  english = { documentId: en.document.id, pageCount: en.document.pageCount };
  const ar = await ingestFixture(server, 'arabic.pdf');
  arabic = { documentId: ar.document.id, pageCount: ar.document.pageCount };
}, 180_000);
afterAll(async () => {
  await server.close();
  await db.close();
});

const search = (
  documentId: string,
  pageCount: number,
  query: string,
  extra: Partial<Parameters<typeof retrieve>[1]> = {},
) =>
  retrieve(deps(), {
    documentId,
    query,
    topK: 6,
    candidates: 24,
    contextCharBudget: 9000,
    pageCount,
    ...extra,
  });

const pagesOfTop = (outcome: Awaited<ReturnType<typeof retrieve>>, count = 1): number[] =>
  outcome.chunks.slice(0, count).map((entry) => entry.chunk.page_start);

describe('exact words: names, dates, identifiers', () => {
  it('finds the page of an exact name', async () => {
    const outcome = await search(english.documentId, english.pageCount, 'Who was Alaric Thornquist?');
    expect(pagesOfTop(outcome)).toEqual([2]);
    expect(outcome.chunks[0]?.lexicalRank).toBe(1);
    expect(outcome.signals.lexicalHit).toBe(true);
  });

  it('finds the page of a date', async () => {
    expect(pagesOfTop(await search(english.documentId, english.pageCount, '14 March 1847'))).toEqual([2]);
  });

  it('finds the page of an identifier written with a hyphen', async () => {
    expect(pagesOfTop(await search(english.documentId, english.pageCount, 'MS-4471'))).toEqual([4]);
    // written without the hyphen the identifier is searched whole AND in parts, so "MS 4471" is still found (page 4)
    // The lexical channel alone decides this (the stand-in embedding model has no meaning, and a 5-chunk document fills any
    // top-6): page 4 must be the FIRST lexical hit, found through the parts of the identifier ("ms" and "4471").
    for (const query of ['what is ms4471 about', 'MS4471', 'ms 4471']) {
      const outcome = await search(english.documentId, english.pageCount, query);
      const hit = outcome.chunks.find((entry) => entry.chunk.page_start === 4);
      expect(hit?.lexicalRank, query).toBe(1);
      expect(outcome.signals.identifierHit, query).toBe(true);
    }
    // and a question with no such identifier is not found on page 4 by words
    const other = await search(english.documentId, english.pageCount, 'who kept the green notebook');
    expect(other.chunks.find((entry) => entry.chunk.page_start === 4)?.lexicalRank ?? null).not.toBe(1);
  });

  it('finds the Arabic page of an Arabic name and of a year written with Arabic-Indic digits', async () => {
    expect(pagesOfTop(await search(arabic.documentId, arabic.pageCount, 'من هو يوسف القرطبي؟'))).toEqual([2]);
    // The document says ١٩٩٩; both spellings of the year are the same search word.
    expect(pagesOfTop(await search(arabic.documentId, arabic.pageCount, 'ماذا حدث عام 1999؟'))).toEqual([2]);
    expect(pagesOfTop(await search(arabic.documentId, arabic.pageCount, 'ماذا حدث عام ١٩٩٩؟'))).toEqual([2]);
  });

  it('reports a question about something the document never mentions as having no lexical hit', async () => {
    const outcome = await search(english.documentId, english.pageCount, 'What is the capital of Peru?');
    expect(outcome.signals.lexicalHit).toBe(false);
    expect(outcome.tokens).toEqual(['capital', 'peru']);
  });

  it('measures how much of the question the best chunk covers, by idf: all of an exact name, none of an absent topic', async () => {
    const coverage = async (query: string) =>
      (await search(english.documentId, english.pageCount, query)).signals.lexicalCoverage;
    expect(await coverage('Who was Alaric Thornquist?')).toBeGreaterThanOrEqual(0.9);
    expect(await coverage('MS-4471')).toBeGreaterThanOrEqual(0.9);
    expect(await coverage('What is the capital of Peru?')).toBe(0);
    // "keeper" is in the document, "lighthouse" is not: the question is only partly covered
    const partial = await coverage('What was the lighthouse keeper name?');
    expect(partial).toBeGreaterThan(0);
    expect(partial).toBeLessThan(0.6);
  });

  it('returns the timings of each channel and what was searched', async () => {
    const outcome = await search(english.documentId, english.pageCount, 'Who founded Thornquist House?');
    expect(outcome.searchedChunks).toBe(5);
    expect(outcome.timings.total).toBeGreaterThanOrEqual(outcome.timings.embed);
    expect(outcome.timings.lexical).toBeGreaterThanOrEqual(0);
  });
});

describe('single channels (the benchmark uses them)', () => {
  it('lexical-only never embeds the query; semantic-only never reads the full-text index', async () => {
    const lexicalOnly = await search(english.documentId, english.pageCount, 'MS-4471', { mode: 'lexical' });
    expect(lexicalOnly.timings.embed).toBe(0);
    expect(lexicalOnly.chunks.every((entry) => entry.semanticRank === null)).toBe(true);
    const semanticOnly = await search(english.documentId, english.pageCount, 'MS-4471', { mode: 'semantic' });
    expect(semanticOnly.chunks.every((entry) => entry.lexicalRank === null)).toBe(true);
    expect(semanticOnly.chunks.length).toBeGreaterThan(0);
  });
});

describe('Reciprocal Rank Fusion', () => {
  it('adds weight / (k + rank) over the lists and orders by the sum', () => {
    const fused = reciprocalRankFusion([
      { name: 'semantic', ids: ['a', 'b', 'c'] },
      { name: 'lexical', ids: ['c', 'a', 'd'] },
    ]);
    const score = (id: string): number => fused.find((item) => item.id === id)?.score ?? 0;
    expect(score('a')).toBeCloseTo(1 / (RRF_K + 1) + 1 / (RRF_K + 2), 12);
    expect(score('c')).toBeCloseTo(1 / (RRF_K + 3) + 1 / (RRF_K + 1), 12);
    expect(score('b')).toBeCloseTo(1 / (RRF_K + 2), 12);
    expect(score('d')).toBeCloseTo(1 / (RRF_K + 3), 12);
    expect(fused.map((item) => item.id)).toEqual(['a', 'c', 'b', 'd']);
    expect(fused.find((item) => item.id === 'c')?.ranks).toEqual({ semantic: 3, lexical: 1 });
  });

  it('breaks a tie in favour of the first tie-break list: the chunk the words point at', () => {
    const lists = [
      { name: 'semantic', ids: ['a', 'b'] },
      { name: 'lexical', ids: ['b', 'a'] },
    ];
    // a and b have exactly the same score
    expect(reciprocalRankFusion(lists).map((item) => item.id)).toEqual(['a', 'b']);
    expect(reciprocalRankFusion(lists, RRF_K, ['lexical', 'semantic']).map((item) => item.id)).toEqual([
      'b',
      'a',
    ]);
    expect(reciprocalRankFusion(lists, RRF_K, ['semantic']).map((item) => item.id)).toEqual(['a', 'b']);
  });

  it('uses k = 60, deduplicates, honours weights and breaks ties deterministically', () => {
    expect(RRF_K).toBe(60);
    const fused = reciprocalRankFusion([
      { name: 'semantic', ids: ['a', 'a', 'b'] },
      { name: 'page', ids: ['b'], weight: 3 },
    ]);
    // `a` counts once, at rank 1; `b` is rank 3 in the semantic list but carries the page list's weight 3.
    expect(fused.map((item) => item.id)).toEqual(['b', 'a']);
    expect(fused[1]?.score).toBeCloseTo(1 / 61, 12);
    // a tie: same score, same best rank: the order the lists were given in decides
    const tie = reciprocalRankFusion([
      { name: 'x', ids: ['p'] },
      { name: 'y', ids: ['q'] },
    ]);
    expect(tie.map((item) => item.id)).toEqual(['p', 'q']);
  });
});

describe('idf weighting inside one document', () => {
  it('ranks the chunk with a rare identifier above chunks full of a common word', async () => {
    const chunks = Array.from({ length: 12 }, (_, index) => ({
      page: index + 1,
      text:
        index === 7
          ? 'The ledger entry for the harbour lists the crate QX9921 and nothing else of note.'
          : `The harbour office recorded the harbour tides and the harbour weather on day ${String(index + 1)}.`,
    }));
    const { documentId } = await insertSyntheticDocument(db, chunks);
    // "harbour" is in every chunk (df/N = 1 > 0.5) and is dropped; the identifier is in one chunk and decides.
    const outcome = await retrieve(deps(), {
      documentId,
      query: 'harbour crate QX9921',
      topK: 6,
      candidates: 24,
      contextCharBudget: 9000,
      pageCount: 12,
      mode: 'lexical',
    });
    expect(outcome.chunks[0]?.chunk.page_start).toBe(8);
    expect(outcome.chunks[0]?.lexicalScore).toBeGreaterThan(0);
    // The common word matched chunks but never took part in the ranking: only the identifier chunk was returned.
    expect(outcome.chunks).toHaveLength(1);
    expect(outcome.signals.lexicalHit).toBe(true);
  });

  it('weights rare words above words that are only somewhat common', async () => {
    const chunks = Array.from({ length: 10 }, (_, index) => ({
      page: index + 1,
      text:
        index < 4
          ? `Lantern notes: the lantern was lit at dusk (entry ${String(index + 1)}) near the old pier.`
          : index === 9
            ? 'Entry ten mentions the sextant of captain Verhoeven near the old pier.'
            : `Entry ${String(index + 1)} describes the weather near the old pier.`,
    }));
    const { documentId } = await insertSyntheticDocument(db, chunks);
    const outcome = await retrieve(deps(), {
      documentId,
      query: 'lantern sextant',
      topK: 6,
      candidates: 24,
      contextCharBudget: 9000,
      pageCount: 10,
      mode: 'lexical',
    });
    // `sextant` (1 chunk) outweighs `lantern` (4 chunks): its chunk is first.
    expect(outcome.chunks[0]?.chunk.page_start).toBe(10);
  });

  it('does not drop common words from a document too small for frequencies to mean anything', async () => {
    const { documentId } = await insertSyntheticDocument(db, [
      { page: 1, text: 'The keeper lit the lamp.' },
      { page: 2, text: 'The keeper wrote the log.' },
    ]);
    const outcome = await retrieve(deps(), {
      documentId,
      query: 'keeper',
      topK: 6,
      candidates: 24,
      contextCharBudget: 9000,
      pageCount: 2,
      mode: 'lexical',
    });
    expect(outcome.chunks).toHaveLength(2);
  });
});

describe('page-directed questions', () => {
  it('parses page references in English, Arabic (Arabic-Indic digits too), French, Spanish and German', () => {
    expect(parsePageReferences('What does page 12 say?', 20)).toEqual({
      pages: [12],
      remainder: 'What does say?',
    });
    expect(parsePageReferences('summarise p. 3', 20).pages).toEqual([3]);
    expect(parsePageReferences('see pp. 3-4', 20).pages).toEqual([3, 4]);
    expect(parsePageReferences('pages 3 and 5', 20).pages).toEqual([3, 5]);
    expect(parsePageReferences('ماذا في صفحة ١٢؟', 20).pages).toEqual([12]);
    expect(parsePageReferences('ماذا في الصفحة 7', 20).pages).toEqual([7]);
    expect(parsePageReferences('que dit la page 4', 20).pages).toEqual([4]);
    expect(parsePageReferences('qué dice la página 5', 20).pages).toEqual([5]);
    expect(parsePageReferences('was steht auf Seite 6', 20).pages).toEqual([6]);
    // a number that is not a page, a page the document does not have, a word that only ends in p
    expect(parsePageReferences('in 1847 there were 12 keepers', 20).pages).toEqual([]);
    expect(parsePageReferences('page 99', 20).pages).toEqual([]);
    expect(parsePageReferences('the map 3 shows a bay', 20).pages).toEqual([]);
  });

  it('adds the named page as a boosted candidate: a question with no searchable words still finds the page', async () => {
    const outcome = await search(english.documentId, english.pageCount, 'What does page 4 say?');
    expect(outcome.namedPages).toEqual([4]);
    expect(outcome.tokens).toEqual([]);
    expect(pagesOfTop(outcome)).toEqual([4]);
    expect(outcome.chunks[0]?.pageRank).toBe(1);
    // the question only points at the page: it is its own evidence
    expect(outcome.signals.pageOnly).toBe(true);
    // a page named next to a real question boosts the page but still has to pass the gate
    const withTopic = await search(
      english.documentId,
      english.pageCount,
      'Does page 4 mention the capital of Peru?',
    );
    expect(withTopic.namedPages).toEqual([4]);
    expect(withTopic.signals.pageOnly).toBe(false);
    expect(withTopic.chunks[0]?.pageRank).toBe(1);
    const arabicOutcome = await search(arabic.documentId, arabic.pageCount, 'ماذا في صفحة ٣؟');
    expect(pagesOfTop(arabicOutcome)).toEqual([3]);
  });

  it('treats the reader’s visible pages as hints only when the question points at them', async () => {
    const pointing = await search(english.documentId, english.pageCount, 'What is this page about?', {
      visiblePages: [5],
    });
    expect(pagesOfTop(pointing)).toEqual([5]);
    const unrelated = await search(english.documentId, english.pageCount, 'Who was Alaric Thornquist?', {
      visiblePages: [5],
    });
    expect(unrelated.chunks.every((entry) => entry.pageRank === null)).toBe(true);
    // a bare "here" is not a pointer to the page
    const here = await search(english.documentId, english.pageCount, 'Who was Alaric Thornquist here?', {
      visiblePages: [5],
    });
    expect(here.chunks.every((entry) => entry.pageRank === null)).toBe(true);
    expect(here.signals.pageOnly).toBe(false);
    expect(refersToVisiblePages('what does this page say')).toBe(true);
    expect(refersToVisiblePages('ما موضوع هذه الصفحة؟')).toBe(true);
    expect(refersToVisiblePages('ما هذه القصة؟')).toBe(false);
    expect(refersToVisiblePages('qui a fondé la maison')).toBe(false);
  });
});

describe('query preparation', () => {
  it('normalises: NFKC, trimmed, whitespace collapsed', () => {
    expect(normalizeQuery('  Who \n was\t①  ')).toBe('Who was 1');
    expect(normalizeQuery('ﬁnd')).toBe('find');
  });

  it('drops stopwords of many languages but always keeps numbers and identifiers', () => {
    expect(queryTokens('What is the capital of Peru?')).toEqual(['capital', 'peru']);
    expect(queryTokens('MS-4471')).toEqual(['ms', '4471']);
    expect(queryTokens('14 March 1847')).toEqual(['14', 'march', '1847']);
    expect(queryTokens('Qui est le gardien du phare ?')).toEqual(['gardien', 'phare']);
    expect(queryTokens('من هو يوسف القرطبي؟')).toEqual(['يوسف', 'القرطبي', 'قرطبي']);
    expect(queryTokens('a 7 i')).toEqual(['7']);
  });

  it('matches Persian and Urdu stopwords whatever letter forms the question is typed with (the shared normaliser folds them)', () => {
    // Urdu: "What is this book about?" (kaf, yeh, heh written with Urdu code points)
    expect(queryTokens('یہ کتاب کس کے بارے میں ہے؟')).toEqual(['كتاب']);
    expect(queryTokens('کے میں ہے یہ')).toEqual([]);
    // Persian: "What is this book about?" and "Who is the book about, and why was it written?"
    expect(queryTokens('این کتاب درباره چیست؟')).toEqual(['كتاب']);
    expect(queryTokens('کتاب در مورد چه کسی است و چرا نوشته شده؟')).toEqual(['كتاب', 'نوشته']);
    // the same question typed with Arabic letters gives the same words
    expect(queryTokens('هذه كتاب كس')).toEqual(queryTokens('هذه كتاب كس'));
    expect(queryTokens('این كتاب درباره چیست؟')).toEqual(['كتاب']);
  });

  it('merges the question and its rewrite by union and caps the number of words', () => {
    expect(queryTokens('Who founded it?', 'Who founded Thornquist House?')).toEqual([
      'founded',
      'thornquist',
      'house',
    ]);
    const many = Array.from({ length: 80 }, (_, index) => `word${String(index)}x`).join(' ');
    expect(queryTokens(many).length).toBe(40);
  });
});

describe('cutting text to a budget', () => {
  it('cuts at a sentence or a word and says so', () => {
    expect(truncateAtBoundary('The first sentence ends here. Then more words follow after it.', 40)).toBe(
      'The first sentence ends here.…',
    );
    expect(truncateAtBoundary('short', 12)).toBe('short');
    expect(truncateAtBoundary('alpha beta gamma delta', 14)).toBe('alpha beta…');
  });

  it('keeps the best chunks within top-k and the character budget, cutting the first if it alone is too long', async () => {
    const long = 'The harbour log records a very long entry. '.repeat(30);
    const { documentId } = await insertSyntheticDocument(db, [
      { page: 1, text: long },
      { page: 2, text: 'The harbour log records another entry about tides.' },
      { page: 3, text: 'The harbour log records a third entry about weather.' },
    ]);
    const base = { documentId, query: 'harbour log entry', topK: 3, candidates: 24, pageCount: 3 } as const;
    const tight = await retrieve(deps(), { ...base, contextCharBudget: 500 });
    expect(tight.chunks[0]?.truncated).toBe(true);
    expect(tight.chunks.reduce((sum, entry) => sum + entry.text.length, 0)).toBeLessThanOrEqual(501);
    const topOne = await retrieve(deps(), { ...base, topK: 1, contextCharBudget: 9000 });
    expect(topOne.chunks).toHaveLength(1);
  });
});

describe('representative chunks for the reveal', () => {
  const row = (index: number, section: string | null) => ({
    id: `c${String(index)}`,
    chunkIndex: index,
    pageStart: index + 1,
    pageEnd: index + 1,
    sectionTitle: section,
    charCount: 100,
  });

  it('reads a short document whole', () => {
    expect(selectRepresentativeChunks([row(0, null), row(1, null)], 8)).toHaveLength(2);
  });

  it('takes the first chunk of each section, thinned evenly to the maximum', () => {
    const outline = Array.from({ length: 30 }, (_, index) =>
      row(index, `Section ${String(Math.floor(index / 2))}`),
    );
    const picked = selectRepresentativeChunks(outline, 8);
    expect(picked).toHaveLength(8);
    expect(picked.every((entry) => entry.chunkIndex % 2 === 0)).toBe(true); // first chunk of its section
    expect(picked[0]?.chunkIndex).toBe(0);
    expect(picked.at(-1)?.chunkIndex).toBe(28);
  });

  it('spreads chunks evenly over the pages when there are no sections', () => {
    const outline = Array.from({ length: 40 }, (_, index) => row(index, null));
    const picked = selectRepresentativeChunks(outline, 8);
    expect(picked).toHaveLength(8);
    expect(picked.map((entry) => entry.chunkIndex)).toEqual([0, 6, 11, 17, 22, 28, 33, 39]);
    expect(evenlySpaced([1, 2, 3], 8)).toEqual([1, 2, 3]);
  });

  const pages = (picked: { pageStart: number }[]): number[] => picked.map((entry) => entry.pageStart);

  it('reads a book with two headings in its first pages from beginning to end (sections alone decide nothing)', () => {
    const outline = Array.from({ length: 60 }, (_, index) => row(index, index < 3 ? 'Preface' : 'Chapter 1'));
    const picked = selectRepresentativeChunks(outline, 8);
    expect(picked).toHaveLength(8);
    expect(pages(picked)[0]).toBe(1);
    expect(Math.max(...pages(picked))).toBeGreaterThanOrEqual(55);
    // spread: no stretch of more than twice the even spacing is left unread
    const sorted = pages(picked);
    for (let index = 1; index < sorted.length; index += 1) {
      expect((sorted[index] ?? 0) - (sorted[index - 1] ?? 0)).toBeLessThanOrEqual(18);
    }
  });

  it('reads the early pages of a book whose headings only start late', () => {
    const outline = Array.from({ length: 100 }, (_, index) =>
      row(index, index >= 90 ? 'Appendix' : index >= 80 ? 'Notes' : null),
    );
    const picked = selectRepresentativeChunks(outline, 8);
    expect(picked.filter((entry) => entry.pageStart <= 40).length).toBeGreaterThanOrEqual(3);
    expect(picked[0]?.chunkIndex).toBe(0);
  });

  it('always takes the first chunk (the front matter has no heading), and reads the middle of a book with a title and a bibliography', () => {
    const outline = Array.from({ length: 80 }, (_, index) =>
      row(index, index === 0 ? 'A Title' : index >= 76 ? 'References' : null),
    );
    const picked = selectRepresentativeChunks(outline, 8);
    expect(picked[0]?.chunkIndex).toBe(0);
    expect(
      picked.filter((entry) => entry.pageStart > 20 && entry.pageStart < 60).length,
    ).toBeGreaterThanOrEqual(3);
    expect(picked.filter((entry) => entry.sectionTitle === 'References').length).toBeLessThanOrEqual(2);
  });

  it('prefers a section start close to an even target page, and never picks a chunk twice', () => {
    const outline = Array.from({ length: 40 }, (_, index) =>
      row(index, index % 10 === 0 ? `Part ${String(index / 10)}` : null),
    );
    const picked = selectRepresentativeChunks(outline, 8);
    expect(new Set(picked.map((entry) => entry.id)).size).toBe(picked.length);
    expect(picked.filter((entry) => entry.sectionTitle !== null).length).toBeGreaterThanOrEqual(3);
  });
});
