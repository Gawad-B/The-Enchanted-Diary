import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, type Db } from '../src/db/client.js';
import { retrieve } from '../src/rag/retrieve.js';
import { FakeEmbeddings } from './doubles/fake-embeddings.js';
import { ingestFixture } from './rag-helpers.js';
import { startServer, type TestServer } from './http-helpers.js';
import { testConfig } from './helpers.js';

/*
 * The Lab 2 document (tips-hindawi-university.pdf) is the one the course's questions are asked of. Only the live evals used
 * it, so nothing in the ordinary run would notice a chunker or a lexical-channel change that moved its answers. This pins
 * what can be pinned without a model (review M-7): the chunks the default sizes (2000/3000/400/200) make of it, their section
 * titles and pages, and the page the exact words of the course's questions are found on.
 */

let db: Db;
let server: TestServer;
let document: { documentId: string; pageCount: number };
const embeddings = new FakeEmbeddings();

beforeAll(async () => {
  db = await createDb(testConfig());
  server = await startServer(db, testConfig(), { embeddings });
  const ingested = await ingestFixture(server, 'tips-hindawi-university.pdf');
  document = { documentId: ingested.document.id, pageCount: ingested.document.pageCount };
}, 180_000);
afterAll(async () => {
  await server.close();
  await db.close();
});

const search = (query: string) =>
  retrieve(
    { db, embeddings },
    {
      documentId: document.documentId,
      query,
      topK: 6,
      candidates: 24,
      contextCharBudget: 9000,
      pageCount: document.pageCount,
    },
  );

/** The page of the chunk the exact words rank first (the lexical channel alone: the stand-in model has no meaning). */
const lexicalPage = async (query: string): Promise<number | undefined> =>
  (await search(query)).chunks.find((entry) => entry.lexicalRank === 1)?.chunk.page_start;

describe('the Lab 2 document, without a model', () => {
  it('is cut at its headings into the same 23 chunks, with the same section titles and pages', async () => {
    const rows = await db.query<{ page_start: number; page_end: number; section_title: string | null }>(
      'SELECT page_start, page_end, section_title FROM document_chunks WHERE document_id = $1 ORDER BY chunk_index',
      [document.documentId],
    );
    expect(document.pageCount).toBe(4);
    expect(rows.rows.map((row) => [row.page_start, row.page_end, row.section_title])).toEqual([
      [1, 1, '1. General Overview'],
      [1, 1, '2. Campus and Facilities'],
      [1, 1, '2.1 Main Campus'],
      [1, 1, '2.2 Satellite Campuses'],
      [1, 1, '2.3 Student Housing'],
      [1, 1, '3. Academic Structure'],
      [1, 1, '3.1 Faculties'],
      [2, 2, '3.2 Sample Undergraduate Programs'],
      [2, 2, '3.3 Graduate Programs'],
      [2, 2, '4. Admissions and Tuition'],
      [2, 2, '4.1 Undergraduate Admissions'],
      [2, 2, '4.2 Graduate Admissions'],
      [2, 2, '4.3 Tuition Fees (Annual)'],
      [2, 2, '4.4 Scholarships'],
      [2, 2, '5. Administration'],
      [3, 3, '5. Administration'],
      [3, 3, '6. Research and Innovation'],
      [3, 3, '7. Student Life'],
      [3, 3, '7.1 Clubs and Organizations'],
      [3, 3, '7.2 Events and Traditions'],
      [3, 3, '7.3 Support Services'],
      [3, 3, '8. Faculty Highlights'],
      [4, 4, '9. Alumni and Impact'],
    ]);
  });

  it('finds the course questions’ exact words on their pages', async () => {
    expect(await lexicalPage('scholarships')).toBe(2);
    expect(await lexicalPage('President')).toBe(2);
    expect(await lexicalPage('faculties')).toBe(1);
    expect(await lexicalPage('tuition fees')).toBe(2);
    // the President is named on the page break: both pages' chunks carry it, and both are found for the question as asked
    // (the word "university" is in the first chunk alone: the document says "THU" after that, so the idf of "President"
    // is what finds the others)
    const asked = await search('Who is the President of the university?');
    const found = asked.chunks
      .filter((entry) => entry.lexicalRank !== null)
      .map((entry) => entry.chunk.page_start);
    expect(found).toEqual(expect.arrayContaining([2, 3]));
  });
});
