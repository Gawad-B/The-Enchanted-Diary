import { parentPort, workerData } from 'node:worker_threads';
import { analyzePages } from '../analyze.js';
import { closePdf, classifyPdfError, loadPdf } from '../../pdf/load.js';
import { extractPage } from '../../pdf/extract-page.js';
import { readOutline } from '../../pdf/outline.js';
import { installPdfWarningSink } from '../../pdf/warnings.js';
import type {
  AnalyzeTask,
  HostMessage,
  ParseTask,
  SerializedPage,
  ValidateTask,
  WorkerMessage,
  WorkerTask,
} from './protocol.js';

/*
 * Runs inside a worker thread: opens the PDF with pdf.js, extracts pages, analyses and chunks. Everything that
 * touches untrusted bytes happens here, never on the main thread. The host enforces the timeouts and the
 * memory limit from outside (a thread cannot interrupt itself while pdf.js spins) and terminates the thread.
 */

const port = parentPort;
if (port === null) throw new Error('worker.ts must run in a worker thread');

const post = (message: WorkerMessage): void => port.postMessage(message);

/*
 * What the host says while the task runs: `stop` (finish what is under way and end: the flag is checked before every page, and a
 * paced parse waits for the host between pages) and `next` (a paced parse may start its next page). The port does not keep the
 * thread alive by itself: the thread ends by itself when its work is done (so the host never has to terminate a thread that is
 * inside pdf.js, see thread.ts); it is held only while a paced parse waits for the host.
 */
const host = { stopRequested: false, inbox: [] as ('next' | 'stop')[], wake: null as (() => void) | null };
port.on('message', (message: HostMessage) => {
  if (message.type === 'stop') host.stopRequested = true;
  else host.inbox.push(message.type);
  host.wake?.();
});
port.unref();

/** Waits for the host to say what a paced parse does after a page. */
const nextOrStop = async (): Promise<'next' | 'stop'> => {
  for (;;) {
    if (host.stopRequested) return 'stop';
    if (host.inbox.shift() === 'next') return 'next';
    port.ref();
    await new Promise<void>((resolve) => {
      host.wake = resolve;
    });
    host.wake = null;
    port.unref();
  }
};

/** Lets a message of the host (a stop) be handled between two pages of a task that is not paced. */
const letMessagesIn = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/** The original text of whatever was thrown, for the log: it never reaches a client. */
const rawText = (error: unknown): string => (error instanceof Error ? error.message : String(error));

async function validate(task: ValidateTask): Promise<void> {
  let doc;
  try {
    // Only the page count matters here: no extraction limits, and pdf.js stays silent (verbosity 0).
    doc = await loadPdf(task.bytes);
  } catch (error) {
    post({ type: 'failure', ...classifyPdfError(error), raw: rawText(error) });
    return;
  }
  try {
    if (doc.numPages === 0) {
      post({ type: 'failure', code: 'PDF_EMPTY', message: 'The PDF has no pages.' });
    } else if (doc.numPages > task.maxPages) {
      post({
        type: 'failure',
        code: 'TOO_MANY_PAGES',
        message: `The PDF has ${String(doc.numPages)} pages; the limit is ${String(task.maxPages)}.`,
      });
    } else {
      // A page tree that cannot even deliver its first page is a broken file, not a readable one.
      try {
        await doc.getPage(1);
      } catch (error) {
        post({
          type: 'failure',
          code: 'PDF_MALFORMED',
          message: 'The first page could not be read.',
          raw: rawText(error),
        });
        return;
      }
      post({ type: 'validated', pageCount: doc.numPages });
    }
  } finally {
    await closePdf(doc);
  }
}

/** The page without the parts the main thread does not need. */
function serialize(page: Awaited<ReturnType<typeof extractPage>>): SerializedPage {
  const { items: _items, lines: _lines, ...rest } = page;
  return rest;
}

