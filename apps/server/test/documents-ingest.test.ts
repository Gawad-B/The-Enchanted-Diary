import { SessionDocumentResponseSchema } from '@enchanted/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, type Db } from '../src/db/client.js';
import { chunksRepo } from '../src/db/repositories/chunks.js';
import { embeddingsRepo } from '../src/db/repositories/embeddings.js';
import { pagesRepo } from '../src/db/repositories/pages.js';
import { FakeEmbeddings, hashedVector } from './doubles/fake-embeddings.js';
import { errorOf, startServer, summaryOf, waitForDocument, type TestServer } from './http-helpers.js';
import { readFixture } from './fixtures.js';
import { testConfig } from './helpers.js';

let db: Db;
let server: TestServer;

beforeAll(async () => {
  db = await createDb(testConfig());
  server = await startServer(db, testConfig());
});
afterAll(async () => {
  await server.close();
  await db.close();
});

describe('a text PDF (text-en.pdf)', () => {
  it('is accepted with 202, read by the ticks of the client and ends ready with pages, chunks and embeddings', async () => {
    const client = server.client();
    const accepted = summaryOf(await client.uploadFixture('text-en.pdf'));
    expect(accepted).toMatchObject({
      filename: 'text-en.pdf',
      status: 'processing',
      stage: 'queued',
      pageCount: 5,
      primaryLanguage: 'und',
    });
    expect(new Date(accepted.expiresAt).getTime()).toBeGreaterThan(Date.now());

    const ready = await waitForDocument(client, accepted.id);
    expect(ready.status).toBe('ready');
    expect(ready.stage).toBe('ready');
    expect(ready.error).toBeUndefined();
    expect(ready).toMatchObject({
      pageCount: 5,
      primaryLanguage: 'en',
      direction: 'ltr',
      chunkCount: 5,
      warnings: [],
    });
    expect(ready.languages).toEqual([{ code: 'en', share: 1 }]);
    expect(
      ready.pages.map((page) => [page.pageNumber, page.extraction, page.language, page.direction]),
    ).toEqual([1, 2, 3, 4, 5].map((n) => [n, 'text', 'en', 'ltr']));
    expect(
      ready.pages.every(
        (page) =>
          page.width === 612 && page.height === 792 && page.charCount > 200 && page.ocrConfidence === null,
      ),
    ).toBe(true);
    // Sections include "The Founding" on page 2.
    expect(ready.sections).toContainEqual({ title: 'The Founding', page: 2 });
    expect(ready.sections.map((section) => section.title)).toEqual([
      'A Brief History of Thornquist House',
      'The Founding',
      'The Lost Archive',
      'Conclusion',
    ]);

    // The rows are really there: chunks with page numbers and offsets, embeddings with their dimensions.
    const chunks = await chunksRepo.forDocument(db, ready.id);
    expect(chunks.map((chunk) => [chunk.page_start, chunk.page_end, chunk.section_title])).toEqual([
      [1, 1, 'A Brief History of Thornquist House'],
      [2, 2, 'The Founding'],
      [3, 3, 'The Founding'],
      [4, 4, 'The Lost Archive'],
      [5, 5, 'Conclusion'],
    ]);
    const texts = await pagesRepo.texts(db, ready.id, [1, 2, 3, 4, 5]);
    for (const chunk of chunks) {
      expect(texts.get(chunk.page_start)?.slice(chunk.char_start, chunk.char_end)).toBe(
        chunk.content.slice(chunk.overlap_chars),
      );
      expect(chunk.search_text.length).toBeGreaterThan(20);
      expect(chunk.token_count).toBeGreaterThan(20);
      expect(chunk.highlights[0]?.rects.length).toBeGreaterThan(0);
    }
    const dims = await db.query<{ dims: number; model: string; n: number }>(
      `SELECT e.dims, e.model, count(*)::int AS n FROM chunk_embeddings e JOIN document_chunks c ON c.id = e.chunk_id
       WHERE c.document_id = $1 GROUP BY e.dims, e.model`,
      [ready.id],
    );
    expect(dims.rows).toEqual([{ dims: 384, model: 'fake-hash-384', n: 5 }]);
    expect(await embeddingsRepo.count(db, ready.id)).toBe(5);

    // Retrieval-ready: exact nearest neighbour finds the chunk with the planted fact (the fake model is lexical).
    const query = hashedVector('Alaric Thornquist founded the house on 14 March 1847');
    const [best] = await embeddingsRepo.nearest(db, ready.id, 'fake-hash-384', query, 3);
    expect(chunks.find((chunk) => chunk.id === best?.chunkId)?.content).toContain('Alaric Thornquist');
    // The document is a first-class citizen of the session now.
    const session = SessionDocumentResponseSchema.parse((await client.get('/api/session/document')).json());
    expect(session.document?.id).toBe(ready.id);
    expect(session.document?.status).toBe('ready');
  }, 90_000);
});

