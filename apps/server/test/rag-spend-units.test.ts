import { ApiError, type GenerateContentResponse } from '@google/genai';
import { describe, expect, it } from 'vitest';
import { GeminiPacer } from '../src/gemini/index.js';
import { NO_QUOTA_DETAIL } from '../src/gemini/index.js';
import type { BudgetKind, GeminiBudgets } from '../src/limits/gemini-budget.js';
import { GeminiLlmProvider } from '../src/llm/gemini.js';
import { LlmError } from '../src/llm/provider.js';
import type { RagDeps } from '../src/rag/answer.js';
import { AnswerSpend } from '../src/rag/spend.js';
import { FakeEmbeddings } from './doubles/fake-embeddings.js';
import { ScriptedLlm, failing } from './doubles/scripted-llm.js';
import { GeminiEmbeddings } from '../src/embeddings/gemini.js';
import { EmbeddingError } from '../src/embeddings/provider.js';

/*
 * The small rules of what a question costs of the daily budgets (review m-1 to m-4 of the budgets lens, global §R.6b), on a stand-in
 * for the budgets that records every reservation and every give-back. The routes' own behaviour is in rag-spend.test.ts.
 */

class RecordingBudgets {
  /** What is held now, over all days. */
  readonly taken: Record<BudgetKind, number> = { llm: 0, aux: 0, embed: 0, ocr: 0 };
  /** What is held, by Pacific day (the key is the day's start). */
  readonly byDay = new Map<string, Record<BudgetKind, number>>();
  readonly events: string[] = [];
  limit: Partial<Record<BudgetKind, number>> = {};
  failOn: BudgetKind | null = null;
  failRefund = false;
  /** The Pacific day it is now: a reservation belongs to it, and says so (`windowStart`). */
  day = new Date('2026-10-03T07:00:00Z');

  private bucket(day: Date): Record<BudgetKind, number> {
    const key = day.toISOString();
    let counts = this.byDay.get(key);
    if (counts === undefined) {
      counts = { llm: 0, aux: 0, embed: 0, ocr: 0 };
      this.byDay.set(key, counts);
    }
    return counts;
  }

  /** What `kind` holds on the day that starts at `day`. */
  of(kind: BudgetKind, day: Date): number {
    return this.bucket(day)[kind];
  }

  reserve(kind: BudgetKind): Promise<{ allowed: boolean; resetAt: Date; windowStart: Date }> {
    this.events.push(`reserve ${kind}`);
    if (this.failOn === kind) return Promise.reject(new Error('the database is down'));
    const allowed = (this.limit[kind] ?? Infinity) > this.taken[kind];
    if (allowed) {
      this.taken[kind] += 1;
      this.bucket(this.day)[kind] += 1;
    }
    return Promise.resolve({ allowed, resetAt: new Date(), windowStart: this.day });
  }

  refund(kind: BudgetKind, amount = 1, windowStart?: Date): Promise<void> {
    this.events.push(`refund ${kind}`);
    if (this.failRefund) return Promise.reject(new Error('the database is down'));
    this.taken[kind] -= amount;
    this.bucket(windowStart ?? this.day)[kind] -= amount;
    return Promise.resolve();
  }

  charge(kind: BudgetKind, amount = 1, windowStart?: Date): Promise<void> {
    this.events.push(`charge ${kind} ${String(amount)}`);
    this.taken[kind] += amount;
    this.bucket(windowStart ?? this.day)[kind] += amount;
    return Promise.resolve();
  }
}

const asBudgets = (budgets: RecordingBudgets): GeminiBudgets => budgets as unknown as GeminiBudgets;
const deps = (llm: RagDeps['llm']): RagDeps =>
  ({
    llm,
    embeddings: new FakeEmbeddings(),
    log: { warn: () => undefined, error: () => undefined },
  }) as unknown as RagDeps;

const drain = async (stream: AsyncIterable<string>): Promise<void> => {
  for await (const piece of stream) expect(piece).toBeTypeOf('string');
};

describe('reserve() (m-3)', () => {
  it('gives back what it took when a later reservation throws, and when one is refused', async () => {
    const budgets = new RecordingBudgets();
    budgets.failOn = 'embed';
    const spend = new AnswerSpend(asBudgets(budgets), 'ask');
    await expect(spend.reserve()).rejects.toThrow('the database is down');
    expect(budgets.taken).toMatchObject({ llm: 0, embed: 0 });
    budgets.failOn = null;
    budgets.limit = { embed: 0 };
    await expect(new AnswerSpend(asBudgets(budgets), 'ask').reserve()).rejects.toMatchObject({
      code: 'RATE_LIMITED',
    });
    expect(budgets.taken).toMatchObject({ llm: 0, embed: 0 });
  });
});

