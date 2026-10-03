import type {
  DocumentDetail,
  DocumentSummary,
  DocumentWarning,
  ErrorCode,
  IngestStage,
  PageInfo,
} from '@enchanted/shared';
import type { Queryable } from '../client.js';

/** A row of `documents`. Dates come back as Date objects from both drivers, JSON columns as parsed values. */
export interface DocumentRow {
  id: string;
  session_id: string;
  filename: string;
  byte_size: number;
  sha256: string;
  page_count: number;
  status: 'processing' | 'ready' | 'failed';
  stage: IngestStage;
  error_code: ErrorCode | null;
  error_detail: string | null;
  primary_language: string;
  direction: 'ltr' | 'rtl';
  languages: { code: string; share: number }[];
  sections: { title: string; page: number }[];
  warnings: DocumentWarning[];
  storage_key: string;
  progress_completed: number;
  progress_total: number;
  progress_unit: 'pages' | 'chunks' | 'bytes' | 'steps' | 'queue';
  progress_detail: string | null;
  created_at: Date;
  updated_at: Date;
  expires_at: Date;
}

export interface NewDocument {
  id: string;
  sessionId: string;
  filename: string;
  byteSize: number;
  sha256: string;
  pageCount: number;
  storageKey: string;
  expiresAt: Date;
}

export interface ReadyDocument {
  primaryLanguage: string;
  direction: 'ltr' | 'rtl';
  languages: { code: string; share: number }[];
  sections: { title: string; page: number }[];
  warnings: DocumentWarning[];
  pageCount: number;
}

/** The progress of a processing document, as stored in its row (see `ProgressEvent` in the contract). */
export interface ProgressRecord {
  stage: IngestStage;
  completed: number;
  total: number;
  unit: DocumentRow['progress_unit'];
  detail?: string | null;
}

export interface Retention {
  /** DOCUMENT_RETENTION_HOURS: how long a document lives after it was last used. */
  hours: number;
  /** DOCUMENT_MAX_RETENTION_HOURS: the absolute cap, counted from creation. */
  maxHours: number;
}

const COLUMNS = `id, session_id, filename, byte_size, sha256, page_count, status, stage, error_code, error_detail,
  primary_language, direction, languages, sections, warnings, storage_key, progress_completed, progress_total,
  progress_unit, progress_detail, created_at, updated_at, expires_at`;

const iso = (value: Date | string): string => (value instanceof Date ? value : new Date(value)).toISOString();

export function toDocumentSummary(row: DocumentRow): DocumentSummary {
  return {
    id: row.id,
    filename: row.filename,
    byteSize: row.byte_size,
    pageCount: row.page_count,
    status: row.status,
    stage: row.stage,
    primaryLanguage: row.primary_language,
    direction: row.direction,
    createdAt: iso(row.created_at),
    expiresAt: iso(row.expires_at),
  };
}

/** The API shape of a document: its row plus the page infos and chunk count that live in other tables. */
export function toDocumentDetail(row: DocumentRow, pages: PageInfo[], chunkCount: number): DocumentDetail {
  return {
    ...toDocumentSummary(row),
    languages: row.languages,
    pages,
    warnings: row.warnings,
    sections: row.sections,
    chunkCount,
    ...(row.error_code === null
      ? {}
      : {
          error: {
            code: row.error_code,
            message: row.error_detail ?? 'The document could not be processed.',
          },
        }),
  };
}

/** Expiry of a document touched now: the retention window from now, never past the cap counted from creation. */
const SLIDING_EXPIRY = `LEAST(now() + make_interval(secs => $2::double precision), created_at + make_interval(secs => $3::double precision))`;
/** An access refreshes the expiry at most this often (seconds): the window slides, not on every request. */
const MIN_REFRESH_SECONDS = 60;

