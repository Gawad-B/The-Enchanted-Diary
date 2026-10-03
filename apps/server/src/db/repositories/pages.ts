import type { PageInfo } from '@enchanted/shared';
import type { Queryable } from '../client.js';

export interface PageRecord {
  pageNumber: number;
  width: number;
  height: number;
  text: string;
  charCount: number;
  language: string;
  direction: 'ltr' | 'rtl';
  extraction: 'text' | 'ocr' | 'empty';
  ocrConfidence: number | null;
}

interface PageInfoRow {
  page_number: number;
  width: number;
  height: number;
  language: string;
  direction: 'ltr' | 'rtl';
  extraction: 'text' | 'ocr' | 'empty';
  char_count: number;
  ocr_confidence: number | null;
}

const FIELDS = 10;
/** Rows per INSERT statement. */
const BATCH = 50;

export const pagesRepo = {
  async insertMany(q: Queryable, documentId: string, pages: readonly PageRecord[]): Promise<void> {
    for (let offset = 0; offset < pages.length; offset += BATCH) {
      const batch = pages.slice(offset, offset + BATCH);
      const params: unknown[] = [];
      const values = batch.map((page, row) => {
        const base = row * FIELDS;
        params.push(
          documentId,
          page.pageNumber,
          page.width,
          page.height,
          page.text,
          page.charCount,
          page.language,
          page.direction,
          page.extraction,
          page.ocrConfidence,
        );
        return `(${Array.from({ length: FIELDS }, (_, i) => `$${String(base + i + 1)}`).join(', ')})`;
      });
      await q.query(
        `INSERT INTO document_pages (document_id, page_number, width, height, text, char_count, language, direction, extraction, ocr_confidence)
         VALUES ${values.join(', ')}`,
        params,
      );
    }
  },

  /** Removes the pages of a document. */
  async removeForDocument(q: Queryable, documentId: string): Promise<void> {
    await q.query('DELETE FROM document_pages WHERE document_id = $1', [documentId]);
  },

  /** Page metadata (no text), in page order. */
  async infos(q: Queryable, documentId: string): Promise<PageInfo[]> {
    const result = await q.query<PageInfoRow>(
      `SELECT page_number, width, height, language, direction, extraction, char_count, ocr_confidence
       FROM document_pages WHERE document_id = $1 ORDER BY page_number`,
      [documentId],
    );
    return result.rows.map((row) => ({
      pageNumber: row.page_number,
      width: row.width,
      height: row.height,
      language: row.language,
      direction: row.direction,
      extraction: row.extraction,
      charCount: row.char_count,
      ocrConfidence: row.ocr_confidence,
    }));
  },

  /** The stored text of the given pages (page number to text). */
  async texts(
    q: Queryable,
    documentId: string,
    pageNumbers: readonly number[],
  ): Promise<Map<number, string>> {
    if (pageNumbers.length === 0) return new Map();
    const result = await q.query<{ page_number: number; text: string }>(
      'SELECT page_number, text FROM document_pages WHERE document_id = $1 AND page_number = ANY($2::int[])',
      [documentId, [...pageNumbers]],
    );
    return new Map(result.rows.map((row) => [row.page_number, row.text]));
  },
};
