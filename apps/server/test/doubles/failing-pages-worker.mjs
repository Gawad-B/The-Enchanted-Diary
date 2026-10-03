// A stand-in for the ingestion worker whose every page raises an error (a document of seven unreadable pages). Test code only.
import { parentPort, workerData } from 'node:worker_threads';

if (workerData.task === 'parse') {
  parentPort.postMessage({ type: 'opened', pageCount: 7 });
  for (let page = workerData.startPage; page <= 7; page += 1) {
    parentPort.postMessage({ type: 'page-start', pageNumber: page });
    parentPort.postMessage({
      type: 'page-error',
      pageNumber: page,
      message: 'raw error from /home/secret/x.pdf',
    });
  }
  await new Promise((resolve) => setTimeout(resolve, 5000)); // the host ends this thread by itself after five in a row
}
