import { randomUUID } from 'node:crypto';
import type { IngestStage } from '@enchanted/shared';
import type { Db, Queryable } from '../client.js';

/** A row of `ingest_jobs`. The cursor is whatever the ingestion stages keep there (see ingest/cursor.ts). */
export interface IngestJobRow {
  document_id: string;
  stage: IngestStage;
  cursor: unknown;
  lease_id: string | null;
  lease_until: Date | null;
  attempts: number;
  parked_until: Date | null;
  last_error: string | null;
  created_at: Date;
  updated_at: Date;
}

export type AcquireResult =
  /** The tick holds the job now; `lease` is the id every write of the tick must carry. */
  | { kind: 'acquired'; job: IngestJobRow; lease: string }
  /** Another tick holds an unexpired lease. */
  | { kind: 'held'; job: IngestJobRow }
  /** A Gemini daily quota is used up: nothing is attempted before `until`. */
  | { kind: 'parked'; job: IngestJobRow; until: Date }
  /** INGEST_CONCURRENCY other documents are being worked on; this one waits. */
  | { kind: 'busy'; job: IngestJobRow }
  /** There is no job (the document is ready, failed, or gone). */
  | { kind: 'missing' };

const COLUMNS =
  'document_id, stage, cursor, lease_id, lease_until, attempts, parked_until, last_error, created_at, updated_at';

/** Any constant: it only has to be the same in every process that takes leases. */
const LEASE_LOCK_KEY = 727_275;

export interface AcquireOptions {
  /** INGEST_LEASE_MS. */
  leaseMs: number;
  /** INGEST_CONCURRENCY: how many leases may be live at the same time, over all documents. */
  concurrency: number;
}

const leaseUntil = '(now() + make_interval(secs => $2::double precision / 1000.0))';

