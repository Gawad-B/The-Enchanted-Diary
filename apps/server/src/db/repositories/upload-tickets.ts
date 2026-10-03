import type { Queryable } from '../client.js';

/** A row of `upload_tickets` (see migration 003). Sizes come back as numbers (a file is at most 2 GiB). */
export interface UploadTicketRow {
  pathname: string;
  session_id: string;
  max_bytes: number;
  issued_at: Date;
  expires_at: Date;
  claimed_at: Date | null;
  document_id: string | null;
  released_at: Date | null;
}

const COLUMNS =
  'pathname, session_id, max_bytes::float8 AS max_bytes, issued_at, expires_at, claimed_at, document_id, released_at';

/**
 * The server-side half of an upload ticket: what makes it usable once. A ticket is `open` until a create call claims it (the
 * document it made is `document_id`) or burns it (the file was refused), or until it expires; the row stays after that so that
 * the same pathname is never accepted twice.
 */
export const uploadTicketsRepo = {
  async issue(
    q: Queryable,
    ticket: { pathname: string; sessionId: string; maxBytes: number; expiresAt: Date },
  ): Promise<void> {
    await q.query(
      'INSERT INTO upload_tickets (pathname, session_id, max_bytes, expires_at) VALUES ($1, $2, $3, $4)',
      [ticket.pathname, ticket.sessionId, ticket.maxBytes, ticket.expiresAt],
    );
  },

  async find(q: Queryable, pathname: string): Promise<UploadTicketRow | null> {
    const result = await q.query<UploadTicketRow>(
      `SELECT ${COLUMNS} FROM upload_tickets WHERE pathname = $1`,
      [pathname],
    );
    return result.rows[0] ?? null;
  },

  /**
   * Whether the session may be given an upload token for this pathname now: the ticket exists, is the session's, has not been
   * claimed and has not expired.
   */
  async isOpenFor(q: Queryable, pathname: string, sessionId: string): Promise<boolean> {
    const result = await q.query(
      `SELECT 1 FROM upload_tickets
       WHERE pathname = $1 AND session_id = $2 AND claimed_at IS NULL AND released_at IS NULL AND expires_at > now()`,
      [pathname, sessionId],
    );
    return result.rowCount > 0;
  },

  /** Uses the ticket for the document: true for the one call that gets it (atomically), false when it was used already. */
  async claim(q: Queryable, pathname: string, sessionId: string, documentId: string): Promise<boolean> {
    const result = await q.query(
      `UPDATE upload_tickets SET claimed_at = now(), document_id = $3
       WHERE pathname = $1 AND session_id = $2 AND claimed_at IS NULL AND released_at IS NULL`,
      [pathname, sessionId, documentId],
    );
    return result.rowCount > 0;
  },

  /**
   * The file of the ticket was refused: the ticket is spent. What it may still bring (`max_bytes`) keeps counting, and the
   * pathname stays in the set the sweep cleans, until the ticket's expiry and the grace after it have passed: the client token
   * that was issued with it can put a blob under this pathname again until then.
   */
  async burn(q: Queryable, pathname: string): Promise<void> {
    await q.query('UPDATE upload_tickets SET claimed_at = now() WHERE pathname = $1 AND claimed_at IS NULL', [
      pathname,
    ]);
  },

  /** The ticket is settled: its blob has been dealt with (deleted, or it is a document's), and it no longer counts. */
  async markReleased(q: Queryable, pathname: string): Promise<void> {
    await q.query(
      'UPDATE upload_tickets SET released_at = now() WHERE pathname = $1 AND released_at IS NULL',
      [pathname],
    );
  },

  /**
   * What the tickets may still bring to the store, in bytes: every ticket that has not been settled yet, used or not. A used
   * ticket's document is counted by its own size as well, for the time the ticket's client token could still put another blob
   * under the same pathname (after the document was deleted, or the file refused).
   */
  async openBytes(q: Queryable): Promise<number> {
    const result = await q.query<{ n: number }>(
      `SELECT COALESCE(SUM(max_bytes), 0)::float8 AS n FROM upload_tickets WHERE released_at IS NULL`,
    );
    return result.rows[0]?.n ?? 0;
  },

  /**
   * Tickets whose expiry is older than `cutoff` and that have not been settled: whatever is at their pathname without a document
   * of its own (a blob nobody claimed, or one put again after its document was deleted) can go.
   */
  async dueBefore(q: Queryable, cutoff: Date, limit: number): Promise<string[]> {
    const result = await q.query<{ pathname: string }>(
      `SELECT pathname FROM upload_tickets
       WHERE released_at IS NULL AND expires_at < $1
       ORDER BY expires_at LIMIT $2`,
      [cutoff, limit],
    );
    return result.rows.map((row) => row.pathname);
  },

  /** Every pathname this database ever issued a ticket for (the only blobs its sweep may delete as orphans). */
  async issuedPathnames(q: Queryable): Promise<Set<string>> {
    const result = await q.query<{ pathname: string }>('SELECT pathname FROM upload_tickets');
    return new Set(result.rows.map((row) => row.pathname));
  },

  /** Removes the rows of tickets that are over (claimed or released) and were issued before `cutoff`. */
  async deleteSettledBefore(q: Queryable, cutoff: Date): Promise<number> {
    const result = await q.query(
      'DELETE FROM upload_tickets WHERE issued_at < $1 AND (claimed_at IS NOT NULL OR released_at IS NOT NULL)',
      [cutoff],
    );
    return result.rowCount;
  },
};
