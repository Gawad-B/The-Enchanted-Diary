import { BlockedReason, FinishReason, type GenerateContentResponse } from '@google/genai';
import { AppError } from '../http/errors.js';
import { GeminiBlockedError } from './errors.js';

/** Why a candidate stopped when the model did not simply finish: all of these mean "no (more) text, on purpose". */
const BLOCKING_FINISH_REASONS = new Set([
  'SAFETY',
  'PROHIBITED_CONTENT',
  'BLOCKLIST',
  'SPII',
  'RECITATION',
  'IMAGE_SAFETY',
  'LANGUAGE',
  'OTHER',
]);

/**
 * How a candidate ended, in one place for every caller (answers, OCR): `complete` (STOP, or no reason given), `truncated`
 * (the output limit: MAX_TOKENS) or `stopped` (a filter or the model gave up: SAFETY, RECITATION, BLOCKLIST, OTHER, ...).
 * Text that came before a `truncated` or `stopped` end is real but cut off.
 */
export type FinishKind = 'complete' | 'truncated' | 'stopped';

/** The SDK's enum values as the plain strings a response carries. */
const STOP_REASON: string = FinishReason.STOP;
const MAX_TOKENS_REASON: string = FinishReason.MAX_TOKENS;

export function classifyFinishReason(reason: string | undefined): FinishKind {
  if (reason === undefined || reason === STOP_REASON || reason === 'FINISH_REASON_UNSPECIFIED')
    return 'complete';
  // CONTINUATION: the reply stops mid-way and expects to be continued, so what there is, is cut off
  if (reason === MAX_TOKENS_REASON || reason === 'CONTINUATION') return 'truncated';
  return BLOCKING_FINISH_REASONS.has(reason) ? 'stopped' : 'complete';
}

/** The reason a chunk says the PROMPT was blocked, or undefined (an unspecified reason is no block). One rule for every caller. */
export function blockedPromptReason(response: GenerateContentResponse): string | undefined {
  const reason = response.promptFeedback?.blockReason;
  return reason === undefined || reason === BlockedReason.BLOCKED_REASON_UNSPECIFIED ? undefined : reason;
}

/** A finish reason that means "no (more) text, on purpose", for callers that look at one chunk at a time. */
export const isBlockingFinish = (reason: string | undefined): boolean =>
  reason !== undefined && BLOCKING_FINISH_REASONS.has(reason);

export interface GeminiText {
  /** The text of the first candidate (thought summaries left out). */
  text: string;
  /** The model ran out of output tokens: the text is cut off. */
  truncated: boolean;
  /** A filter stopped the answer after some of it: the text is what there was. */
  stoppedEarly: boolean;
}

/**
 * The text of a response, with the model's refusals turned into {@link GeminiBlockedError}: a blocked prompt
 * (`promptFeedback.blockReason`), an answer a filter cut to nothing, or no candidate at all. Reads the parts itself
 * (the SDK's `text` getter warns about non-text parts).
 */
export function geminiText(response: GenerateContentResponse): GeminiText {
  const blockReason = blockedPromptReason(response);
  if (blockReason !== undefined) throw new GeminiBlockedError(blockReason);
  const candidate = response.candidates?.[0];
  if (candidate === undefined) {
    throw new AppError('LLM_FAILED', 'The model returned no answer.', 'no candidates');
  }
  const text = (candidate.content?.parts ?? [])
    .filter((part) => typeof part.text === 'string' && part.thought !== true)
    .map((part) => part.text ?? '')
    .join('');
  const finish = candidate.finishReason ?? FinishReason.STOP;
  if (text.trim() === '' && BLOCKING_FINISH_REASONS.has(finish)) throw new GeminiBlockedError(finish);
  const kind = classifyFinishReason(finish);
  return { text, truncated: kind === 'truncated', stoppedEarly: kind === 'stopped' };
}