export const documentsRepo = {
  async insert(q: Queryable, document: NewDocument): Promise<DocumentRow> {
    const result = await q.query<DocumentRow>(
      `INSERT INTO documents (id, session_id, filename, byte_size, sha256, page_count, status, stage, storage_key, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, 'processing', 'queued', $7, $8)
       RETURNING ${COLUMNS}`,
      [
        document.id,
        document.sessionId,
        document.filename,
        document.byteSize,
        document.sha256,
        document.pageCount,
        document.storageKey,
        document.expiresAt,
      ],
    );
    const row = result.rows[0];
    if (row === undefined) throw new Error('INSERT INTO documents returned no row');
    return row;
  },

  async findById(q: Queryable, id: string): Promise<DocumentRow | null> {
    const result = await q.query<DocumentRow>(`SELECT ${COLUMNS} FROM documents WHERE id = $1`, [id]);
    return result.rows[0] ?? null;
  },

  /** A document of this session, or null (also for another session's document: it does not exist for you). */
  async findForSession(q: Queryable, id: string, sessionId: string): Promise<DocumentRow | null> {
    const result = await q.query<DocumentRow>(
      `SELECT ${COLUMNS} FROM documents WHERE id = $1 AND session_id = $2 AND expires_at > now()`,
      [id, sessionId],
    );
    return result.rows[0] ?? null;
  },

  /** A document of this session even when its expiry has passed (to delete it). */
  async findOwned(q: Queryable, id: string, sessionId: string): Promise<DocumentRow | null> {
    const result = await q.query<DocumentRow>(
      `SELECT ${COLUMNS} FROM documents WHERE id = $1 AND session_id = $2`,
      [id, sessionId],
    );
    return result.rows[0] ?? null;
  },

  /** The session's newest ready or processing document that has not expired; never a failed one. */
  async latestForSession(q: Queryable, sessionId: string): Promise<DocumentRow | null> {
    const result = await q.query<DocumentRow>(
      `SELECT ${COLUMNS} FROM documents
       WHERE session_id = $1 AND status IN ('ready', 'processing') AND expires_at > now()
       ORDER BY created_at DESC LIMIT 1`,
      [sessionId],
    );
    return result.rows[0] ?? null;
  },

  async listForSession(q: Queryable, sessionId: string): Promise<DocumentRow[]> {
    const result = await q.query<DocumentRow>(
      `SELECT ${COLUMNS} FROM documents WHERE session_id = $1 ORDER BY created_at DESC`,
      [sessionId],
    );
    return result.rows;
  },

  async listProcessingForSession(q: Queryable, sessionId: string): Promise<DocumentRow[]> {
    const result = await q.query<DocumentRow>(
      `SELECT ${COLUMNS} FROM documents WHERE session_id = $1 AND status = 'processing'`,
      [sessionId],
    );
    return result.rows;
  },

  /**
   * Sliding expiry: an access moves `expires_at` to now + retention, capped at created_at + the maximum. Only
   * written when that would extend it by more than a minute. Returns the document's current expiry.
   */
  async touch(q: Queryable, id: string, retention: Retention): Promise<Date | null> {
    const result = await q.query<{ expires_at: Date }>(
      `UPDATE documents SET expires_at = ${SLIDING_EXPIRY}
       WHERE id = $1 AND expires_at + make_interval(secs => ${String(MIN_REFRESH_SECONDS)}) < ${SLIDING_EXPIRY}
       RETURNING expires_at`,
      [id, retention.hours * 3600, retention.maxHours * 3600],
    );
    if (result.rows[0] !== undefined) return result.rows[0].expires_at;
    const current = await q.query<{ expires_at: Date }>('SELECT expires_at FROM documents WHERE id = $1', [
      id,
    ]);
    return current.rows[0]?.expires_at ?? null;
  },

  /**
   * Records how far the job of a processing document has come: the stage and the real counts of its unit, which is what
   * whoever polls the document is shown. False when the document is no longer processing (removed, or ended meanwhile),
   * or, when `lease` is given, when that lease is no longer the job's (a tick that lost its lease writes nothing).
   */
  async setProgress(
    q: Queryable,
    id: string,
    progress: ProgressRecord,
    lease: string | null = null,
  ): Promise<boolean> {
    const result = await q.query(
      `UPDATE documents
       SET stage = $2, progress_completed = $3, progress_total = $4, progress_unit = $5, progress_detail = $6,
           updated_at = now()
       WHERE id = $1 AND status = 'processing'
         AND ($7::uuid IS NULL OR EXISTS (SELECT 1 FROM ingest_jobs WHERE document_id = $1 AND lease_id = $7))`,
      [id, progress.stage, progress.completed, progress.total, progress.unit, progress.detail ?? null, lease],
    );
    return result.rowCount > 0;
  },

  /** What the analysis found, written as soon as it is known (the client lays the closed book out by `direction`). */
  async setAnalysis(
    q: Queryable,
    id: string,
    analysis: Pick<ReadyDocument, 'primaryLanguage' | 'direction' | 'languages' | 'sections'>,
  ): Promise<void> {
    await q.query(
      `UPDATE documents SET primary_language = $2, direction = $3, languages = $4::jsonb, sections = $5::jsonb
       WHERE id = $1 AND status = 'processing'`,
      [
        id,
        analysis.primaryLanguage,
        analysis.direction,
        JSON.stringify(analysis.languages),
        JSON.stringify(analysis.sections),
      ],
    );
  },

  /**
   * The direction of the document, as soon as the analysis knows it (before the rest of the analysis is stored). Held to the
   * lease like every write of a tick.
   */
  async setDirection(
    q: Queryable,
    id: string,
    direction: 'ltr' | 'rtl',
    lease: string | null = null,
  ): Promise<void> {
    await q.query(
      `UPDATE documents SET direction = $2
       WHERE id = $1 AND status = 'processing'
         AND ($3::uuid IS NULL OR EXISTS (SELECT 1 FROM ingest_jobs WHERE document_id = $1 AND lease_id = $3))`,
      [id, direction, lease],
    );
  },

  /** Marks a document ready. False when it is no longer processing (removed, or failed meanwhile). */
  async markReady(q: Queryable, id: string, ready: ReadyDocument): Promise<boolean> {
    const result = await q.query(
      `UPDATE documents SET status = 'ready', stage = 'ready', error_code = NULL, error_detail = NULL,
         page_count = $2, primary_language = $3, direction = $4, languages = $5::jsonb, sections = $6::jsonb,
         warnings = $7::jsonb, progress_completed = 1, progress_total = 1, progress_unit = 'steps',
         progress_detail = NULL, updated_at = now()
       WHERE id = $1 AND status = 'processing'`,
      [
        id,
        ready.pageCount,
        ready.primaryLanguage,
        ready.direction,
        JSON.stringify(ready.languages),
        JSON.stringify(ready.sections),
        JSON.stringify(ready.warnings),
      ],
    );
    return result.rowCount > 0;
  },

  async markFailed(q: Queryable, id: string, code: ErrorCode, detail: string): Promise<boolean> {
    const result = await q.query(
      `UPDATE documents SET status = 'failed', stage = 'failed', error_code = $2, error_detail = $3, updated_at = now()
       WHERE id = $1 AND status = 'processing'`,
      [id, code, detail],
    );
    return result.rowCount > 0;
  },

  /** Removes one document row (pages, chunks and embeddings follow by cascade); null when there was none. */
  async remove(q: Queryable, id: string): Promise<{ storageKey: string } | null> {
    const result = await q.query<{ storage_key: string }>(
      'DELETE FROM documents WHERE id = $1 RETURNING storage_key',
      [id],
    );
    const row = result.rows[0];
    return row === undefined ? null : { storageKey: row.storage_key };
  },

  /**
   * Removes the session's documents that are still being read, except `exceptId` (the one being made: a retry of its own
   * creation must not remove it); returns what was removed so that the files can go too.
   */
  async removeProcessingForSession(
    q: Queryable,
    sessionId: string,
    exceptId: string | null,
  ): Promise<{ id: string; storageKey: string }[]> {
    const result = await q.query<{ id: string; storage_key: string }>(
      `DELETE FROM documents WHERE session_id = $1 AND status = 'processing' AND ($2::uuid IS NULL OR id <> $2)
       RETURNING id, storage_key`,
      [sessionId, exceptId],
    );
    return result.rows.map((row) => ({ id: row.id, storageKey: row.storage_key }));
  },

  /** Removes all documents of a session; returns what was removed so the files can go too. */
  async removeForSession(q: Queryable, sessionId: string): Promise<{ id: string; storageKey: string }[]> {
    const result = await q.query<{ id: string; storage_key: string }>(
      'DELETE FROM documents WHERE session_id = $1 RETURNING id, storage_key',
      [sessionId],
    );
    return result.rows.map((row) => ({ id: row.id, storageKey: row.storage_key }));
  },

  /** The ids of the documents whose expiry has passed (so their jobs can be stopped before their rows go). */
  async expiredIds(q: Queryable, now: Date): Promise<string[]> {
    const result = await q.query<{ id: string }>('SELECT id FROM documents WHERE expires_at < $1', [now]);
    return result.rows.map((row) => row.id);
  },

  /** Removes the documents whose expiry has passed; returns them so their files can be removed too. */
  async removeExpired(q: Queryable, now: Date): Promise<{ id: string; storageKey: string }[]> {
    const result = await q.query<{ id: string; storage_key: string }>(
      'DELETE FROM documents WHERE expires_at < $1 RETURNING id, storage_key',
      [now],
    );
    return result.rows.map((row) => ({ id: row.id, storageKey: row.storage_key }));
  },

  /** Which of the given storage keys a document row points at. */
  async existingStorageKeys(q: Queryable, keys: readonly string[]): Promise<Set<string>> {
    if (keys.length === 0) return new Set();
    const result = await q.query<{ storage_key: string }>(
      'SELECT storage_key FROM documents WHERE storage_key = ANY($1::text[])',
      [[...keys]],
    );
    return new Set(result.rows.map((row) => row.storage_key));
  },

  /** Which of the given ids have a row. */
  async existingIds(q: Queryable, ids: readonly string[]): Promise<Set<string>> {
    if (ids.length === 0) return new Set();
    const result = await q.query<{ id: string }>('SELECT id FROM documents WHERE id = ANY($1::uuid[])', [
      [...ids],
    ]);
    return new Set(result.rows.map((row) => row.id));
  },

  /** The bytes of every stored document (what the Blob store holds for this database, give or take failed ones). */
  async totalBytes(q: Queryable): Promise<number> {
    const result = await q.query<{ n: number }>(
      'SELECT COALESCE(SUM(byte_size), 0)::float8 AS n FROM documents',
    );
    return result.rows[0]?.n ?? 0;
  },

  /** Every storage key a document row points at (to recognise orphan files). */
  async allStorageKeys(q: Queryable): Promise<Set<string>> {
    const result = await q.query<{ storage_key: string }>('SELECT storage_key FROM documents');
    return new Set(result.rows.map((row) => row.storage_key));
  },
};
