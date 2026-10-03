import type { Queryable } from '../client.js';

/**
 * The bulky data the stages of an ingestion job hand to each other (extracted pages, OCR results): one row per
 * (kind, item). Everything here goes when the job ends (and with the document, by cascade).
 */
export const stageDataRepo = {
  /** Writes one item (a page); an item written twice (a tick repeated after a crash) is replaced. */
  async put(q: Queryable, documentId: string, kind: string, item: number, data: unknown): Promise<void> {
    await q.query(
      `INSERT INTO ingest_stage_data (document_id, kind, item, data) VALUES ($1, $2, $3, $4::jsonb)
       ON CONFLICT (document_id, kind, item) DO UPDATE SET data = EXCLUDED.data`,
      [documentId, kind, item, JSON.stringify(data)],
    );
  },

  async get<T>(q: Queryable, documentId: string, kind: string, item: number): Promise<T | null> {
    const result = await q.query<{ data: T }>(
      'SELECT data FROM ingest_stage_data WHERE document_id = $1 AND kind = $2 AND item = $3',
      [documentId, kind, item],
    );
    return result.rows[0]?.data ?? null;
  },

  /** Every item of a kind, in item order. */
  async all<T>(q: Queryable, documentId: string, kind: string): Promise<{ item: number; data: T }[]> {
    const result = await q.query<{ item: number; data: T }>(
      'SELECT item, data FROM ingest_stage_data WHERE document_id = $1 AND kind = $2 ORDER BY item',
      [documentId, kind],
    );
    return result.rows;
  },

  async count(q: Queryable, documentId: string, kind: string): Promise<number> {
    const result = await q.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM ingest_stage_data WHERE document_id = $1 AND kind = $2',
      [documentId, kind],
    );
    return result.rows[0]?.n ?? 0;
  },

  async clear(q: Queryable, documentId: string): Promise<void> {
    await q.query('DELETE FROM ingest_stage_data WHERE document_id = $1', [documentId]);
  },
};