async function parse(task: ParseTask): Promise<void> {
  // pdf.js warnings are on for this document (they reveal images the extraction limit refused); none may be printed.
  installPdfWarningSink();
  let doc;
  try {
    doc = await loadPdf(task.bytes, { extraction: true });
  } catch (error) {
    post({ type: 'failure', ...classifyPdfError(error), raw: rawText(error) });
    return;
  }
  try {
    if (doc.numPages > task.maxPages) {
      post({
        type: 'failure',
        code: 'TOO_MANY_PAGES',
        message: `The PDF has ${String(doc.numPages)} pages; the limit is ${String(task.maxPages)}.`,
      });
      return;
    }
    post({ type: 'opened', pageCount: doc.numPages });
    if (task.readOutline) post({ type: 'outline', entries: await readOutline(doc) });
    for (let pageNumber = task.startPage; pageNumber <= doc.numPages; pageNumber += 1) {
      if (host.stopRequested) return; // the host has no more use for this thread: no page is begun
      post({ type: 'page-start', pageNumber });
      try {
        post({ type: 'page', page: serialize(await extractPage(doc, pageNumber)) });
      } catch (error) {
        post({
          type: 'page-error',
          pageNumber,
          message: error instanceof Error ? error.message : 'The page could not be read.',
        });
      }
      // Between two pages the thread is idle: the host says whether to go on (a paced range), or a stop gets in.
      if (task.paced === true) {
        if ((await nextOrStop()) === 'stop') return;
      } else {
        await letMessagesIn();
      }
    }
    post({ type: 'parsed' });
  } finally {
    await closePdf(doc).catch(() => undefined);
  }
}

function analyze(task: AnalyzeTask): void {
  const analysis = analyzePages(
    task.pages,
    { chunking: task.chunking, outline: task.outline },
    (step, completed, total, direction) =>
      post({ type: 'progress', step, completed, total, ...(direction === undefined ? {} : { direction }) }),
  );
  post({ type: 'analysis', analysis });
}

async function main(task: WorkerTask): Promise<void> {
  switch (task.task) {
    case 'validate':
      await validate(task);
      return;
    case 'parse':
      await parse(task);
      return;
    case 'analyze':
      analyze(task);
      return;
    case 'ocr': {
      // Only an OCR thread needs the OCR task, the model SDK and pdf-lib (about a second and 40 MB to load): the threads
      // that validate, parse and analyse never import them.
      const [
        { runOcrTask },
        { createOcrProvider },
        { getGeminiClient, useGeminiPacerBuffer },
        { countingClient },
      ] = await Promise.all([
        import('./ocr-task.js'),
        import('../../ocr/provider.js'),
        import('../../gemini/index.js'),
        import('./ocr-requests.js'),
      ]);
      // One budget of requests per minute for the whole process: draw on the window the main thread made.
      if (task.settings.pacerBuffer) useGeminiPacerBuffer(task.settings.pacerBuffer);
      await runOcrTask(task, post, {
        createProvider: (settings, probe) =>
          createOcrProvider(
            {
              ocrProvider: settings.provider,
              ocrCacheDir: settings.cacheDir,
              ocrLanguages: [probe],
              ocrModel: settings.model,
              ocrPagesPerRequest: settings.pagesPerRequest,
              geminiApiKey: settings.geminiApiKey,
              geminiMaxRpm: settings.geminiMaxRpm,
            },
            // Every request the Gemini provider makes is announced to the host, which keeps the daily OCR budget in step
            // with what was really sent.
            settings.provider === 'gemini'
              ? {
                  gemini: {
                    client: countingClient(getGeminiClient({ geminiApiKey: settings.geminiApiKey }), () => {
                      post({ type: 'ocr-request' });
                    }),
                  },
                }
              : {},
          ),
      });
      return;
    }
  }
}

try {
  await main(workerData as WorkerTask);
} catch (error) {
  post({
    type: 'failure',
    code: 'INTERNAL',
    message: 'The ingestion worker failed.',
    raw: rawText(error),
  });
}