describe('settle() (m-2)', () => {
  it('does its giving back once: a second call is a no-op and cannot wipe another visitor’s reservation', async () => {
    const budgets = new RecordingBudgets();
    const spend = new AnswerSpend(asBudgets(budgets), 'reveal');
    await spend.reserve();
    await spend.reserve().catch(() => undefined); // another unit, as another visitor's would be
    expect(budgets.taken.llm).toBe(2);
    await spend.settle();
    await spend.settle();
    expect(budgets.taken.llm).toBe(1); // only this question's unit went back, once
  });
});

describe('a request counts when it is sent, not when it is asked for (m-1)', () => {
  const okChunk = {
    candidates: [{ content: { parts: [{ text: 'ok' }] } }],
  } as unknown as GenerateContentResponse;
  const client = {
    models: {
      generateContentStream: () =>
        Promise.resolve(
          (async function* () {
            await Promise.resolve();
            yield okChunk;
          })(),
        ),
    },
  };

  it('gives the unit back when the visitor leaves while the call waits for its slot', async () => {
    const pacer = new GeminiPacer({ maxPerMinute: 1 });
    expect(pacer.tryAcquire()).toBe(0); // the only slot of the minute is taken
    const provider = new GeminiLlmProvider({
      apiKey: 'k',
      model: 'gemini-3.5-flash-lite',
      auxModel: 'gemini-3.1-flash-lite',
      client,
      pacer,
    });
    const budgets = new RecordingBudgets();
    const spend = new AnswerSpend(asBudgets(budgets), 'reveal');
    await spend.reserve();
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 40);
    const counted = spend.wrap(deps(provider)).llm;
    await expect(
      drain(
        counted.stream({
          system: 's',
          messages: [{ role: 'user', content: 'q' }],
          maxTokens: 10,
          temperature: 0,
          signal: controller.signal,
        }),
      ),
    ).rejects.toMatchObject({ name: 'AbortError' });
    await spend.settle();
    expect(budgets.taken.llm).toBe(0); // reserved, never sent, given back
  });

  it('keeps the unit when the request did leave', async () => {
    const provider = new GeminiLlmProvider({
      apiKey: 'k',
      model: 'gemini-3.5-flash-lite',
      auxModel: '',
      client,
    });
    const budgets = new RecordingBudgets();
    const spend = new AnswerSpend(asBudgets(budgets), 'reveal');
    await spend.reserve();
    await drain(
      spend.wrap(deps(provider)).llm.stream({
        system: 's',
        messages: [{ role: 'user', content: 'q' }],
        maxTokens: 10,
        temperature: 0,
      }),
    );
    await spend.settle();
    expect(budgets.taken.llm).toBe(1);
  });

  it('gives back an auxiliary unit whose request never left (the visitor went away in the queue)', async () => {
    const pacer = new GeminiPacer({ maxPerMinute: 1 });
    pacer.tryAcquire();
    const provider = new GeminiLlmProvider({ apiKey: 'k', model: 'm', auxModel: 'a', client, pacer });
    const budgets = new RecordingBudgets();
    const spend = new AnswerSpend(asBudgets(budgets), 'ask');
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 40);
    await expect(
      drain(
        spend.wrap(deps(provider)).llm.stream({
          system: 's',
          messages: [{ role: 'user', content: 'q' }],
          maxTokens: 10,
          temperature: 0,
          tier: 'auxiliary',
          signal: controller.signal,
        }),
      ),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(budgets.taken.aux).toBe(0); // reserved at the start, given back: nothing was sent
  });

  it('charges an embedding only when a request was made: not for a provider with no key, yes for one the service failed', async () => {
    const run = async (error: Error): Promise<number> => {
      const budgets = new RecordingBudgets();
      const spend = new AnswerSpend(asBudgets(budgets), 'ask');
      await spend.reserve();
      const wrapped = spend.wrap({
        ...deps(new ScriptedLlm()),
        embeddings: { model: 'x', embedQuery: () => Promise.reject(error) },
      });
      await expect(wrapped.embeddings.embedQuery('q')).rejects.toBe(error);
      await spend.settle();
      return budgets.taken.embed;
    };
    expect(await run(new EmbeddingError('no key', { unconfigured: true }))).toBe(0);
    expect(await run(new EmbeddingError('503', { retryable: true }))).toBe(1);
  });
});

