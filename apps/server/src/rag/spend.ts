import type { EmbeddingProvider, QueryOptions } from '../embeddings/provider.js';
import { DAILY_QUOTA_DETAIL, NO_QUOTA_DETAIL } from '../gemini/index.js';
import { ANSWER_SPENDING } from '../limits/answer-budgets.js';
import { dailyBudgetError, type BudgetKind, type GeminiBudgets } from '../limits/gemini-budget.js';
import { LlmError, type LLMProvider, type LlmRequest } from '../llm/provider.js';
import type { RagDeps } from './answer.js';

/*
 * What one question or reveal spends of the daily Gemini budgets (the quotas are per Google project, counted in the database).
 *
 *  - `reserve()` takes the budgets of the route (answer model, embedded text) once the question is ACCEPTED: after the document
 *    is known to be the session's and ready, the body parsed and the session's one in-flight answer taken (a question refused
 *    with DIARY_BUSY, or an invalid one, costs nothing). A used-up budget is a 429 RATE_LIMITED before any stream opens; a
 *    database error half way gives back what was already taken.
 *  - the small calls around an answer (the follow-up rewrite, the grounding check) cannot be known in advance: each is reserved
 *    on the `aux` budget where it is made, and a used-up aux budget is that call failing (the pipeline goes on without it, and
 *    says so in the stored record), never the question refused.
 *  - a request counts as SPENT when it has actually been sent (a provider that reports the send, Gemini's, says so after its queue:
 *    a visitor who leaves while the call waits for its slot spent nothing) or, for a provider that cannot tell, when it starts.
 *  - a request the SERVICE itself refused before the first chunk (a per-minute 429 that outlasted the retries, a used-up daily
 *    quota, a model with no quota: global §R.6b) is given back, as the ingestion does for a refused batch; any other failure
 *    stays charged (the request was made).
 *  - `settle()` gives back what was reserved and not spent: a question the evidence gate stopped, a meta question that was not
 *    embedded, a reveal with no passages made no request to Gemini; and counts the embeddings made beyond the one reserved. It
 *    does it once: a second call does nothing.
 *  The pipeline is given providers that count what it asks of them (`wrap`).
 */
export class AnswerSpend {
  private readonly used: Record<BudgetKind, number> = { llm: 0, aux: 0, embed: 0, ocr: 0 };
  /** The Pacific day each kind was reserved in: what is given back or added later belongs to THAT day (global §S.7, NB-15). */
  private readonly days = new Map<BudgetKind, Date>();
  private reserved = false;

  constructor(
    private readonly budgets: GeminiBudgets | undefined,
    private readonly route: keyof typeof ANSWER_SPENDING,
    /** Where a unit that could not be given back is said (it is otherwise invisible: the day's count stays one too high). */
    private readonly log?: Logger,
  ) {}

  /** What the route reserves up front. */
  private get kinds(): readonly BudgetKind[] {
    return ANSWER_SPENDING[this.route];
  }

  /** Takes the route's budgets (all or none); throws the 429 for a used-up day, and gives back what it took on any failure. */
  async reserve(): Promise<void> {
    const budgets = this.budgets;
    if (budgets === undefined) return;
    const taken = new Map<BudgetKind, Date | undefined>();
    try {
      for (const kind of this.kinds) {
        const reservation = await budgets.reserve(kind);
        if (!reservation.allowed) throw dailyBudgetError();
        taken.set(kind, reservation.windowStart);
      }
    } catch (error) {
      for (const [kind, windowStart] of taken) await this.giveBack(kind, windowStart);
      throw error;
    }
    for (const [kind, windowStart] of taken) if (windowStart !== undefined) this.days.set(kind, windowStart);
    this.reserved = true;
  }

  /** One unit of `kind` back to the day it was taken in; a failure is logged, never thrown (the answer is what matters). */
  private async giveBack(kind: BudgetKind, windowStart: Date | undefined): Promise<void> {
    try {
      await this.budgets?.refund(kind, 1, windowStart);
    } catch (error) {
      this.log?.warn({ err: error, kind }, 'a unit of the daily budget could not be given back');
    }
  }

  /** The pipeline's providers, counting (and, for the small calls, reserving) what the pipeline asks of them. */
  wrap(deps: RagDeps): RagDeps {
    return {
      ...deps,
      llm: new CountedLlm(deps.llm, this),
      embeddings: new CountedEmbeddings(deps.embeddings, this),
    };
  }

  /** @internal a request of this kind has been sent (or is taken to have been). */
  sent(kind: 'llm' | 'embed' | 'aux'): void {
    this.used[kind] += 1;
  }

  /**
   * @internal an auxiliary call is about to start: its unit of the aux budget (and the Pacific day it was taken in, which a give-back
   * must name), or `allowed: false` when the day's budget is used up.
   */
  async reserveAux(): Promise<{ allowed: boolean; windowStart?: Date | undefined }> {
    if (this.budgets === undefined) return { allowed: true };
    const { allowed, windowStart } = await this.budgets.reserve('aux');
    return { allowed, windowStart };
  }

