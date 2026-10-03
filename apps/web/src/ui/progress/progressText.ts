import type { IngestStage, ProgressEvent } from '@enchanted/shared';
import type { StringsContext } from '../../i18n/useStrings';

/*
 * The words for REAL progress. Every number shown comes from the server's tick (counts of pages or passages) or from the
 * browser's own upload (bytes sent); nothing is estimated, and no percentage is invented.
 */

/** "4.2" of "9.8 MB": both in the unit of the total, so the line reads "4.2 of 9.8 MB". */
export function byteCounts(
  loaded: number,
  total: number,
  ctx: Pick<StringsContext, 't' | 'format' | 'language'>,
): { loaded: string; total: string } {
  const numbers = new Intl.NumberFormat(ctx.language === 'ar' ? 'ar-u-nu-arab' : 'en', {
    maximumFractionDigits: 1,
    minimumFractionDigits: 0,
  });
  const megabytes = total >= 1024 * 1024;
  const unit = megabytes ? 1024 * 1024 : 1024;
  const written = (value: number): string =>
    numbers.format(megabytes ? value / unit : Math.round(value / unit));
  const withUnit = ctx.format(megabytes ? ctx.t.units.megabytes : ctx.t.units.kilobytes, {
    n: written(total),
  });
  return { loaded: written(Math.min(loaded, total)), total: withUnit };
}

/** The line of an upload: "Opening the manuscript… 4.2 of 9.8 MB", and once every byte is sent, the server's check of the file. */
export function uploadLine(
  progress: { loaded: number; total: number },
  ctx: Pick<StringsContext, 't' | 'format' | 'language'>,
): string {
  if (progress.total > 0 && progress.loaded >= progress.total) return ctx.t.ingestStage.validating;
  const { loaded, total } = byteCounts(progress.loaded, progress.total, ctx);
  return `${ctx.t.progress.upload} ${ctx.format(ctx.t.progress.counts.bytes, { loaded, total })}`;
}

/** How a stage's real counts read after its line. */
function countsOf(
  progress: ProgressEvent,
  ctx: Pick<StringsContext, 't' | 'format' | 'formatNumber'>,
): string | null {
  const { t, format, formatNumber } = ctx;
  const values = { completed: formatNumber(progress.completed), total: formatNumber(progress.total) };
  if (progress.unit === 'queue') return null; // a queue has a position, not counts
  if (progress.total <= 0) return null;
  switch (progress.unit) {
    case 'pages':
      // OCR reads the faded pages one by one: "page 2 of 3".
      return format(progress.stage === 'ocr' ? t.progress.counts.ocrPages : t.progress.counts.pages, values);
    case 'chunks':
      return format(t.progress.counts.chunks, values);
    case 'steps':
      return format(t.progress.counts.steps, values);
    case 'bytes':
      return format(t.progress.counts.bytes, values);
  }
}

/** "Examining the pages… 12 of 40", "Reading the faded writing… page 2 of 3", "Binding the words to memory… 96 of 312 passages". */
export function stageLine(
  progress: ProgressEvent,
  ctx: Pick<StringsContext, 't' | 'format' | 'formatNumber'>,
): string {
  const line = ctx.t.ingestStage[progress.stage];
  const counts = countsOf(progress, ctx);
  const place =
    progress.stage === 'queued' && progress.queuePosition !== undefined && progress.queuePosition > 0
      ? ` ${ctx.format(ctx.t.progress.queuePosition, { n: ctx.formatNumber(progress.queuePosition) })}`
      : '';
  return `${line}${counts ? ` ${counts}` : ''}${place}`;
}

/** The real fraction of the stage or upload that is done, 0 to 1, or null when there is nothing to measure. */
export function fractionOf(progress: { completed: number; total: number } | null): number | null {
  if (!progress || progress.total <= 0) return null;
  return Math.min(Math.max(progress.completed / progress.total, 0), 1);
}

/** What the screen reader hears changes only when the stage does or a quarter of it is done (a tick every second would chatter). */
export function announcementKey(stage: IngestStage | 'upload', fraction: number | null): string {
  return `${stage}:${fraction === null ? '-' : String(Math.floor(fraction * 4))}`;
}
