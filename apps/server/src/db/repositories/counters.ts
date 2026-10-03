import type { Queryable } from '../client.js';

export interface ConsumeRequest {
  /** What is counted: `ip:203.0.113.7`, `uploads:<session>`, `gemini:embed`. */
  key: string;
  /** The most the window allows. */
  limit: number;
  /** Length of the fixed window, in milliseconds. */
  windowMs: number;
  /** How much this call uses (items of a quota, not just requests). Default 1. */
  amount?: number;
  /** Replaces "now" (tests, and quotas whose day starts at a fixed hour). */
  now?: Date;
  /** Start of the window this call belongs to; default: `now` rounded down to a multiple of `windowMs`. */
  windowStart?: Date;
}

export interface ConsumeResult {
  allowed: boolean;
  /** When the window ends and the count starts again. */
  resetAt: Date;
  /** Milliseconds until `resetAt` (0 when allowed and nothing waits). */
  retryAfterMs: number;
}

/**
 * Fixed-window counters in the database: the limits of a serverless deployment cannot live in the memory of an
 * instance, which is neither long-lived nor the only one. One atomic statement per call.
 */
export const countersRepo = {
  /**
   * Adds `amount` to the counter of the window and says whether it still fits in `limit`. A call that does not fit
   * changes nothing (so an exhausted quota is not pushed further out of reach by the attempts it refuses).
   */
  async consume(q: Queryable, request: ConsumeRequest): Promise<ConsumeResult> {
    const now = request.now ?? new Date();
    const amount = request.amount ?? 1;
    const windowStartMs =
      request.windowStart?.getTime() ?? Math.floor(now.getTime() / request.windowMs) * request.windowMs;
    const resetAt = new Date(windowStartMs + request.windowMs);
    const refused: ConsumeResult = {
      allowed: false,
      resetAt,
      retryAfterMs: Math.max(0, resetAt.getTime() - now.getTime()),
    };
    // A first insert is not subject to the conflict condition below, so a request bigger than the limit is stopped here.
    if (amount > request.limit) return refused;
    const result = await q.query(
      `INSERT INTO rate_counters (key, window_start, count) VALUES ($1, $2, $3)
       ON CONFLICT (key, window_start) DO UPDATE SET count = rate_counters.count + EXCLUDED.count
         WHERE rate_counters.count + EXCLUDED.count <= $4
       RETURNING count`,
      [request.key, new Date(windowStartMs), amount, request.limit],
    );
    return result.rowCount > 0 ? { allowed: true, resetAt, retryAfterMs: 0 } : refused;
  },

  /** Adds `amount` to the window's counter whatever the limit (usage that already happened). */
  async add(q: Queryable, key: string, windowStart: Date, amount: number): Promise<void> {
    await q.query(
      `INSERT INTO rate_counters (key, window_start, count) VALUES ($1, $2, $3)
       ON CONFLICT (key, window_start) DO UPDATE SET count = rate_counters.count + EXCLUDED.count`,
      [key, windowStart, amount],
    );
  },

  /** Gives back what a call took (a request that was refused after part of it had been counted). Never below 0. */
  async refund(q: Queryable, key: string, windowStart: Date, amount: number): Promise<void> {
    await q.query(
      'UPDATE rate_counters SET count = GREATEST(0, count - $3) WHERE key = $1 AND window_start = $2',
      [key, windowStart, amount],
    );
  },

  /** What the window has used so far (0 when nothing was counted). */
  async used(q: Queryable, key: string, windowStart: Date): Promise<number> {
    const result = await q.query<{ count: number }>(
      'SELECT count FROM rate_counters WHERE key = $1 AND window_start = $2',
      [key, windowStart],
    );
    return result.rows[0]?.count ?? 0;
  },

  /** Removes the counters of windows that ended before `cutoff`; returns how many. */
  async deleteOlderThan(q: Queryable, cutoff: Date): Promise<number> {
    const result = await q.query('DELETE FROM rate_counters WHERE window_start < $1', [cutoff]);
    return result.rowCount;
  },
};
