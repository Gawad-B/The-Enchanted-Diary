import { normalizeForMatch } from '@enchanted/shared';
import { GUARD_MIN_MATCHES, GUARD_NGRAM_WORDS, GUARD_OVERLAP_RATIO } from './constants.js';

/**
 * The output guard: a last line of defence against a model that has been talked into reciting its instructions.
 * A reply is blocked when
 *  - it contains the per-process canary of the system prompt (in any spacing or case), or a run of 8 or more of its random
 *    characters (a canary copied in pieces, or with its prefix left off, is still a leak), or
 *  - at least GUARD_MIN_MATCHES of its 8-word sequences (a run of about 15 words), and at least GUARD_OVERLAP_RATIO of all of
 *    them, occur in the system prompt. Text the prompt itself tells the model to say or gives as an example (the mandated
 *    sentences, "the uploaded document does not provide enough information") is left out of the comparison, so an honest
 *    answer or refusal that repeats it is never mistaken for a leak.
 * The guard watches the reply as it streams (`check` is cheap), so a recital is cut off after a handful of words
 * instead of after the whole reply.
 */

export interface GuardVerdict {
  reason: 'canary' | 'overlap';
}

const BREAK = '\u0001';
const alphanumeric = (text: string): string => text.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');

function words(text: string): string[] {
  const normalised = normalizeForMatch(text);
  return normalised === '' ? [] : normalised.split(' ');
}

function ngrams(sequence: readonly string[], size: number): string[] {
  const grams: string[] = [];
  for (let start = 0; start + size <= sequence.length; start += 1) {
    const window = sequence.slice(start, start + size);
    if (!window.includes(BREAK)) grams.push(window.join(' '));
  }
  return grams;
}

/** Characters of the canary's random part that count as a leak when they appear in a row. */
const CANARY_FRAGMENT_CHARS = 8;

/** The pieces of the canary whose presence in a reply is a leak: the whole token, and every 8-character run of its random part. */
function canaryPieces(canary: string): string[] {
  if (canary === '') return [];
  const body = canary.startsWith('edcanary') ? canary.slice('edcanary'.length) : canary;
  if (body.length < CANARY_FRAGMENT_CHARS) return [canary];
  const pieces = new Set([canary]);
  for (let start = 0; start + CANARY_FRAGMENT_CHARS <= body.length; start += 1) {
    pieces.add(body.slice(start, start + CANARY_FRAGMENT_CHARS));
  }
  return [...pieces];
}

export class OutputGuard {
  private readonly canary: string;
  private readonly canaryPieces: readonly string[];
  private readonly reference: ReadonlySet<string>;

  constructor(systemPrompt: string, canary: string, allowedPhrases: readonly string[]) {
    this.canary = alphanumeric(canary);
    this.canaryPieces = canaryPieces(this.canary);
    let normalised = normalizeForMatch(systemPrompt);
    // Allowed phrases are cut out and replaced by a break, so no reference n-gram spans one.
    for (const phrase of allowedPhrases) {
      const folded = normalizeForMatch(phrase);
      if (folded !== '') normalised = normalised.replaceAll(folded, ` ${BREAK} `);
    }
    this.reference = new Set(ngrams(normalised.split(' '), GUARD_NGRAM_WORDS));
  }

  /** The verdict for the reply so far, or null when it is clean. */
  check(reply: string): GuardVerdict | null {
    const flat = alphanumeric(reply);
    if (this.canaryPieces.some((piece) => flat.includes(piece))) return { reason: 'canary' };
    const grams = ngrams(words(reply), GUARD_NGRAM_WORDS);
    if (grams.length < GUARD_MIN_MATCHES) return null;
    const matches = grams.filter((gram) => this.reference.has(gram)).length;
    if (matches >= GUARD_MIN_MATCHES && matches / grams.length >= GUARD_OVERLAP_RATIO) {
      return { reason: 'overlap' };
    }
    return null;
  }
}

/** What the visitor is told when the guard replaces a reply (in-world, no detail about why). */
export const OUTPUT_BLOCKED_ANSWER = {
  en: 'The diary will not speak of how it is made. Ask about the manuscript instead.',
  ar: 'لن تتحدث المذكّرة عن كيفية صنعها. اسأل عن المخطوطة بدلاً من ذلك.',
} as const;

export const outputBlockedAnswer = (question: string): string =>
  /\p{Script=Arabic}/u.test(question) ? OUTPUT_BLOCKED_ANSWER.ar : OUTPUT_BLOCKED_ANSWER.en;