describe('a request the service itself refused is given back (m-4, ruling R.6b)', () => {
  const refusals: [string, () => LlmError][] = [
    ['a per-minute 429 that outlasted the retries', () => new LlmError('RATE_LIMITED', 'busy')],
    ['a used-up daily quota', () => new LlmError('RATE_LIMITED', 'daily', { detail: 'daily quota reached' })],
    ['a model with no quota', () => new LlmError('LLM_UNAVAILABLE', 'none', { detail: NO_QUOTA_DETAIL })],
  ];

  it.each(refusals)('gives back the answer request after %s, before the first chunk', async (_name, make) => {
    const budgets = new RecordingBudgets();
    const spend = new AnswerSpend(asBudgets(budgets), 'reveal');
    await spend.reserve();
    const llm = new ScriptedLlm([
      {
        when: () => true,
        reply: () =>
          (async function* () {
            await Promise.resolve();
            throw make();
            yield '';
          })(),
      },
    ]);
    await expect(
      drain(
        spend.wrap(deps(llm)).llm.stream({
          system: 's',
          messages: [{ role: 'user', content: 'q' }],
          maxTokens: 10,
          temperature: 0,
        }),
      ),
    ).rejects.toBeInstanceOf(LlmError);
    await spend.settle();
    expect(budgets.taken.llm).toBe(0);
  });

  it('gives back the auxiliary request the same way', async () => {
    const budgets = new RecordingBudgets();
    const spend = new AnswerSpend(asBudgets(budgets), 'reveal');
    const llm = new ScriptedLlm([{ when: () => true, reply: failing('RATE_LIMITED', 'busy') }]);
    await expect(
      drain(
        spend.wrap(deps(llm)).llm.stream({
          system: 's',
          messages: [{ role: 'user', content: 'q' }],
          maxTokens: 10,
          temperature: 0,
          tier: 'auxiliary',
        }),
      ),
    ).rejects.toBeInstanceOf(LlmError);
    expect(budgets.taken.aux).toBe(0);
  });

  it('keeps the charge for any other failure, for a refusal after the first chunk, and for a timeout', async () => {
    for (const make of [
      () => new LlmError('LLM_UNAVAILABLE', 'down'),
      () => new LlmError('LLM_FAILED', 'blocked'),
      () => new LlmError('LLM_UNAVAILABLE', 'slow', { detail: 'timeout' }),
    ]) {
      const budgets = new RecordingBudgets();
      const spend = new AnswerSpend(asBudgets(budgets), 'reveal');
      await spend.reserve();
      const llm = new ScriptedLlm([
        {
          when: () => true,
          reply: () =>
            (async function* () {
              await Promise.resolve();
              throw make();
              yield '';
            })(),
        },
      ]);
      await drain(
        spend.wrap(deps(llm)).llm.stream({
          system: 's',
          messages: [{ role: 'user', content: 'q' }],
          maxTokens: 10,
          temperature: 0,
        }),
      ).catch(() => undefined);
      await spend.settle();
      expect(budgets.taken.llm).toBe(1);
    }
    const budgets = new RecordingBudgets();
    const spend = new AnswerSpend(asBudgets(budgets), 'reveal');
    await spend.reserve();
    const llm = new ScriptedLlm([
      {
        when: () => true,
        reply: () =>
          (async function* () {
            await Promise.resolve();
            yield 'Alaric';
            throw new LlmError('RATE_LIMITED', 'late');
          })(),
      },
    ]);
    await drain(
      spend.wrap(deps(llm)).llm.stream({
        system: 's',
        messages: [{ role: 'user', content: 'q' }],
        maxTokens: 10,
        temperature: 0,
      }),
    ).catch(() => undefined);
    await spend.settle();
    expect(budgets.taken.llm).toBe(1); // the service had answered: the request was spent
  });
});

