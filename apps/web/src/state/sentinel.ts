/*
 * The model refuses by writing a sentinel (NOT_IN_DOCUMENT, or a variant) instead of an answer. The server never streams
 * it and sends a refusal in the question's language instead (global section R, ruling 10); if one reaches the browser
 * anyway, the reader must still never see the raw token: the reply is treated as "not found".
 */

const SENTINELS = ['NOT_IN_DOCUMENT', 'NOT_FOUND'] as const;
/** Markdown and bracket noise that may stand in front of a sentinel (`**NOT_FOUND**`, `[[NOT_FOUND]]`, `> NOT_FOUND`). */
const LEADING_NOISE = /^[\s*_`>#"'[(]+/u;

export type SentinelState =
  /** The text does not begin with a sentinel. */
  | 'none'
  /** The text so far could still turn into one (a prefix of one): hold it back for now. */
  | 'maybe'
  /** The text begins with a sentinel: it is a refusal. */
  | 'yes';

/** Whether a reply (or the start of one that is still being written) begins with the refusal sentinel. */
export function leadingSentinel(text: string): SentinelState {
  const upper = text.replace(LEADING_NOISE, '').toUpperCase().replace(/\s+/gu, '_');
  if (upper === '') return 'none';
  for (const sentinel of SENTINELS) {
    if (upper.startsWith(sentinel) && !/^[\p{L}\p{N}]/u.test(upper.slice(sentinel.length))) return 'yes';
  }
  for (const sentinel of SENTINELS) {
    if (upper.length < sentinel.length && sentinel.startsWith(upper)) return 'maybe';
  }
  return 'none';
}