export const ingestJobsRepo = {
  async create(q: Queryable, documentId: string): Promise<void> {
    await q.query('INSERT INTO ingest_jobs (document_id) VALUES ($1) ON CONFLICT DO NOTHING', [documentId]);
  },

  /**
   * Makes the job of a document that is still being processed and has none (a safety net: a document that is processing
   * always has a job). The document row is read FOR KEY SHARE first, so that a concurrent removal of the document is waited
   * for (and the job is then not made) instead of failing on the foreign key; a document that is ready or failed gets none.
   * True when a job was made.
   */
  async createForProcessing(q: Queryable, documentId: string): Promise<boolean> {
    const result = await q.query(
      `INSERT INTO ingest_jobs (document_id)
       SELECT id FROM documents WHERE id = $1 AND status = 'processing' FOR KEY SHARE
       ON CONFLICT DO NOTHING`,
      [documentId],
    );
    return result.rowCount > 0;
  },

  async find(q: Queryable, documentId: string): Promise<IngestJobRow | null> {
    const result = await q.query<IngestJobRow>(`SELECT ${COLUMNS} FROM ingest_jobs WHERE document_id = $1`, [
      documentId,
    ]);
    return result.rows[0] ?? null;
  },

  /**
   * Takes the lease of a job: atomically, so that of any number of ticks that arrive together exactly one gets it. The
   * decision is made in a transaction under an advisory lock (the concurrency limit counts leases of other rows, which a
   * row lock alone cannot protect). A lease that expired without being given back was a tick that died: it counts as an
   * attempt, so that a document that keeps killing its tick is noticed.
   */
  async acquire(db: Db, documentId: string, options: AcquireOptions): Promise<AcquireResult> {
    return db.transaction(async (tx) => {
      await tx.query('SELECT pg_advisory_xact_lock($1)', [LEASE_LOCK_KEY]);
      const found = await tx.query<IngestJobRow & { leased: boolean; parked: boolean; abandoned: boolean }>(
        `SELECT ${COLUMNS},
                COALESCE(lease_until > now(), false) AS leased,
                COALESCE(parked_until > now(), false) AS parked,
                (lease_until IS NOT NULL AND lease_until <= now()) AS abandoned
         FROM ingest_jobs WHERE document_id = $1`,
        [documentId],
      );
      const job = found.rows[0];
      if (job === undefined) return { kind: 'missing' };
      if (job.leased) return { kind: 'held', job };
      if (job.parked && job.parked_until !== null) return { kind: 'parked', job, until: job.parked_until };
      const others = await tx.query<{ n: number }>(
        'SELECT count(*)::int AS n FROM ingest_jobs WHERE lease_until > now() AND document_id <> $1',
        [documentId],
      );
      if ((others.rows[0]?.n ?? 0) >= options.concurrency) return { kind: 'busy', job };
      const lease = randomUUID();
      const taken = await tx.query<IngestJobRow>(
        `UPDATE ingest_jobs
         SET lease_id = $3, lease_until = ${leaseUntil}, parked_until = NULL,
             attempts = attempts + CASE WHEN $4::boolean THEN 1 ELSE 0 END, updated_at = now()
         WHERE document_id = $1
         RETURNING ${COLUMNS}`,
        [documentId, options.leaseMs, lease, job.abandoned],
      );
      const row = taken.rows[0];
      return row === undefined ? { kind: 'missing' } : { kind: 'acquired', job: row, lease };
    });
  },

  /** Extends the lease. False when the job is gone or the lease is no longer this tick's (the tick must stop). */
  async renew(q: Queryable, documentId: string, lease: string, leaseMs: number): Promise<boolean> {
    const result = await q.query(
      `UPDATE ingest_jobs SET lease_until = ${leaseUntil}
       WHERE document_id = $1 AND lease_id = $3`,
      [documentId, leaseMs, lease],
    );
    return result.rowCount > 0;
  },

  /**
   * Saves where the job stands, and renews the lease. A clean save also ends the run of failed ticks (`attempts` is 0
   * again), unless it is only a label (`keepAttempts`: the stage was named before the work that may fail began, which is
   * not progress). False when the lease is no longer this tick's.
   */
  async save(
    q: Queryable,
    documentId: string,
    lease: string,
    state: { stage: IngestStage; cursor: unknown },
    leaseMs: number,
    options: { keepAttempts?: boolean } = {},
  ): Promise<boolean> {
    const result = await q.query(
      `UPDATE ingest_jobs
       SET stage = $4, cursor = $5::jsonb, attempts = CASE WHEN $6::boolean THEN attempts ELSE 0 END,
           lease_until = ${leaseUntil}, updated_at = now()
       WHERE document_id = $1 AND lease_id = $3`,
      [documentId, leaseMs, lease, state.stage, JSON.stringify(state.cursor), options.keepAttempts === true],
    );
    return result.rowCount > 0;
  },

  /** Gives the lease back (the next tick may take it at once). */
  async release(q: Queryable, documentId: string, lease: string): Promise<void> {
    await q.query(
      `UPDATE ingest_jobs SET lease_until = NULL, lease_id = NULL, updated_at = now()
       WHERE document_id = $1 AND lease_id = $2`,
      [documentId, lease],
    );
  },

  /**
   * A tick that was stopped at its hard limit gives the lease back and counts as an attempt (a lease that expires does the
   * same: a document that keeps outlasting its tick is noticed), and what it worked is not lost: `workMs` (and the time OCR
   * spent, when the job is reading with OCR) are written into the cursor without touching anything else in it. False when the
   * lease was no longer this tick's.
   */
  async releaseAborted(
    q: Queryable,
    documentId: string,
    lease: string,
    spent: { workMs: number; ocrSpentMs?: number },
  ): Promise<boolean> {
    const result = await q.query(
      `UPDATE ingest_jobs
       SET cursor = CASE WHEN $4::float8 IS NOT NULL AND cursor ? 'ocr'
                         THEN jsonb_set(jsonb_set(cursor, '{workMs}', to_jsonb($3::float8)), '{ocr,spentMs}', to_jsonb($4::float8))
                         ELSE jsonb_set(cursor, '{workMs}', to_jsonb($3::float8)) END,
           attempts = attempts + 1, lease_until = NULL, lease_id = NULL, updated_at = now()
       WHERE document_id = $1 AND lease_id = $2`,
      [
        documentId,
        lease,
        Math.round(spent.workMs),
        spent.ocrSpentMs === undefined ? null : Math.round(spent.ocrSpentMs),
      ],
    );
    return result.rowCount > 0;
  },

  /**
   * A tick failed for a reason that may pass (the database or the store did not answer, the service is rate limiting): the
   * count of such ticks in a row goes up by one, written into the cursor without touching the rest of it (a unit of work that
   * is saved resets it). The count is of ONE cause (`kind`): a different cause than the last tick's starts again at 1, so that
   * "three ticks in a row" means three of the same trouble. Returns the new count, or null when the lease is no longer this
   * tick's.
   */
  async recordTransient(
    q: Queryable,
    documentId: string,
    lease: string,
    kind: string,
  ): Promise<number | null> {
    const result = await q.query<{ n: number }>(
      `UPDATE ingest_jobs
       SET cursor = jsonb_set(
             jsonb_set(
               cursor, '{transient}',
               to_jsonb(CASE WHEN cursor->>'transientCause' = $3
                             THEN COALESCE((cursor->>'transient')::int, 0) + 1 ELSE 1 END)),
             '{transientCause}', to_jsonb($3::text)),
           updated_at = now()
       WHERE document_id = $1 AND lease_id = $2
       RETURNING (cursor->>'transient')::int AS n`,
      [documentId, lease, kind],
    );
    return result.rows[0]?.n ?? null;
  },

  /** Stops the job until `until` and gives the lease back. False when the lease was no longer this tick's. */
  async park(q: Queryable, documentId: string, lease: string, until: Date, detail: string): Promise<boolean> {
    const result = await q.query(
      `UPDATE ingest_jobs
       SET parked_until = $3, last_error = $4, lease_until = NULL, lease_id = NULL, updated_at = now()
       WHERE document_id = $1 AND lease_id = $2`,
      [documentId, lease, until, detail],
    );
    return result.rowCount > 0;
  },

  async remove(q: Queryable, documentId: string): Promise<void> {
    await q.query('DELETE FROM ingest_jobs WHERE document_id = $1', [documentId]);
  },

  /**
   * Jobs that are being read: not parked, and touched within `activeWithinMs` (a job whose reader went away stays a
   * `processing` document until it expires, but it no longer occupies a place in the line). The jobs of `exceptSessionId`
   * are not counted: a visitor who replaces the document they are waiting for is not made to wait behind it.
   */
  async countActive(
    q: Queryable,
    activeWithinMs: number,
    exceptSessionId: string | null = null,
  ): Promise<number> {
    const result = await q.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM ingest_jobs j JOIN documents d ON d.id = j.document_id
       WHERE (j.parked_until IS NULL OR j.parked_until <= now())
         AND j.updated_at > now() - make_interval(secs => $1::double precision / 1000.0)
         AND ($2::uuid IS NULL OR d.session_id <> $2)`,
      [activeWithinMs, exceptSessionId],
    );
    return result.rows[0]?.n ?? 0;
  },

  /** 1-based place of the job among the jobs that wait for a lease, oldest first. */
  async queuePosition(q: Queryable, documentId: string, activeWithinMs: number): Promise<number> {
    const result = await q.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM ingest_jobs j
       WHERE j.document_id <> $1
         AND (j.lease_until IS NULL OR j.lease_until <= now())
         AND (j.parked_until IS NULL OR j.parked_until <= now())
         AND j.updated_at > now() - make_interval(secs => $2::double precision / 1000.0)
         AND j.created_at < (SELECT created_at FROM ingest_jobs WHERE document_id = $1)`,
      [documentId, activeWithinMs],
    );
    return (result.rows[0]?.n ?? 0) + 1;
  },
};