describe('an Arabic PDF (arabic.pdf)', () => {
  it('is read as Arabic and right to left, with the text in logical order', async () => {
    const client = server.client();
    const ready = await waitForDocument(client, summaryOf(await client.uploadFixture('arabic.pdf')).id);
    expect(ready).toMatchObject({
      status: 'ready',
      primaryLanguage: 'ar',
      direction: 'rtl',
      pageCount: 3,
      warnings: [],
    });
    expect(ready.pages.map((p) => [p.language, p.direction, p.extraction])).toEqual([
      ['ar', 'rtl', 'text'],
      ['ar', 'rtl', 'text'],
      ['ar', 'rtl', 'text'],
    ]);
    const texts = await pagesRepo.texts(db, ready.id, [2]);
    expect(texts.get(2)).toContain('يوسف القرطبي'); // logical order, not reversed
    const chunks = await chunksRepo.forDocument(db, ready.id);
    expect(chunks.every((chunk) => chunk.direction === 'rtl' && chunk.language === 'ar')).toBe(true);
    expect(chunks[1]?.search_text).toContain('1999'); // ١٩٩٩ is searchable as 1999
    expect(ready.sections.map((s) => s.title)).toEqual([
      'مكتبة الأوراق القديمة',
      'قصة المؤسس',
      'الأرشيف المفقود',
    ]);
  }, 90_000);
});

describe('a mixed Arabic-English PDF (mixed-ar-en.pdf)', () => {
  it('has an English left-to-right page and an Arabic right-to-left page, and both languages in the document', async () => {
    const client = server.client();
    const ready = await waitForDocument(client, summaryOf(await client.uploadFixture('mixed-ar-en.pdf')).id);
    expect(ready.pages.map((p) => [p.language, p.direction])).toEqual([
      ['en', 'ltr'],
      ['ar', 'rtl'],
    ]);
    expect(ready.languages.map((l) => l.code).sort()).toEqual(['ar', 'en']);
    expect(ready.languages.reduce((sum, l) => sum + l.share, 0)).toBeCloseTo(1, 5);
    const chunks = await chunksRepo.forDocument(db, ready.id);
    expect(chunks.map((c) => [c.page_start, c.language, c.direction])).toEqual([
      [1, 'en', 'ltr'],
      [2, 'ar', 'rtl'],
    ]);
    expect((await pagesRepo.texts(db, ready.id, [2])).get(2)).toContain('MS-4471');
  }, 90_000);
});

describe('the embedding window', () => {
  it('stores no chunk longer than the window, even when the estimate was too low: the chunk is split again with the exact count', async () => {
    // A tokenizer far stricter than the chunker's estimate (one token per two characters) and a small window.
    const counter = (text: string): number => Math.ceil(text.length / 2);
    const embeddings = new FakeEmbeddings({ maxInputTokens: 200, tokenCounter: counter });
    const strict = await startServer(db, testConfig(), { embeddings });
    try {
      const client = strict.client();
      const ready = await waitForDocument(client, summaryOf(await client.uploadFixture('text-en.pdf')).id);
      expect(ready.status).toBe('ready');
      const chunks = await chunksRepo.forDocument(db, ready.id);
      expect(chunks.length).toBeGreaterThan(5); // the five chunks of the default window were split
      for (const chunk of chunks) {
        expect(counter(chunk.content), `chunk ${String(chunk.chunk_index)}`).toBeLessThanOrEqual(200);
        expect(chunk.token_count).toBe(counter(chunk.content));
      }
      expect(ready.chunkCount).toBe(chunks.length);
      expect(await embeddingsRepo.count(db, ready.id)).toBe(chunks.length);
      // The offsets are still exact, and the sections carried over.
      const texts = await pagesRepo.texts(db, ready.id, [1, 2, 3, 4, 5]);
      for (const chunk of chunks) {
        expect(texts.get(chunk.page_start)?.slice(chunk.char_start, chunk.char_end)).toBe(
          chunk.content.slice(chunk.overlap_chars),
        );
      }
      expect(chunks.filter((chunk) => chunk.section_title === 'The Founding').length).toBeGreaterThan(2);
    } finally {
      await strict.close();
    }
  }, 90_000);
});

