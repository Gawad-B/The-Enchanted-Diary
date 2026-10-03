import { describe, expect, it } from 'vitest';
import { createStringsContext } from '../../src/i18n/useStrings';
import { describeAskError } from '../../src/ui/diary/askErrors';

const en = createStringsContext('en');
const ar = createStringsContext('ar');

describe('describeAskError: what the diary says when a question could not be answered', () => {
  it('DIARY_BUSY: the diary is still writing', () => {
    expect(describeAskError({ code: 'DIARY_BUSY', message: 'busy' }, en, null)).toBe(
      'The diary is still writing.',
    );
  });

  it('a daily quota gets a line of its own', () => {
    expect(
      describeAskError({ code: 'RATE_LIMITED', message: 'x', detail: 'daily quota reached' }, en, null),
    ).toBe('The diary has written all it can today. Its ink will return tomorrow.');
    expect(
      describeAskError({ code: 'RATE_LIMITED', message: 'x', detail: 'daily quota reached' }, ar, null),
    ).toMatch(/اليوم/u);
  });

  it('any other rate limit asks the reader to write a little slower, with the wait when the server said it', () => {
    expect(
      describeAskError({ code: 'RATE_LIMITED', message: 'x', detail: 'retry after 7 seconds' }, en, null),
    ).toBe("Write a little slower. The ink hasn't dried yet.");
    expect(describeAskError({ code: 'RATE_LIMITED', message: 'x', retryAfterSeconds: 7 }, en, null)).toBe(
      "Write a little slower. The ink hasn't dried yet. Try again in 7 s.",
    );
  });

  it('the broken connection is the archive line', () => {
    expect(describeAskError({ code: 'NETWORK', message: 'x' }, en, null)).toMatch(
      /^The connection to the archive was interrupted\./u,
    );
  });

  it('other codes use the in-world line of the code, with the question limit filled in', () => {
    expect(describeAskError({ code: 'QUESTION_INVALID', message: 'x' }, en, null)).toContain('2,000');
    expect(describeAskError({ code: 'LLM_FAILED', message: 'x' }, en, null)).toBe(
      'The diary lost its train of thought. Ask again.',
    );
  });

  it('writes the wait in Eastern Arabic digits in the Arabic interface', () => {
    expect(
      describeAskError({ code: 'RATE_LIMITED', message: 'x', retryAfterSeconds: 7 }, ar, null),
    ).toContain('٧');
  });
});
