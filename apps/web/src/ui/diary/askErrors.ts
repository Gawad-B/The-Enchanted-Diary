import type { PublicConfig } from '@enchanted/shared';
import type { TurnError } from '../../state/chatTurn';
import type { StringsContext } from '../../i18n/useStrings';
import { describeError } from '../upload/errorText';

type Ctx = Pick<StringsContext, 't' | 'format' | 'formatNumber' | 'language'>;

/**
 * The diary's own words for a question that could not be answered (the technical code and detail go in a separate line, as
 * for every error): DIARY_BUSY (one answer at a time) is "still writing"; a daily quota has its own line; another rate limit
 * says to write a little slower and, when the server said how long, how long; the rest use the line of their code.
 */
export function describeAskError(error: TurnError, ctx: Ctx, config: PublicConfig | null): string {
  const { t } = ctx;
  switch (error.code) {
    case 'DIARY_BUSY':
      return t.ask.diaryStillWriting;
    case 'RATE_LIMITED': {
      if (/quota/iu.test(error.detail ?? '')) return t.ask.dailyQuota;
      const wait =
        error.retryAfterSeconds === undefined
          ? ''
          : ` ${ctx.format(t.ask.retryAfter, { n: ctx.formatNumber(error.retryAfterSeconds) })}`;
      return `${t.ask.slowDown}${wait}`;
    }
    default:
      return describeError(error, ctx, config);
  }
}
