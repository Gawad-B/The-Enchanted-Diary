import type { OutlineEntry } from '../../pdf/outline.js';
import { AppError } from '../../http/errors.js';
import { PageLedger, driveThreads } from './ledger.js';
import type { SerializedPage } from './protocol.js';
import {
  abortError,
  runThread,
  stopDetail,
  workerFailure,
  type Outcome,
  type ThreadContext,
} from './thread.js';
import type { PageFailure } from './ledger.js';

export interface ParseResult {
  pageCount: number;
  /** The pages that were extracted, in page order. */
  pages: SerializedPage[];
  /** The pages that could not be: they are recorded as empty with a warning. */
  failures: PageFailure[];
  outline: OutlineEntry[];
}

export interface ParseProgress {
  /** Pages finished (extracted or failed). */
  completed: number;
  total: number;
}

export interface ParseOptions {
  maxPages: number;
  signal?: AbortSignal;
  onProgress?: (progress: ParseProgress) => void;
}

const UNREADABLE = 'The pages appear damaged or unreadable.';

/**
 * Extracts all pages. A page that takes too long, grows the process too much, kills its thread or throws is recorded in
 * `failures` and skipped; the next page is read by a fresh thread. Five failures in a row give up on the document.
 */
export async function parseDocument(
  context: ThreadContext,
  bytes: Uint8Array,
  options: ParseOptions,
): Promise<ParseResult> {
  const { limits, log } = context;
  let outline: OutlineEntry[] = [];
  let pageCount = 0;
  let readOutline = true;
  const ledger = new PageLedger<SerializedPage>(null, () =>
    options.onProgress?.({ completed: ledger.settled, total: pageCount }),
  );
  /** Whether the thread now running opened the document. */
  const thread = { opened: false };

  const drive = await driveThreads(ledger, {
    ready: () => thread.opened,
    detail: (end) => stopDetail(end, limits),
    onLost: (page, end) => log?.warn({ page, reason: end.kind }, 'a page could not be extracted'),
    run: async () => {
      thread.opened = false;
      const outcome: Outcome<true> = { result: null, failure: null };
      const end = await runThread({
        entry: context.entry,
        stopGraceMs: context.stopGraceMs,
        task: {
          task: 'parse',
          bytes,
          startPage: ledger.remaining[0] ?? 1,
          maxPages: options.maxPages,
          readOutline,
        },
        bytes,
        maxOldGenerationSizeMb: limits.maxOldGenerationSizeMb,
        signal: options.signal,
        initialWatchdogMs: context.openTimeout,
        memory: context.memory,
        onMessage: (message, control) => {
          switch (message.type) {
            case 'opened':
              thread.opened = true;
              pageCount = message.pageCount;
              ledger.setPages(Array.from({ length: message.pageCount }, (_, i) => i + 1));
              // Reading the outline comes next, before any page starts: it is covered by the open limit.
              control.watchdog(context.openTimeout);
              break;
            case 'outline':
              outline = message.entries;
              readOutline = false;
              break;
            case 'page-start':
              ledger.begin(message.pageNumber);
              control.watchdog(limits.pageTimeoutMs);
              control.watchMemory(true);
              break;
            case 'page':
              ledger.complete(message.page.pageNumber, message.page);
              control.watchdog(null);
              control.watchMemory(false);
              break;
            case 'page-error':
              log?.warn({ page: message.pageNumber, raw: message.message }, 'a page raised an error');
              ledger.fail(message.pageNumber, 'error', 'the page could not be read');
              control.watchdog(null);
              control.watchMemory(false);
              if (ledger.shouldGiveUp()) control.finish();
              break;
            case 'parsed':
              ledger.abandon();
              outcome.result = true;
              control.finish();
              break;
            case 'failure':
              outcome.failure = workerFailure(context, message);
              control.finish();
              break;
            default:
              break;
          }
        },
      });
      if (end.kind !== 'aborted' && outcome.failure !== null) throw outcome.failure;
      return end;
    },
  });

  switch (drive.status) {
    case 'aborted':
      throw abortError(options.signal);
    case 'gave-up':
      throw new AppError(
        'PDF_UNREADABLE',
        UNREADABLE,
        `${String(ledger.consecutiveFailures)} pages in a row could not be read (the last was page ${String(ledger.lastFailedPage)})`,
      );
    case 'not-started':
      throw new AppError(
        'PDF_UNREADABLE',
        UNREADABLE,
        `the PDF could not be opened: ${stopDetail(drive.end, limits)}`,
      );
    case 'done':
      break;
  }

  return {
    pageCount,
    pages: [...ledger.results.values()].sort((a, b) => a.pageNumber - b.pageNumber),
    failures: [...ledger.failures].sort((a, b) => a.pageNumber - b.pageNumber),
    outline,
  };
}
