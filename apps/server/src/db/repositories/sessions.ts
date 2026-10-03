import type { Queryable } from '../client.js';

export const sessionsRepo = {
  async remove(q: Queryable, sessionId: string): Promise<void> {
    await q.query('DELETE FROM sessions WHERE id = $1', [sessionId]);
  },

  /** Removes sessions that have no documents and were last seen before `olderThan`; returns how many. */
  async removeStaleEmpty(q: Queryable, olderThan: Date): Promise<number> {
    const result = await q.query(
      `DELETE FROM sessions s
       WHERE s.last_seen_at < $1 AND NOT EXISTS (SELECT 1 FROM documents d WHERE d.session_id = s.id)`,
      [olderThan],
    );
    return result.rowCount;
  },
};
