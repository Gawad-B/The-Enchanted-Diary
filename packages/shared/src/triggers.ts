import { normalizeForMatch } from './text.js';

export interface RevealTrigger {
  text: string;
  lang: 'en' | 'ar';
}

/**
 * Phrases that open the memory reveal. The first six are the original research set (T1 to T6); the rest are the examples from the product spec. The primary line is the only one
 * derived from the film, and it doubles as the diary's own offer line.
 */
export const REVEAL_TRIGGERS: readonly RevealTrigger[] = [
  { text: 'But I can show you...', lang: 'en' },
  { text: 'Show me where you read that.', lang: 'en' },
  { text: 'Open the memory.', lang: 'en' },
  { text: 'Turn back the leaves.', lang: 'en' },
  { text: 'Let the ink remember.', lang: 'en' },
  { text: 'Take me to that page.', lang: 'en' },
  { text: 'Show me what is hidden.', lang: 'en' },
  { text: 'Reveal the secrets.', lang: 'en' },
  { text: 'Show me what lies within.', lang: 'en' },
  { text: 'لكنني أستطيع أن أُريك…', lang: 'ar' },
  { text: 'أرني أين قرأتَ ذلك.', lang: 'ar' },
  { text: 'افتح الذاكرة.', lang: 'ar' },
  { text: 'قلّب الأوراق إلى الوراء.', lang: 'ar' },
  { text: 'دَعِ الحبر يتذكّر.', lang: 'ar' },
  { text: 'خذني إلى تلك الصفحة.', lang: 'ar' },
  { text: 'أرني ما هو مخفي.', lang: 'ar' },
  { text: 'اكشف الأسرار.', lang: 'ar' },
  { text: 'أرني ما يكمن في الداخل.', lang: 'ar' },
];

/** Longest message (in words) that may still match a trigger approximately. */
const MAX_FUZZY_WORDS = 8;
/** Triggers shorter than this must match exactly: one typo would be too large a share of them. */
const MIN_FUZZY_TRIGGER_CHARS = 12;
/** Share of the trigger length that may differ (Levenshtein distance) in an approximate match. */
const FUZZY_TOLERANCE = 0.12;

/** Levenshtein edit distance over Unicode code points. */
export function levenshtein(a: string, b: string): number {
  const left = Array.from(a);
  const right = Array.from(b);
  if (left.length === 0) return right.length;
  if (right.length === 0) return left.length;
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let i = 1; i <= left.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= right.length; j += 1) {
      const substitution = (previous[j - 1] ?? 0) + (left[i - 1] === right[j - 1] ? 0 : 1);
      current.push(Math.min(substitution, (previous[j] ?? 0) + 1, (current[j - 1] ?? 0) + 1));
    }
    previous = current;
  }
  return previous[right.length] ?? 0;
}

const NORMALIZED_TRIGGERS = REVEAL_TRIGGERS.map((trigger) => normalizeForMatch(trigger.text));

/**
 * True when the whole message is a trigger phrase after normalisation, or is a short message that is within
 * about 12% edit distance of one. A longer sentence that merely contains a trigger is a normal question.
 */
export function isRevealTrigger(input: string): boolean {
  const message = normalizeForMatch(input);
  if (message === '') return false;
  if (NORMALIZED_TRIGGERS.includes(message)) return true;
  if (message.split(' ').length > MAX_FUZZY_WORDS) return false;
  return NORMALIZED_TRIGGERS.some((trigger) => {
    const length = Array.from(trigger).length;
    return (
      length >= MIN_FUZZY_TRIGGER_CHARS &&
      levenshtein(message, trigger) <= Math.floor(FUZZY_TOLERANCE * length)
    );
  });
}
