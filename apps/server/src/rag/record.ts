import type { Evidence, RefusedBy } from '@enchanted/shared';
import type { MessageFlags, RetrievalRecord } from '../db/repositories/conversations.js';
import type { LLMProvider } from '../llm/provider.js';
import type { PreparedExcerpt } from './excerpts.js';
import { pagesOf } from './excerpts.js';
import { PROMPT_VERSION } from './prompts.js';
import type { RetrievalTimings } from './retrieve.js';

/** What is stored with an assistant message to explain how it came about (the `retrieval` column). */
export function retrievalRecord(input: {
  query: string;
  rewrittenQuery: string | null;
  evidence: Evidence;
  searchedChunks: number;
  excerpts: readonly PreparedExcerpt[];
  timings: RetrievalTimings;
  generationMs: Record<string, number | null>;
  llm: LLMProvider;
  grounding?: 'yes' | 'no' | 'skipped' | null;
  groundingReason?: string | null;
  groundingError?: string | null;
  rewriteSource?: 'llm' | 'heuristic' | null;
  rewriteReason?: string | null;
  meta?: boolean;
  degraded?: boolean;
}): RetrievalRecord {
  return {
    promptVersion: PROMPT_VERSION,
    query: input.query,
    rewrittenQuery: input.rewrittenQuery,
    evidence: input.evidence,
    searchedChunks: input.searchedChunks,
    retrievedChunks: input.excerpts.length,
    pages: pagesOf(input.excerpts),
    timingsMs: { ...input.timings, ...input.generationMs },
    llm: input.llm.isConfigured() ? { provider: input.llm.name, model: input.llm.model } : null,
    grounding: input.grounding ?? null,
    groundingReason: input.groundingReason ?? null,
    groundingError: input.groundingError ?? null,
    rewriteSource: input.rewriteSource ?? null,
    rewriteReason: input.rewriteReason ?? null,
    ...(input.meta === true ? { meta: true } : {}),
    ...(input.degraded === true ? { degraded: true } : {}),
    chunks: input.excerpts.map((excerpt) => ({
      marker: excerpt.id,
      chunkId: excerpt.chunk.id,
      page: excerpt.chunk.page_start,
      semanticRank: excerpt.retrieved?.semanticRank ?? null,
      lexicalRank: excerpt.retrieved?.lexicalRank ?? null,
      pageRank: excerpt.retrieved?.pageRank ?? null,
      rrfScore: excerpt.retrieved?.rrfScore ?? 0,
      flagged: excerpt.flagged,
    })),
  };
}

/** Safety facts stored with an assistant message. */
export function messageFlags(
  excerpts: readonly PreparedExcerpt[],
  blocked: { reason: string } | null,
  refusedBy: RefusedBy | null = null,
  reply: { truncated?: boolean; finishReason?: string | null; uncitedLinesDropped?: number } = {},
): MessageFlags {
  const flagged = excerpts.filter((excerpt) => excerpt.flagged).map((excerpt) => excerpt.chunk.id);
  return {
    ...(refusedBy === null ? {} : { refusedBy }),
    ...(flagged.length === 0 ? {} : { injectionFlaggedChunks: flagged }),
    ...(blocked === null ? {} : { outputBlocked: true, guardReason: blocked.reason }),
    ...(reply.truncated === true ? { truncated: true } : {}),
    ...(reply.finishReason === undefined || reply.finishReason === null
      ? {}
      : { finishReason: reply.finishReason }),
    ...(reply.uncitedLinesDropped === undefined || reply.uncitedLinesDropped === 0
      ? {}
      : { uncitedLinesDropped: reply.uncitedLinesDropped }),
  };
}