describe('a unit belongs to the Pacific day it was reserved in (budgets review N-1, global S.7 / NB-15)', () => {
  const before = new Date('2026-10-03T07:00:00Z'); // the day that ends at midnight Pacific
  const after = new Date('2026-10-04T07:00:00Z'); // the day after
  const request = {
    system: 's',
    messages: [{ role: 'user' as const, content: 'q' }],
    maxTokens: 10,
    temperature: 0,
  };

  it('gives back to the old day, not to the new one, what a question reserved before midnight and did not use', async () => {
    const budgets = new RecordingBudgets();
    budgets.day = before;
    const first = new AnswerSpend(asBudgets(budgets), 'ask');
    await first.reserve();
    budgets.day = after;
    const second = new AnswerSpend(asBudgets(budgets), 'ask');
    await second.reserve(); // another visitor's question, in flight on the new day
    // the first one was stopped by the evidence gate: it embedded its question and asked no model
    await first.wrap(deps(new ScriptedLlm())).embeddings.embedQuery('q');
    await first.settle();
    expect(budgets.of('llm', before)).toBe(0); // given back where it was taken
    expect(budgets.of('llm', after)).toBe(1); // the other visitor's unit is still there
    expect(budgets.of('embed', before)).toBe(1); // the embedding was spent
    expect(budgets.of('embed', after)).toBe(1);
  });

  it('charges what was used beyond the reservation to the day of the reservation too', async () => {
    const budgets = new RecordingBudgets();
    budgets.day = before;
    const spend = new AnswerSpend(asBudgets(budgets), 'ask');
    await spend.reserve();
    const embeddings = spend.wrap(deps(new ScriptedLlm())).embeddings;
    budgets.day = after;
    await embeddings.embedQuery('one');
    await embeddings.embedQuery('two');
    await embeddings.embedQuery('three');
    await spend.settle();
    expect(budgets.of('embed', before)).toBe(3);
    expect(budgets.of('embed', after)).toBe(0);
  });

  it('gives back the reservations of a question refused part-way to the day they were taken in', async () => {
    const budgets = new RecordingBudgets();
    budgets.day = before;
    budgets.limit = { embed: 0 };
    const spend = new AnswerSpend(asBudgets(budgets), 'ask');
    // (the second kind is used up: the first is given back, to the day it came from, even though the clock has moved)
    const reserving = spend.reserve();
    budgets.day = after;
    await expect(reserving).rejects.toMatchObject({ code: 'RATE_LIMITED' });
    expect(budgets.of('llm', before)).toBe(0);
    expect(budgets.of('llm', after)).toBe(0);
  });

  it('gives an auxiliary unit back to the day it was reserved in, when the service refuses the request after midnight', async () => {
    const budgets = new RecordingBudgets();
    budgets.day = before;
    const spend = new AnswerSpend(asBudgets(budgets), 'reveal');
    const llm = new ScriptedLlm([
      {
        when: () => true,
        reply: () => {
          budgets.day = after; // midnight passes while the request is out
          return failing('RATE_LIMITED', 'busy')();
        },
      },
    ]);
    await expect(
      drain(spend.wrap(deps(llm)).llm.stream({ ...request, tier: 'auxiliary' })),
    ).rejects.toBeInstanceOf(LlmError);
    expect(budgets.of('aux', before)).toBe(0);
    expect(budgets.of('aux', after)).toBe(0); // (the new day is not touched: it never held this unit)
    expect(budgets.taken.aux).toBe(0);
  });

  it('keeps an auxiliary unit of the old day charged, and the new day clean, when the request was spent', async () => {
    const budgets = new RecordingBudgets();
    budgets.day = before;
    const spend = new AnswerSpend(asBudgets(budgets), 'reveal');
    const reservation = await spend.reserveAux();
    expect(reservation.windowStart).toEqual(before);
    budgets.day = after;
    await spend.giveBackAux(reservation.windowStart);
    expect(budgets.of('aux', before)).toBe(0);
    expect(budgets.of('aux', after)).toBe(0);
  });
});

describe('a unit that cannot be given back is said, not swallowed (budgets review n-3)', () => {
  const warnings = (): { warn: (object: object, message: string) => void; messages: string[] } => {
    const messages: string[] = [];
    return { messages, warn: (_object, message) => void messages.push(message) };
  };

  it('logs the give-back of a reservation that failed part-way, and still throws the first error', async () => {
    const budgets = new RecordingBudgets();
    budgets.failOn = 'embed';
    budgets.failRefund = true; // the database is down altogether
    const log = warnings();
    const spend = new AnswerSpend(asBudgets(budgets), 'ask', log);
    await expect(spend.reserve()).rejects.toThrow('the database is down');
    expect(log.messages).toEqual(['a unit of the daily budget could not be given back']);
  });

  it('logs the give-back of an auxiliary unit the service refused', async () => {
    const budgets = new RecordingBudgets();
    const log = warnings();
    const spend = new AnswerSpend(asBudgets(budgets), 'reveal', log);
    budgets.failRefund = true;
    const llm = new ScriptedLlm([{ when: () => true, reply: failing('RATE_LIMITED', 'busy') }]);
    await expect(
      drain(
        spend.wrap(deps(llm)).llm.stream({
          system: 's',
          messages: [{ role: 'user', content: 'q' }],
          maxTokens: 10,
          temperature: 0,
          tier: 'auxiliary',
        }),
      ),
    ).rejects.toBeInstanceOf(LlmError);
    expect(log.messages).toEqual(['a unit of the daily budget could not be given back']);
  });

  it('logs a settling that failed (as before), through the logger given to the spend', async () => {
    const budgets = new RecordingBudgets();
    const log = warnings();
    const spend = new AnswerSpend(asBudgets(budgets), 'ask', log);
    await spend.reserve();
    budgets.failRefund = true;
    await spend.settle(); // nothing was used: both units go back, and the database is down
    expect(log.messages).toEqual(['the daily budget could not be settled']);
  });
});

