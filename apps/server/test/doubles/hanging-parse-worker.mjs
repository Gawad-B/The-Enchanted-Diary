// An ingestion worker whose PARSE task opens a document of HANGING_PAGES pages and then hangs inside every page it is asked to
// read (as a page whose images are being decoded would), while every other task (validate, analyse, OCR) is the real worker.
// Test code only.
import { parentPort, workerData } from 'node:worker_threads';
import { register } from 'tsx/esm/api';

register();
if (workerData.task === 'parse') {
  parentPort.postMessage({ type: 'opened', pageCount: Number(process.env.HANGING_PAGES ?? 5) });
  parentPort.postMessage({ type: 'page-start', pageNumber: workerData.startPage });
  await new Promise(() => setInterval(() => undefined, 1 << 30));
} else {
  await import('../../src/ingest/worker/worker.ts');
}
