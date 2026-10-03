import type { Queryable } from '../client.js';

export interface EmbeddingRecord {
  chunkId: string;
  model: string;
  embedding: readonly number[];
}

export interface NearestChunk {
  chunkId: string;
  chunkIndex: number;
  /** Cosine similarity, 1 - distance. */
  score: number;
}

/** Embedding rows per INSERT statement. */
export const EMBEDDING_BATCH = 200;

/** A vector as pgvector text input: both drivers need `'[0.1,0.2]'` with a `::vector` cast. */
export const vectorLiteral = (vector: readonly number[]): string => `[${vector.join(',')}]`;

/** A chunk that has no embedding with the model yet. */
export interface UnembeddedChunk {
  id: string;
  content: string;
  sectionTitle: string | null;
}

export const embeddingsRepo = {
  /**
   * Inserts embeddings about 200 rows per statement. The column is an untyped vector: any dimension works. A chunk that
   * already has an embedding with the model keeps it (`onConflictKeep`): a tick that is repeated after a crash must not
   * fail on the rows its predecessor wrote.
   */
  async insertMany(
    q: Queryable,
    records: readonly EmbeddingRecord[],
    options: { onConflictKeep?: boolean } = {},
  ): Promise<void> {
    for (let offset = 0; offset < records.length; offset += EMBEDDING_BATCH) {
      const batch = records.slice(offset, offset + EMBEDDING_BATCH);
      const params: unknown[] = [];
      const values = batch.map((record, row) => {
        const base = row * 4;
        params.push(record.chunkId, record.model, record.embedding.length, vectorLiteral(record.embedding));
        return `($${String(base + 1)}, $${String(base + 2)}, $${String(base + 3)}, $${String(base + 4)}::vector)`;
      });
      await q.query(
        `INSERT INTO chunk_embeddings (chunk_id, model, dims, embedding) VALUES ${values.join(', ')}${
          options.onConflictKeep === true ? ' ON CONFLICT (chunk_id, model) DO NOTHING' : ''
        }`,
        params,
      );
    }
  },

  /** The next chunks of a document, in order, that have no embedding with `model` yet. */
  async nextUnembedded(
    q: Queryable,
    documentId: string,
    model: string,
    limit: number,
  ): Promise<UnembeddedChunk[]> {
    const result = await q.query<{ id: string; content: string; section_title: string | null }>(
      `SELECT c.id, c.content, c.section_title
       FROM document_chunks c
       WHERE c.document_id = $1
         AND NOT EXISTS (SELECT 1 FROM chunk_embeddings e WHERE e.chunk_id = c.id AND e.model = $2)
       ORDER BY c.chunk_index LIMIT $3`,
      [documentId, model, limit],
    );
    return result.rows.map((row) => ({ id: row.id, content: row.content, sectionTitle: row.section_title }));
  },

  async count(q: Queryable, documentId: string): Promise<number> {
    const result = await q.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM chunk_embeddings e JOIN document_chunks c ON c.id = e.chunk_id WHERE c.document_id = $1`,
      [documentId],
    );
    return result.rows[0]?.n ?? 0;
  },

  /** Exact nearest neighbours inside ONE document and ONE model: no index, no recall loss. */
  async nearest(
    q: Queryable,
    documentId: string,
    model: string,
    query: readonly number[],
    limit: number,
  ): Promise<NearestChunk[]> {
    const result = await q.query<{ id: string; chunk_index: number; score: number }>(
      `SELECT c.id, c.chunk_index, 1 - (e.embedding <=> $1::vector) AS score
       FROM chunk_embeddings e JOIN document_chunks c ON c.id = e.chunk_id
       WHERE c.document_id = $2 AND e.model = $3
       ORDER BY e.embedding <=> $1::vector LIMIT $4`,
      [vectorLiteral(query), documentId, model, limit],
    );
    return result.rows.map((row) => ({ chunkId: row.id, chunkIndex: row.chunk_index, score: row.score }));
  },
};
