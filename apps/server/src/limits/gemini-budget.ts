import type { Config } from '../config.js';
import type { Queryable } from '../db/client.js';
import { countersRepo } from '../db/repositories/counters.js';
import { DAILY_QUOTA_DETAIL } from '../gemini/index.js';
import { AppError } from '../http/errors.js';
import { nextQuotaReset, pacificDayStart } from './quota-day.js';

/**
 * What the app uses of Gemini, by kind: `llm` (a request that writes an answer), `embed` (a text to be embedded: the free
 * quota counts texts), `ocr` (a request that reads pages), `aux` (a small call around an answer on the auxiliary model: the
 * rewrite of a follow-up question and the grounding check, which have a quota bucket of their own).
 */
export type BudgetKind = 'llm' | 'embed' | 'ocr' | 'aux';

export type BudgetLimits = Record<BudgetKind, number>;

export interface Reservation {
  allowed: boolean;
  /** When the quota starts again (midnight Pacific): where a job refused for lack of budget is parked until. */
  resetAt: Date;
  /**
   * The Pacific day this reservation was taken in. Whatever is given back or added later (`refund`, `charge`) belongs to THIS
   * day, not to the one it happens to be on when it runs: a unit reserved at 23:59:58 and settled at 00:00:03 must not lower
   * the new day's count.
   */
  windowStart: Date;
}

const DAY_MS = 24 * 3_600_000;

/** Limits from the configuration; a kind whose provider is not Gemini has no budget (nothing of it is spent there). */
export function budgetLimitsOf(
  config: Pick<
    Config,
    | 'llmProvider'
    | 'embeddingProvider'
    | 'ocrProvider'
    | 'geminiDailyBudgetLlm'
    | 'geminiDailyBudgetEmbed'
    | 'geminiDailyBudgetOcr'
    | 'geminiDailyBudgetAux'
  >,
): BudgetLimits {
  return {
    llm: config.llmProvider === 'gemini' ? config.geminiDailyBudgetLlm : 0,
    embed: config.embeddingProvider === 'gemini' ? config.geminiDailyBudgetEmbed : 0,
    ocr: config.ocrProvider === 'gemini' ? config.geminiDailyBudgetOcr : 0,
    aux: config.llmProvider === 'gemini' ? config.geminiDailyBudgetAux : 0,
  };
}

/**
 * The daily budgets of the Gemini quotas, counted in the database (all visitors and all instances share the one quota of the
 * owner's Google project). Google does not publish the free-tier numbers, so the app keeps itself under what they are
 * believed to be: a request is reserved here BEFORE it is made, and refused when the day's budget is used up. A limit of 0
 * means no limit (a billed project).
 */
export class GeminiBudgets {
  constructor(
    private readonly db: Queryable,
    private readonly limits: BudgetLimits,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** Takes `amount` of today's budget of `kind`, if it is there. A refusal takes nothing. */
  async reserve(kind: BudgetKind, amount = 1): Promise<Reservation> {
    const now = this.now();
    const limit = this.limits[kind];
    const resetAt = nextQuotaReset(now);
    const windowStart = pacificDayStart(now);
    if (limit <= 0 || amount <= 0) return { allowed: true, resetAt, windowStart };
    const result = await countersRepo.consume(this.db, {
      key: `gemini:${kind}`,
      limit,
      amount,
      windowMs: DAY_MS,
      windowStart,
      now,
    });
    return { allowed: result.allowed, resetAt, windowStart };
  }

  /**
   * Gives back part of today's budget of `kind`: what was taken for a request that was refused before it was made (a
   * question answered 429 DIARY_BUSY, a guard that answered without the model), or that the service itself refused. Of the day
   * the reservation was taken in (`windowStart` of the Reservation); without it, of the day it is now.
   */
  async refund(kind: BudgetKind, amount = 1, windowStart?: Date): Promise<void> {
    if (this.limits[kind] <= 0 || amount <= 0) return;
    await countersRepo.refund(this.db, `gemini:${kind}`, windowStart ?? pacificDayStart(this.now()), amount);
  }

  /**
   * Counts what was used beyond what was reserved (an OCR call that made more requests than it had asked for). Unlike
   * `reserve` it takes the amount even when that goes past the limit: the requests were made, and the next reservation of
   * the day is refused for them.
   */
  async charge(kind: BudgetKind, amount = 1, windowStart?: Date): Promise<void> {
    if (this.limits[kind] <= 0 || amount <= 0) return;
    await countersRepo.add(this.db, `gemini:${kind}`, windowStart ?? pacificDayStart(this.now()), amount);
  }

  /** What the budget of `kind` has used so far of today (or of the day `windowStart` starts); 0 when it has no limit. */
  async used(kind: BudgetKind, windowStart?: Date): Promise<number> {
    if (this.limits[kind] <= 0) return 0;
    return countersRepo.used(this.db, `gemini:${kind}`, windowStart ?? pacificDayStart(this.now()));
  }

  /** `reserve`, throwing the error that tells the visitor the diary has had enough for today (429 RATE_LIMITED). */
  async require(kind: BudgetKind, amount = 1): Promise<void> {
    if (!(await this.reserve(kind, amount)).allowed) throw dailyBudgetError();
  }

  /**
   * One unit of each kind or none: when a later kind is used up, what was taken of the earlier ones is given back (to the day
   * it was taken in). Returns the Pacific day the units were taken in (what a later `refund` or `charge` should be given).
   */
  async requireAll(kinds: readonly BudgetKind[]): Promise<Date> {
    const taken: { kind: BudgetKind; windowStart: Date }[] = [];
    for (const kind of kinds) {
      const reservation = await this.reserve(kind);
      if (!reservation.allowed) {
        for (const earlier of taken) await this.refund(earlier.kind, 1, earlier.windowStart);
        throw dailyBudgetError();
      }
      taken.push({ kind, windowStart: reservation.windowStart });
    }
    return taken[0]?.windowStart ?? pacificDayStart(this.now());
  }
}

/** The error for a used-up daily budget. `detail` is the same curated hint a quota answer of Gemini itself carries. */
export function dailyBudgetError(): AppError {
  return new AppError(
    'RATE_LIMITED',
    'The diary has used up what it may answer and read for today. Try again tomorrow.',
    DAILY_QUOTA_DETAIL,
  );
}
