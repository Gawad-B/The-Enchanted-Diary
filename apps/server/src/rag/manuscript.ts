import type { Queryable } from '../db/client.js';
import { chunksRepo, type ChunkRow } from '../db/repositories/chunks.js';
import { searchRepo } from '../db/repositories/search.js';
import { fitEvenly, selectRepresentativeChunks } from './sampling.js';
import type { RetrievalOutcome, RetrievedChunk } from './retrieve.js';

/*
 * The manuscript overview: representative chunks of a whole document, spread over its pages and sections (sampling.ts), for
 * what no single passage answers. The reveal's essence reads it, and so does a question about the document as a whole ("what is
 * this document about?", "summarise it": query.ts `isMetaQuestion`), which skips the evidence gate (there is no passage to
 * match) and goes through the grounding check and the answer model like any other question.
 */

/** The chunks the overview reads, in document order, and how many chunks the document has. */
export async function pickManuscriptChunks(
  db: Queryable,
  documentId: string,
  max: number,
): Promise<{ chunks: ChunkRow[]; searched: number }> {
  const outline = await searchRepo.outline(db, documentId);
  const chosen = selectRepresentativeChunks(outline, max).map((row) => row.id);
  const rows = new Map((await chunksRepo.byIds(db, documentId, chosen)).map((row) => [row.id, row]));
  const chunks = chosen.flatMap((id) => {
    const row = rows.get(id);
    return row === undefined ? [] : [row];
  });
  return { chunks, searched: outline.length };
}

/** The overview as a retrieval outcome: the chunks fitted to the character budget, no ranks, and a `meta` signal for the gate. */
export async function manuscriptOutcome(
  db: Queryable,
  documentId: string,
  options: { max: number; budget: number },
): Promise<RetrievalOutcome> {
  const started = performance.now();
  const { chunks, searched } = await pickManuscriptChunks(db, documentId, options.max);
  const fitted = fitEvenly(
    chunks.map((chunk) => chunk.content),
    options.budget,
  );
  const retrieved: RetrievedChunk[] = chunks.map((chunk, index) => ({
    chunk,
    text: fitted[index]?.text ?? chunk.content,
    truncated: fitted[index]?.truncated ?? false,
    semanticRank: null,
    lexicalRank: null,
    pageRank: null,
    semanticScore: null,
    lexicalScore: null,
    rrfScore: 0,
  }));
  const total = Math.round((performance.now() - started) * 10) / 10;
  return {
    chunks: retrieved,
    searchedChunks: searched,
    signals: {
      lexicalHit: false,
      lexicalCoverage: 0,
      identifierHit: false,
      properNameHit: false,
      pageOnly: false,
      topCosine: null,
      hasChunks: searched > 0,
      meta: true,
    },
    semanticScores: [],
    tokens: [],
    namedPages: [],
    timings: { embed: 0, semantic: 0, lexical: 0, total },
  };
}
