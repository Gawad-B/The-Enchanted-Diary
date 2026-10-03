import { describe, expect, it } from 'vitest';
import { REVEAL_TRIGGERS, isRevealTrigger, levenshtein } from '../src/index.js';

describe('REVEAL_TRIGGERS', () => {
  it('has the six research triggers and the spec examples in English and Arabic', () => {
    const english = REVEAL_TRIGGERS.filter((trigger) => trigger.lang === 'en').map((trigger) => trigger.text);
    const arabic = REVEAL_TRIGGERS.filter((trigger) => trigger.lang === 'ar').map((trigger) => trigger.text);
    expect(english).toHaveLength(9);
    expect(arabic).toHaveLength(9);
    expect(english).toEqual(
      expect.arrayContaining([
        'But I can show you...',
        'Show me what is hidden.',
        'Reveal the secrets.',
        'Show me what lies within.',
      ]),
    );
    expect(arabic).toEqual(
      expect.arrayContaining(['أرني ما هو مخفي.', 'اكشف الأسرار.', 'أرني ما يكمن في الداخل.']),
    );
  });
});

describe('isRevealTrigger', () => {
  it.each(REVEAL_TRIGGERS.map((trigger) => [trigger.lang, trigger.text] as const))(
    'matches the %s trigger %j exactly, in other cases and with other punctuation',
    (_lang, text) => {
      expect(isRevealTrigger(text)).toBe(true);
      expect(isRevealTrigger(`  ${text.toUpperCase()}  `)).toBe(true);
      expect(isRevealTrigger(text.replace(/[.…]+$/u, ''))).toBe(true);
      expect(isRevealTrigger(`"${text.replace(/[.…]+$/u, '')}!"`)).toBe(true);
      expect(isRevealTrigger(text.split(' ').join('   '))).toBe(true);
    },
  );

  it('treats "...", ".." and "…" alike', () => {
    expect(isRevealTrigger('But I can show you...')).toBe(true);
    expect(isRevealTrigger('but i can show you..')).toBe(true);
    expect(isRevealTrigger('But I can show you…')).toBe(true);
    expect(isRevealTrigger('لكنني أستطيع أن أريك...')).toBe(true);
    expect(isRevealTrigger('لكنني أستطيع أن أريك…')).toBe(true);
  });

  it('matches Arabic regardless of diacritics, alef forms and tatweel', () => {
    expect(isRevealTrigger('ارني ما هو مخفي')).toBe(true);
    expect(isRevealTrigger('أَرِنِي مَا هُوَ مَخْفِيّ')).toBe(true);
    expect(isRevealTrigger('لكنني استطيع ان اريك')).toBe(true);
    expect(isRevealTrigger('دع الحبر يتذكر')).toBe(true);
    expect(isRevealTrigger('افتــح الذاكرة')).toBe(true);
  });

  it('matches the spec examples', () => {
    expect(isRevealTrigger('Show me what is hidden.')).toBe(true);
    expect(isRevealTrigger('Reveal the secrets.')).toBe(true);
    expect(isRevealTrigger('Show me what lies within.')).toBe(true);
  });

  it('matches a one-typo variant of the primary trigger and of the others', () => {
    expect(isRevealTrigger('But I can sho you...')).toBe(true);
    expect(isRevealTrigger('But i cna show you')).toBe(true);
    expect(isRevealTrigger('Show me where you red that.')).toBe(true);
    expect(isRevealTrigger('Reveal the secrets')).toBe(true);
    expect(isRevealTrigger('Reveal the secret')).toBe(true);
  });

  it('does not match an ordinary question that contains "show"', () => {
    expect(isRevealTrigger('Can you show me the revenue table on page 3?')).toBe(false);
    expect(isRevealTrigger('Show me page 4')).toBe(false);
    expect(isRevealTrigger('Show me the budget')).toBe(false);
    expect(isRevealTrigger('What does the author show about the founder?')).toBe(false);
    expect(isRevealTrigger('Open the menu')).toBe(false);
    expect(isRevealTrigger('But I can show it')).toBe(false);
  });

  it('does not match a long sentence that contains the trigger', () => {
    expect(
      isRevealTrigger(
        'I have read the first chapter twice and now I would like to say: but I can show you...',
      ),
    ).toBe(false);
    expect(isRevealTrigger('Please open the memory of the second chapter for me right now')).toBe(false);
  });

  it('does not match an ordinary Arabic question', () => {
    expect(isRevealTrigger('ما هي عاصمة مصر؟')).toBe(false);
    expect(isRevealTrigger('أرني الصفحة الخامسة من فضلك')).toBe(false);
  });

  it('is false for empty and punctuation-only input', () => {
    expect(isRevealTrigger('')).toBe(false);
    expect(isRevealTrigger('   ')).toBe(false);
    expect(isRevealTrigger('...')).toBe(false);
  });
});

describe('levenshtein', () => {
  it('computes edit distance', () => {
    expect(levenshtein('', '')).toBe(0);
    expect(levenshtein('abc', '')).toBe(3);
    expect(levenshtein('', 'abc')).toBe(3);
    expect(levenshtein('kitten', 'sitting')).toBe(3);
    expect(levenshtein('same', 'same')).toBe(0);
    expect(levenshtein('كتاب', 'كتب')).toBe(1);
  });
});
