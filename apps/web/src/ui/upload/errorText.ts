import type { PublicConfig } from '@enchanted/shared';
import { QUESTION_MAX_CHARS } from '@enchanted/shared';
import type { UiError } from '../../api/client';
import { flavourOf } from '../../api/errorDetail';
import type { Language } from '../../i18n/strings';
import type { StringsContext } from '../../i18n/useStrings';
import { FALLBACK_MAX_UPLOAD_BYTES } from '../../state/validateFile';
import { byteCounts } from '../progress/progressText';

export interface DescribeErrorOptions {
  /**
   * The error is not about a question the reader asked (the upload, the reading, the session). The server answers every 400
   * with QUESTION_INVALID, so there it would say "I could not read that question" about a file: it reads as an internal
   * fault instead. Questions (the ask flow) leave this unset.
   */
  outsideAsk?: boolean;
}

/**
 * The in-world line of an error, with its limits filled in from the server's configuration ("under 20 MB", "under 300
 * pages"). A code that covers several things (a full archive, a busy one, an hourly limit; a file refused for its name or
 * for its first bytes) says the one it is: see api/errorDetail.ts.
 */
export function describeError(
  error: UiError,
  ctx: Pick<StringsContext, 't' | 'format' | 'formatNumber' | 'language'>,
  config: PublicConfig | null,
  options: DescribeErrorOptions = {},
): string {
  const flavour = flavourOf(error);
  const code = error.code === 'QUESTION_INVALID' && options.outsideAsk === true ? 'INTERNAL' : error.code;
  const line = flavour === null ? ctx.t.errors[code] : ctx.t.errorFlavours[flavour];
  const maxBytes = config?.maxUploadBytes ?? FALLBACK_MAX_UPLOAD_BYTES;
  const size = byteCounts(maxBytes, maxBytes, ctx);
  return ctx.format(line, {
    limit:
      error.code === 'TOO_MANY_PAGES'
        ? ctx.format(ctx.t.units.pages, { n: ctx.formatNumber(config?.maxPages ?? 300) })
        : size.total,
    max: ctx.formatNumber(QUESTION_MAX_CHARS),
  });
}

/** The technical line under an in-world error: the stable code and what the server (or the browser) said. */
export function technicalLine(error: UiError, language: Language = 'en'): string {
  if (language === 'ar') return ''; // "Arabic means Arabic": codes and server messages are English, so they are not shown
  return [error.code, error.message, error.detail]
    .filter((part): part is string => part !== undefined && part !== '')
    .join(' · ');
}