describe('an embedding counts when its request leaves, not when it is asked for (budgets review m-1, the embedder)', () => {
  const embedding = { embeddings: [{ values: [3, 4] }] };
  const make = (calls: { n: number }, pacer?: GeminiPacer): GeminiEmbeddings =>
    new GeminiEmbeddings({
      apiKey: 'k',
      model: 'gemini-embedding-2',
      dimensions: 2,
      batchSize: 100,
      ...(pacer === undefined ? {} : { pacer }),
      client: {
        models: {
          embedContent: () => {
            calls.n += 1;
            return Promise.resolve(embedding);
          },
        },
      },
    });
  /** The embedding spent for one question asked through `embeddings`, after settling. */
  const spentBy = async (
    embeddings: GeminiEmbeddings,
    signal?: AbortSignal,
  ): Promise<{ spent: number; outcome: 'ok' | 'failed' }> => {
    const budgets = new RecordingBudgets();
    const spend = new AnswerSpend(asBudgets(budgets), 'ask');
    await spend.reserve();
    const wrapped = spend.wrap({ ...deps(new ScriptedLlm()), embeddings });
    const outcome = await wrapped.embeddings.embedQuery('q', signal).then(
      () => 'ok' as const,
      () => 'failed' as const,
    );
    await spend.settle();
    return { spent: budgets.taken.embed, outcome };
  };

  it('counts a request that was made', async () => {
    const calls = { n: 0 };
    expect(await spentBy(make(calls))).toEqual({ spent: 1, outcome: 'ok' });
    expect(calls.n).toBe(1);
  });

  it('counts nothing when the visitor had already gone: no request left', async () => {
    const calls = { n: 0 };
    const controller = new AbortController();
    controller.abort();
    expect(await spentBy(make(calls), controller.signal)).toEqual({ spent: 0, outcome: 'failed' });
    expect(calls.n).toBe(0);
  });

  it('counts nothing when the visitor goes away while the text waits for its slot of the embedding pacer', async () => {
    const calls = { n: 0 };
    const pacer = new GeminiPacer({ maxPerMinute: 1 });
    expect(pacer.tryAcquire()).toBe(0); // the minute's only slot is taken
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 40);
    expect(await spentBy(make(calls, pacer), controller.signal)).toEqual({ spent: 0, outcome: 'failed' });
    expect(calls.n).toBe(0);
  });

  it('announces the send once, however often the request is retried', async () => {
    let attempts = 0;
    const embeddings = new GeminiEmbeddings({
      apiKey: 'k',
      model: 'gemini-embedding-2',
      dimensions: 2,
      batchSize: 100,
      retry: { maxAttempts: 3, baseDelayMs: 1 },
      client: {
        models: {
          embedContent: () => {
            attempts += 1;
            return attempts < 3
              ? Promise.reject(
                  new ApiError({
                    status: 503,
                    message: JSON.stringify({ error: { code: 503, status: 'UNAVAILABLE' } }),
                  }),
                )
              : Promise.resolve(embedding);
          },
        },
      },
    });
    const sent: string[] = [];
    await embeddings.embedQuery('q', undefined, { onSent: () => void sent.push('sent') });
    expect(attempts).toBe(3);
    expect(sent).toEqual(['sent']);
  });

  it('counts a request the service failed after it left (the visitor’s own abort, in flight, is a request too)', async () => {
    const budgets = new RecordingBudgets();
    const spend = new AnswerSpend(asBudgets(budgets), 'ask');
    await spend.reserve();
    const wrapped = spend.wrap({
      ...deps(new ScriptedLlm()),
      embeddings: {
        model: 'x',
        reportsSend: true,
        embedQuery: (_text: string, _signal?: AbortSignal, options?: { onSent?: () => void }) => {
          options?.onSent?.();
          return Promise.reject(new DOMException('aborted', 'AbortError'));
        },
      },
    });
    await expect(wrapped.embeddings.embedQuery('q')).rejects.toMatchObject({ name: 'AbortError' });
    await spend.settle();
    expect(budgets.taken.embed).toBe(1);
  });
});
