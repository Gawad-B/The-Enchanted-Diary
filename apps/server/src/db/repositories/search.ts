import type { Queryable } from '../client.js';

export interface TokenDocumentFrequency {
  token: string;
  /** Number of chunks of the document that contain the token. */
  df: number;
}

export interface LexicalCandidate {
  chunkId: string;
  chunkIndex: number;
  /** Sum of the idf of the distinct query tokens the chunk contains. */
  score: number;
  /** `ts_rank_cd` over all the tokens: the tie-break. */
  rankCd: number;
}

export interface ChunkOutlineRow {
  id: string;
  chunkIndex: number;
  pageStart: number;
  pageEnd: number;
  sectionTitle: string | null;
  charCount: number;
}

/** `'tok1' | 'tok2'` for `to_tsquery`: every token quoted (tokens hold only letters and digits, but quoting is free). */
export const orQuery = (tokens: readonly string[]): string =>
  tokens.map((token) => `'${token.replaceAll("'", "''")}'`).join(' | ');

/**
 * Full-text queries over ONE document's chunks (`tsv` is the generated `to_tsvector('simple', search_text)` column).
 * Each query token is parsed with `plainto_tsquery('simple', token)`, the very parser that built the index, so a token
 * is matched exactly as it was indexed. Callers never pass an empty token list (an empty tsquery logs a notice).
 */
export const searchRepo = {
  /** One statement: how many chunks of the document contain each token. */
  async documentFrequencies(
    q: Queryable,
    documentId: string,
    tokens: readonly string[],
  ): Promise<TokenDocumentFrequency[]> {
    if (tokens.length === 0) return [];
    const result = await q.query<{ token: string; df: number }>(
      `SELECT t.token AS token, count(c.id)::int AS df
       FROM unnest($2::text[]) AS t(token)
       LEFT JOIN document_chunks c ON c.document_id = $1 AND c.tsv @@ plainto_tsquery('simple', t.token)
       GROUP BY t.token`,
      [documentId, [...tokens]],
    );
    return result.rows.map((row) => ({ token: row.token, df: row.df }));
  },

  /** Chunks containing any of the weighted tokens, best first: idf sum, then `ts_rank_cd`, then document order. */
  async lexicalCandidates(
    q: Queryable,
    documentId: string,
    weighted: readonly { token: string; idf: number }[],
    limit: number,
  ): Promise<LexicalCandidate[]> {
    if (weighted.length === 0) return [];
    const result = await q.query<{ id: string; chunk_index: number; score: number; rank_cd: number }>(
      `SELECT c.id AS id, c.chunk_index AS chunk_index, sum(w.idf)::float8 AS score,
              ts_rank_cd(c.tsv, to_tsquery('simple', $4))::float8 AS rank_cd
       FROM unnest($2::text[], $3::float8[]) AS w(token, idf)
       JOIN document_chunks c ON c.document_id = $1 AND c.tsv @@ plainto_tsquery('simple', w.token)
       GROUP BY c.id
       ORDER BY score DESC, rank_cd DESC, c.chunk_index
       LIMIT $5`,
      [
        documentId,
        weighted.map((entry) => entry.token),
        weighted.map((entry) => entry.idf),
        orQuery(weighted.map((entry) => entry.token)),
        limit,
      ],
    );
    return result.rows.map((row) => ({
      chunkId: row.id,
      chunkIndex: row.chunk_index,
      score: row.score,
      rankCd: row.rank_cd,
    }));
  },

  /**
   * Which of these words (as written, with their capital: "Peru") the document itself writes with a capital letter somewhere,
   * at the start of a word. A proper name in a question counts as evidence only when the document spells it that way too.
   */
  async capitalisedForms(
    q: Queryable,
    documentId: string,
    surfaces: readonly string[],
  ): Promise<Set<string>> {
    if (surfaces.length === 0) return new Set();
    const unique = [...new Set(surfaces)];
    // a name of several words is written with any white space between them (a line break included)
    const patterns = unique.map((surface) => surface.replace(/ +/gu, String.raw`\s+`));
    const result = await q.query<{ surface: string }>(
      `SELECT w.surface AS surface
       FROM unnest($2::text[], $3::text[]) AS w(surface, pattern)
       WHERE EXISTS (
         SELECT 1 FROM document_chunks c
         WHERE c.document_id = $1 AND c.content ~ ('(^|[^[:alpha:]])' || w.pattern)
       )`,
      [documentId, unique, patterns],
    );
    return new Set(result.rows.map((row) => row.surface));
  },

  /** Chunks that cover any of the pages, in document order. */
  async chunksOnPages(
    q: Queryable,
    documentId: string,
    pages: readonly number[],
  ): Promise<{ chunkId: string; chunkIndex: number }[]> {
    if (pages.length === 0) return [];
    const result = await q.query<{ id: string; chunk_index: number }>(
      `SELECT c.id AS id, c.chunk_index AS chunk_index FROM document_chunks c
       WHERE c.document_id = $1
         AND EXISTS (SELECT 1 FROM unnest($2::int[]) AS p(page) WHERE c.page_start <= p.page AND c.page_end >= p.page)
       ORDER BY c.chunk_index`,
      [documentId, [...pages]],
    );
    return result.rows.map((row) => ({ chunkId: row.id, chunkIndex: row.chunk_index }));
  },

  /** What is needed to pick representative chunks without loading their text. */
  async outline(q: Queryable, documentId: string): Promise<ChunkOutlineRow[]> {
    const result = await q.query<{
      id: string;
      chunk_index: number;
      page_start: number;
      page_end: number;
      section_title: string | null;
      chars: number;
    }>(
      `SELECT id, chunk_index, page_start, page_end, section_title, length(content)::int AS chars
       FROM document_chunks WHERE document_id = $1 ORDER BY chunk_index`,
      [documentId],
    );
    return result.rows.map((row) => ({
      id: row.id,
      chunkIndex: row.chunk_index,
      pageStart: row.page_start,
      pageEnd: row.page_end,
      sectionTitle: row.section_title,
      charCount: row.chars,
    }));
  },
};
