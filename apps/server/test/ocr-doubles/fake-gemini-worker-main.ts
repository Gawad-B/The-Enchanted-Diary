import { appendFileSync } from 'node:fs';
import { parentPort, workerData } from 'node:worker_threads';
import { countingClient } from '../../src/ingest/worker/ocr-requests.js';
import { runOcrTask } from '../../src/ingest/worker/ocr-task.js';
import type { OcrTask, WorkerMessage } from '../../src/ingest/worker/protocol.js';
import { GeminiOcrProvider } from '../../src/ocr/gemini.js';
import { FakeGeminiClient, apiError, dailyQuota } from './fake-gemini.js';

/** What a test asks of the stand-in for Gemini; it reaches the worker thread through the FAKE_GEMINI environment variable. */
export interface FakeGeminiScript {
  /** From this request on (1-based, counted in this thread), the service answers that the daily quota is used up. */
  quotaFromRequest?: number;
  /** The first line of every page instead of "Request N page M". */
  firstLine?: string;
  /** The answer to the first request has a malformed entry for this page of the batch (1-based). */
  omitPageOfFirstRequest?: number;
  /** The service answers 503 to the first this many requests (counting each attempt of the provider's retry). */
  unavailableFirstRequests?: number;
  /** The service answers every request with this HTTP status (401: the key is rejected, 404: no such model). */
  httpStatus?: number;
  /** The model has no quota at all on this plan: every request is answered 429 with "limit: 0" (a fault of the configuration). */
  noQuota?: boolean;
  /** From this request on (1-based) the service never answers: only the host's time budget ends it. */
  hangFromRequest?: number;
  /** Every page ends on its page number, as a scan does (the model is told to transcribe footers and page numbers). */
  pageNumbers?: boolean;
  /** The answer to a request of several pages numbers them wrongly (by the numbers printed on a scan): each page is asked for again, alone. */
  numberPagesWrongly?: boolean;
  /** A file every request appends a line to, for a test to count the requests that were really made. */
  requestLog?: string;
}

// The OCR task of an ingestion worker with the Gemini provider over a stand-in client. Test code only.
const script = JSON.parse(process.env.FAKE_GEMINI ?? '{}') as FakeGeminiScript;
const client = new FakeGeminiClient((request, index) => {
  const number = index + 1;
  if (script.requestLog !== undefined) appendFileSync(script.requestLog, 'request\n');
  if (script.httpStatus !== undefined) return apiError(script.httpStatus, { message: 'refused' });
  if (script.noQuota === true)
    return apiError(429, { message: 'Quota exceeded, limit: 0, model: gemini-3.5-flash-lite' });
  if (script.hangFromRequest !== undefined && number >= script.hangFromRequest) {
    setInterval(() => undefined, 1000); // a request that hangs still has a live event loop around it
    return new Promise<never>(() => undefined);
  }
  if (script.quotaFromRequest !== undefined && number >= script.quotaFromRequest) return dailyQuota();
  if (number <= (script.unavailableFirstRequests ?? 0)) return apiError(503, { status: 'UNAVAILABLE' });
  return Array.from({ length: request.pageCount }, (_, page) =>
    index === 0 && script.omitPageOfFirstRequest === page + 1
      ? { page: page + 1 } // an entry with no lines: this page is asked for again, alone
      : {
          page: script.numberPagesWrongly === true && request.pageCount > 1 ? page + 7 : page + 1,
          lines: [
            `${script.firstLine ?? 'Request'} ${String(number)} page ${String(page + 1)}`,
            '',
            `Second paragraph of request ${String(number)} page ${String(page + 1)}`,
            ...(script.pageNumbers === true ? ['', String(page + 1)] : []),
          ],
        },
  );
});

const post = (message: WorkerMessage): void => parentPort?.postMessage(message);
await runOcrTask(workerData as OcrTask, post, {
  createProvider: (settings) =>
    new GeminiOcrProvider({
      // Like the real worker: every request is announced to the host.
      client: countingClient(client, () => {
        post({ type: 'ocr-request' });
      }),
      model: settings.model,
      pagesPerRequest: settings.pagesPerRequest,
      retry: { sleep: () => Promise.resolve() },
    }),
});
