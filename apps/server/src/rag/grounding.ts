import type { LLMProvider } from '../llm/provider.js';
import { runAuxCall, type AuxFailure } from './aux-call.js';
import { GROUNDING_MAX_TOKENS, GROUNDING_NO_WORDS, GROUNDING_TIMEOUT_MS } from './constants.js';
import type { ExcerptView } from './injection.js';
import { buildGroundingMessages } from './prompts.js';

/**
 * Lab 2's guard 2: after retrieval, one small call to the auxiliary model asks "do these excerpts contain the information
 * needed to answer this question?". A clear "no" refuses the question without the answer model being asked (so a topic
 * that merely shares words with the document cannot be answered from the model's own knowledge); anything else lets it
 * through. The check fails OPEN, exactly like Lab 2's: an error, a timeout, an empty or odd reply are `skipped`, never a
 * refusal, because a flaky check must not turn into refusing every question. It never fails SILENTLY: the result says why
 * it was skipped (`reason`, `error`), and the caller logs it and stores it with the answer.
 */

export type GroundingVerdict = 'yes' | 'no' | 'skipped';

export interface GroundingInput {
  /** The question to ask: the successful rewrite of a follow-up ("it" means nothing to the check), else the question as typed. */
  question: string;
  excerpts: readonly ExcerptView[];
  document: { filename: string };
  /** The language of the question (code), for the template. */
  language?: string;
  signal?: AbortSignal;
  /** A test shortens it. */
  timeoutMs?: number;
}

export interface GroundingResult {
  verdict: GroundingVerdict;
  /** Why the check was skipped; null when it answered. */
  reason: AuxFailure | null;
  error?: { code: string; detail?: string };
}

/** The first word of a reply, lower-cased, without markdown, quotes or punctuation. */
function firstWord(reply: string): string {
  const match = /[\p{L}\p{N}]+/u.exec(reply.trim().replace(/^[*_`"'\s]+/u, ''));
  return (match?.[0] ?? '').toLowerCase();
}

/** Lab 2's rule: refuse only when the reply starts with a "no" word (no, not, or the Arabic la, laysa, ghayr, lam). */
export function parseGroundingReply(reply: string): 'yes' | 'no' {
  return GROUNDING_NO_WORDS.includes(firstWord(reply)) ? 'no' : 'yes';
}

export async function checkGrounding(llm: LLMProvider, input: GroundingInput): Promise<GroundingResult> {
  const prompt = buildGroundingMessages({
    question: input.question,
    excerpts: input.excerpts,
    document: input.document,
    ...(input.language === undefined ? {} : { language: input.language }),
  });
  const result = await runAuxCall(
    llm,
    { system: prompt.system, messages: prompt.messages, maxTokens: GROUNDING_MAX_TOKENS, temperature: 0 },
    {
      ...(input.signal === undefined ? {} : { signal: input.signal }),
      timeoutMs: input.timeoutMs ?? GROUNDING_TIMEOUT_MS,
      // only the first word is read
      enough: (text) => /[\p{L}\p{N}]+[^\p{L}\p{N}]/u.test(text.replace(/^[*_`"'\s]+/u, '')),
    },
  );
  // A bare "No" / "لا" that the output limit cut off (thinking tokens count against it) is still a "no": a complete first word is
  // all the check reads, and a model that spent its tokens must not turn a refusal into a pass.
  if (
    result.failure === 'truncated' &&
    result.text.trim().length <= 12 &&
    parseGroundingReply(result.text) === 'no'
  ) {
    return { verdict: 'no', reason: null };
  }
  if (result.failure !== null) {
    return {
      verdict: 'skipped',
      reason: result.failure,
      ...(result.error === undefined ? {} : { error: result.error }),
    };
  }
  return { verdict: parseGroundingReply(result.text), reason: null };
}