// The server of this file has OCR switched off (OCR_PROVIDER=none, the test default): what becomes of a page that needs
// OCR when there is no engine. With the engine it is in ocr-pipeline.test.ts and ocr-pipeline.model.test.ts.
describe('documents that need OCR when there is no OCR engine', () => {
  it('keeps the garbled text of a PDF that lost glyphs, flags it, and does not drop it (arabic-damaged.pdf)', async () => {
    const client = server.client();
    const ready = await waitForDocument(
      client,
      summaryOf(await client.uploadFixture('arabic-damaged.pdf')).id,
    );
    expect(ready.status).toBe('ready');
    expect(ready.warnings).toEqual([
      { code: 'OCR_UNAVAILABLE', pages: [1, 2, 3] },
      { code: 'LOW_TEXT_QUALITY', pages: [1, 2, 3] },
    ]);
    expect(ready.pages.every((page) => page.extraction === 'text' && page.charCount > 50)).toBe(true);
    expect(ready.primaryLanguage).toBe('ar');
  }, 90_000);

  it('routes a PDF without ToUnicode maps to OCR: the page is flagged and its garbage text is not trusted (arabic-no-tounicode.pdf)', async () => {
    const client = server.client();
    const ready = await waitForDocument(
      client,
      summaryOf(await client.uploadFixture('arabic-no-tounicode.pdf')).id,
    );
    expect(ready.status).toBe('ready');
    expect(ready.warnings).toEqual([
      { code: 'OCR_UNAVAILABLE', pages: [1, 2, 3] },
      { code: 'LOW_TEXT_QUALITY', pages: [1, 2, 3] },
    ]);
    // Garbled text is no evidence: no mojibake headings, no language taken from it, and the Arabic font of the pages
    // still says which way the book reads.
    expect(ready.sections).toEqual([]);
    expect(ready.languages).toEqual([]);
    expect(ready.direction).toBe('rtl');
    expect(ready.pages.map((page) => [page.language, page.direction])).toEqual([
      ['und', 'rtl'],
      ['und', 'rtl'],
      ['und', 'rtl'],
    ]);
    const chunks = await chunksRepo.forDocument(db, ready.id);
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks.every((chunk) => chunk.section_title === null && chunk.direction === 'rtl')).toBe(true);
  }, 90_000);

  it('fails a PDF with no text at all as PDF_EMPTY (empty.pdf): accepted at upload, failed during ingestion', async () => {
    const client = server.client();
    const accepted = summaryOf(await client.uploadFixture('empty.pdf'));
    const failed = await waitForDocument(client, accepted.id);
    expect(failed.status).toBe('failed');
    expect(failed.stage).toBe('failed');
    expect(failed.error?.code).toBe('PDF_EMPTY');
    expect(failed.pages).toEqual([]);
    expect(failed.chunkCount).toBe(0);
    // A failed document is not the session's document.
    expect(
      SessionDocumentResponseSchema.parse((await client.get('/api/session/document')).json()).document,
    ).toBeNull();
    // Its file is gone (nothing to keep), and it cannot be fetched.
    expect(await server.app.ingestion.storage.stat(`${accepted.id}.pdf`)).toBeNull();
    expect((await client.get(`/api/documents/${accepted.id}/file`)).statusCode).toBe(409);
  }, 90_000);
});

describe('GET /api/documents/:id/file', () => {
  it('serves the PDF inline, uncached and sandboxed', async () => {
    const client = server.client();
    const ready = await waitForDocument(client, summaryOf(await client.uploadFixture('text-en.pdf')).id);
    const response = await client.get(`/api/documents/${ready.id}/file`);
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toBe('application/pdf');
    expect(response.headers['content-disposition']).toBe('inline; filename="document.pdf"');
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.headers['content-security-policy']).toBe('sandbox');
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['content-length']).toBe(String((await readFixture('text-en.pdf')).length));
    expect(response.rawPayload.equals(await readFixture('text-en.pdf'))).toBe(true);
    const stranger = server.client();
    expect((await stranger.get(`/api/documents/${ready.id}/file`)).statusCode).toBe(404);
    expect(errorOf(await stranger.get(`/api/documents/${ready.id}/file`)).code).toBe('DOCUMENT_NOT_FOUND');
  }, 60_000);
});
