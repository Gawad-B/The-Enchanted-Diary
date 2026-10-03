import type { Direction, NormalizedRect } from '@enchanted/shared';
import type { Queryable } from '../client.js';

export interface ChunkRecord {
  id: string;
  chunkIndex: number;
  pageStart: number;
  pageEnd: number;
  sectionTitle: string | null;
  language: string;
  direction: Direction;
  content: string;
  searchText: string;
  charStart: number;
  charEnd: number;
  overlapChars: number;
  tokenCount: number;
  highlights: { page: number; rects: NormalizedRect[]; charStart: number; charEnd: number }[];
}

export interface ChunkRow {
  id: string;
  document_id: string;
  chunk_index: number;
  page_start: number;
  page_end: number;
  section_title: string | null;
  language: string;
  direction: Direction;
  content: string;
  search_text: string;
  char_start: number;
  char_end: number;
  overlap_chars: number;
  token_count: number;
  highlights: ChunkRecord['highlights'];
}

const COLUMNS =
  'id, document_id, chunk_index, page_start, page_end, section_title, language, direction, content, search_text, char_start, char_end, overlap_chars, token_count, highlights';
/** Columns of a row (the last one, the highlights, is JSON). */
const FIELDS = 15;
/** Rows per INSERT statement. */
const BATCH = 100;

export const chunksRepo = {
  async insertMany(q: Queryable, documentId: string, chunks: readonly ChunkRecord[]): Promise<void> {
    for (let offset = 0; offset < chunks.length; offset += BATCH) {
      const batch = chunks.slice(offset, offset + BATCH);
      const params: unknown[] = [];
      const values = batch.map((chunk, row) => {
        const base = row * FIELDS;
        params.push(
          chunk.id,
          documentId,
          chunk.chunkIndex,
          chunk.pageStart,
          chunk.pageEnd,
          chunk.sectionTitle,
          chunk.language,
          chunk.direction,
          chunk.content,
          chunk.searchText,
          chunk.charStart,
          chunk.charEnd,
          chunk.overlapChars,
          chunk.tokenCount,
          JSON.stringify(chunk.highlights),
        );
        const placeholders = Array.from(
          { length: FIELDS },
          (_, i) => `$${String(base + i + 1)}${i === FIELDS - 1 ? '::jsonb' : ''}`,
        );
        return `(${placeholders.join(', ')})`;
      });
      await q.query(`INSERT INTO document_chunks (${COLUMNS}) VALUES ${values.join(', ')}`, params);
    }
  },

  async count(q: Queryable, documentId: string): Promise<number> {
    const result = await q.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM document_chunks WHERE document_id = $1',
      [documentId],
    );
    return result.rows[0]?.n ?? 0;
  },

  /** Removes the chunks of a document, and with them their embeddings (by cascade). */
  async removeForDocument(q: Queryable, documentId: string): Promise<void> {
    await q.query('DELETE FROM document_chunks WHERE document_id = $1', [documentId]);
  },

  async forDocument(q: Queryable, documentId: string): Promise<ChunkRow[]> {
    const result = await q.query<ChunkRow>(
      `SELECT ${COLUMNS} FROM document_chunks WHERE document_id = $1 ORDER BY chunk_index`,
      [documentId],
    );
    return result.rows;
  },

  async byIds(q: Queryable, documentId: string, ids: readonly string[]): Promise<ChunkRow[]> {
    if (ids.length === 0) return [];
    const result = await q.query<ChunkRow>(
      `SELECT ${COLUMNS} FROM document_chunks WHERE document_id = $1 AND id = ANY($2::uuid[]) ORDER BY chunk_index`,
      [documentId, [...ids]],
    );
    return result.rows;
  },
};
