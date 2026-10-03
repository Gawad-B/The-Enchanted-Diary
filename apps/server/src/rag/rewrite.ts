import type { LLMProvider, LlmMessage } from '../llm/provider.js';
import { runAuxCall, type AuxFailure } from './aux-call.js';
import { MARKER_SOURCE, REWRITE_MAX_CHARS, REWRITE_MAX_TOKENS, REWRITE_TIMEOUT_MS } from './constants.js';
import { normalizeQuery } from './query.js';
import { SENTINEL_TOKENS } from './sentinel.js';
import { buildRewriteMessages } from './prompts.js';

/**
 * Follow-up questions ("What evidence supports it?") cannot be searched as they are: "it" means nothing to an index.
 * With history, the language model writes a standalone query (retrieval only, never shown as an answer); when it is
 * not available, too slow (REWRITE_TIMEOUT_MS) or answers with something unusable, the previous question and the
 * new one are joined, which keeps the subject in the search. Without history the question is searched as typed.
 */

/** The fallback rewrite: `${previousUserQuestion} ${question}`. */
export function heuristicRewrite(previousQuestion: string, question: string): string {
  return normalizeQuery(`${previousQuestion} ${question}`);
}

/** The model's output as a search query: one line, no quotes, labels, markers or sentinel; null when nothing usable is left. */
export function cleanRewrite(output: string): string | null {
  const line = output
    .split(/\r?\n/u)
    .map((candidate) => candidate.trim())
    .find((candidate) => candidate !== '');
  // A reply that says "not found" is an answer, not a query.
  if (line === undefined || /not[\s_-]*(?:found|in[\s_-]*document)/iu.test(line)) return null;
  const QUOTES = /^["'\u{201C}\u{201D}\u{2018}\u{2019}`*_\s]+|["'\u{201C}\u{201D}\u{2018}\u{2019}`*_\s]+$/gu;
  const cleaned = normalizeQuery(
    line
      .replace(QUOTES, '')
      .replace(/^(?:standalone\s+)?(?:search\s+)?(?:query|question)\s*[:\u{FF1A}]\s*/iu, '')
      .replace(new RegExp(MARKER_SOURCE, 'gu'), '')
      .replace(SENTINEL_TOKENS, '')
      .replace(QUOTES, ''),
  );
  if (cleaned === '') return null;
  if (cleaned.length <= REWRITE_MAX_CHARS) return cleaned;
  const cut = cleaned.slice(0, REWRITE_MAX_CHARS);
  return cut.slice(0, Math.max(cut.lastIndexOf(' '), REWRITE_MAX_CHARS / 2)).trimEnd();
}

export interface RewriteInput {
  question: string;
  /** Earlier turns, as prompt turns (never empty here: the caller rewrites only when there is history). */
  history: readonly LlmMessage[];
  previousQuestion: string;
  /** Aborts the rewrite along with the request. */
  signal?: AbortSignal;
  /** How long the model may take once the request is sent (REWRITE_TIMEOUT_MS; a test shortens it). */
  timeoutMs?: number;
}

export interface RewriteResult {
  /** The query to embed for the semantic search. */
  query: string;
  /**
   * `llm`: the model wrote it, so its words and pages may count as the question's. `heuristic`: the fallback join of the two
   * questions: it feeds the semantic search only (the previous question must not decide what this one is about).
   */
  source: 'llm' | 'heuristic';
  /** Why the model's rewrite was not used. */
  reason: AuxFailure | 'unusable' | null;
  error?: { code: string; detail?: string };
}

/** The standalone query for a follow-up. Never throws except for the request's own abort. */
export async function rewriteQuery(llm: LLMProvider, input: RewriteInput): Promise<RewriteResult> {
  const fallback = heuristicRewrite(input.previousQuestion, input.question);
  const prompt = buildRewriteMessages({ question: input.question, history: input.history });
  const result = await runAuxCall(
    llm,
    {
      system: prompt.system,
      messages: prompt.messages,
      maxTokens: REWRITE_MAX_TOKENS,
      temperature: 0,
    },
    {
      ...(input.signal === undefined ? {} : { signal: input.signal }),
      timeoutMs: input.timeoutMs ?? REWRITE_TIMEOUT_MS,
      // one line is all that is wanted
      enough: (text) => text.length > REWRITE_MAX_CHARS * 4 || /\S\s*\n/u.test(text),
    },
  );
  if (result.failure !== null) {
    return {
      query: fallback,
      source: 'heuristic',
      reason: result.failure,
      ...(result.error === undefined ? {} : { error: result.error }),
    };
  }
  const cleaned = cleanRewrite(result.text);
  return cleaned === null
    ? { query: fallback, source: 'heuristic', reason: 'unusable' }
    : { query: cleaned, source: 'llm', reason: null };
}