  /** @internal an auxiliary call that never sent a request (its visitor left in the queue), or that the service refused. */
  async giveBackAux(windowStart?: Date): Promise<void> {
    await this.giveBack('aux', windowStart);
  }

  /** @internal the service refused an answer-model request before its first chunk: it is not spent. */
  refusedLlm(): void {
    this.used.llm = Math.max(0, this.used.llm - 1);
  }

  /** Gives back what was taken and not used, charges what was used beyond it. Never throws: the answer is already written. */
  async settle(log: Logger | undefined = this.log): Promise<void> {
    if (this.budgets === undefined || !this.reserved) return;
    this.reserved = false;
    try {
      for (const kind of this.kinds) {
        const day = this.days.get(kind);
        if (this.used[kind] === 0) await this.budgets.refund(kind, 1, day);
        else if (this.used[kind] > 1) await this.budgets.charge(kind, this.used[kind] - 1, day);
      }
    } catch (error) {
      log?.warn({ err: error }, 'the daily budget could not be settled');
    }
  }
}

interface Logger {
  warn(object: object, message: string): void;
}

/** Whether the service itself turned the request down: a rate limit that outlasted the retries, a daily quota, no quota at all. */
const refusedByService = (error: unknown): boolean =>
  error instanceof LlmError &&
  (error.code === 'RATE_LIMITED' || (error.code === 'LLM_UNAVAILABLE' && error.detail === NO_QUOTA_DETAIL));

class CountedLlm implements LLMProvider {
  readonly name: string;
  readonly model: string;
  readonly handlesTimeout?: boolean | undefined;
  readonly reportsSend?: boolean | undefined;

  constructor(
    private readonly inner: LLMProvider,
    private readonly spend: AnswerSpend,
  ) {
    this.name = inner.name;
    this.model = inner.model;
    this.handlesTimeout = inner.handlesTimeout;
    this.reportsSend = inner.reportsSend;
  }

  isConfigured(): boolean {
    return this.inner.isConfigured();
  }

  async *stream(request: LlmRequest): AsyncGenerator<string> {
    const kind = request.tier === 'auxiliary' ? 'aux' : 'llm';
    // (the Pacific day of the unit of an auxiliary call: its give-back, however late, goes to that day)
    let auxDay: Date | undefined;
    if (kind === 'aux') {
      const reservation = await this.spend.reserveAux();
      if (!reservation.allowed) {
        throw new LlmError('RATE_LIMITED', 'The daily request limit of the small model has been reached.', {
          detail: DAILY_QUOTA_DETAIL,
        });
      }
      auxDay = reservation.windowStart;
    }
    // a provider that reports the send does so when the request leaves (after its queue); one that cannot tell is taken to send at once
    let sent = this.inner.reportsSend !== true;
    if (sent) this.spend.sent(kind);
    let gotChunk = false;
    let refunded = false;
    try {
      for await (const chunk of this.inner.stream({
        ...request,
        onSent: () => {
          if (!sent) {
            sent = true;
            this.spend.sent(kind);
          }
          request.onSent?.();
        },
      })) {
        gotChunk = true;
        yield chunk;
      }
    } catch (error) {
      if (!gotChunk && sent && refusedByService(error)) {
        refunded = true;
        if (kind === 'aux') await this.spend.giveBackAux(auxDay);
        else this.spend.refusedLlm();
      }
      throw error;
    } finally {
      // an auxiliary call whose request never left (the visitor went away in the queue): its unit goes back
      if (!sent && kind === 'aux' && !refunded) await this.spend.giveBackAux(auxDay);
    }
  }
}

type CountableEmbeddings = Pick<EmbeddingProvider, 'model' | 'embedQuery' | 'reportsSend'>;

class CountedEmbeddings implements CountableEmbeddings {
  readonly model: string;
  readonly reportsSend?: boolean | undefined;

  constructor(
    private readonly inner: CountableEmbeddings,
    private readonly spend: AnswerSpend,
  ) {
    this.model = inner.model;
    this.reportsSend = inner.reportsSend;
  }

  async embedQuery(text: string, signal?: AbortSignal, options: QueryOptions = {}): Promise<number[]> {
    // a provider that reports the send does so when the request leaves (after the embedding queue and before the first attempt):
    // a visitor who goes away while it waits for its slot spent nothing. One that cannot tell is taken to send at once, except that
    // a provider with no key sent nothing either.
    const reports = this.inner.reportsSend === true;
    let sent = false;
    const count = (): void => {
      if (sent) return;
      sent = true;
      this.spend.sent('embed');
    };
    try {
      const vector = await this.inner.embedQuery(text, signal, {
        ...options,
        onSent: () => {
          count();
          options.onSent?.();
        },
      });
      count();
      return vector;
    } catch (error) {
      if (
        !reports &&
        !(error instanceof Error && (error as Error & { unconfigured?: boolean }).unconfigured === true)
      ) {
        count();
      }
      throw error;
    }
  }
}
