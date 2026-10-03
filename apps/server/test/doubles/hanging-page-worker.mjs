// A stand-in for the ingestion worker that opens a two-page document and then hangs inside the page it was asked to
// read (as a page whose images are being decoded would). Test code only.
import { parentPort, workerData } from 'node:worker_threads';

if (workerData.task === 'parse') {
  parentPort.postMessage({ type: 'opened', pageCount: 2 });
  parentPort.postMessage({ type: 'page-start', pageNumber: workerData.startPage });
  await new Promise(() => setInterval(() => undefined, 1 << 30));
}
