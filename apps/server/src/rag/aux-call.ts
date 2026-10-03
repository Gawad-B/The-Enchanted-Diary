import { LlmError, type LLMProvider, type LlmRequest } from '../llm/provider.js';

/*
 * The small calls around an answer (the follow-up rewrite, the grounding check) run on the auxiliary model and are ADVICE:
 * when one fails, the pipeline goes on without it. That is the design (Lab 2's check fails open), but never silently: every
 * failure comes back with its reason, and the caller logs it and stores it with the answer. A failure that is the visitor
 * going away is not a failure of the call: it is rethrown.
 */

/** Why an auxiliary call gave no usable answer. */
export type AuxFailure =
  /** It took longer than allowed, counted from the moment the request was sent (never the wait in the pacer's queue). */
  | 'timeout'
  /** The provider failed (rate limit, quota, outage, a retired model): the code is kept in `error`. */
  | 'error'
  /** It answered with nothing (a model that spent its tokens thinking, a filter). */
  | 'empty'
  /** The output limit cut it off (thinking tokens count): half a query or half a verdict is no answer. */
  | 'truncated';

export interface AuxCallResult {
  text: string;
  failure: AuxFailure | null;
  /** The failure's code and curated detail, for the log and the stored record. */
  error?: { code: string; detail?: string };
}

export interface AuxCallOptions {
  /** The visitor's signal: aborting it ends the call and is rethrown. */
  signal?: AbortSignal;
  /** How long the call may take once it is sent. */
  timeoutMs: number;
  /** Stops reading as soon as this says the text so far is enough (the first word of a yes/no, the first line of a query). */
  enough?: (text: string) => boolean;
}

/** Runs an auxiliary request and reads its reply; never throws except for the visitor going away. */
export async function runAuxCall(
  llm: LLMProvider,
  request: Omit<LlmRequest, 'tier' | 'signal' | 'timeoutMs'>,
  options: AuxCallOptions,
): Promise<AuxCallResult> {
  // A provider that starts the clock itself (Gemini: at the send, after its queue) is given the time; any other gets a
  // deadline on the signal, counted from now.
  const deadline = llm.handlesTimeout === true ? undefined : AbortSignal.timeout(options.timeoutMs);
  const signal =
    deadline === undefined
      ? options.signal
      : options.signal === undefined
        ? deadline
        : AbortSignal.any([options.signal, deadline]);
  let text = '';
  const reply = { cutOff: false };
  let enough = false;
  try {
    for await (const chunk of llm.stream({
      ...request,
      tier: 'auxiliary',
      ...(signal === undefined ? {} : { signal }),
      ...(deadline === undefined ? { timeoutMs: options.timeoutMs } : {}),
      onFinish: (info) => {
        reply.cutOff = info.truncated;
      },
    })) {
      text += chunk;
      if (options.enough?.(text) === true) {
        enough = true;
        break;
      }
    }
  } catch (error) {
    if (options.signal?.aborted === true) throw error;
    if (deadline?.aborted === true) return { text, failure: 'timeout' };
    if (error instanceof LlmError) {
      return {
        text,
        failure: error.detail === 'timeout' ? 'timeout' : 'error',
        error: { code: error.code, ...(error.detail === undefined ? {} : { detail: error.detail }) },
      };
    }
    return { text, failure: 'error', error: { code: error instanceof Error ? error.name : 'unknown' } };
  }
  if (deadline?.aborted === true) return { text, failure: 'timeout' };
  if (text.trim() === '') return { text, failure: 'empty' };
  // a reply the output limit cut off (and that did not already say enough) is not an answer: a half-written query would count
  // as the model's rewrite, which pages and words are then read from
  return { text, failure: reply.cutOff && !enough ? 'truncated' : null };
}
