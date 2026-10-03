// A stand-in for the ingestion worker that misbehaves in the ways the host must survive. Test code only.
// `validate`: fails with an INTERNAL error whose raw text names a path. `parse`: says it opened the document and then
// hangs (as a hostile outline would). `analyze`: hangs without a word.
import { parentPort, workerData } from 'node:worker_threads';

const hang = () => new Promise(() => setInterval(() => undefined, 1 << 30));

switch (workerData.task) {
  case 'validate':
    parentPort.postMessage({
      type: 'failure',
      code: 'INTERNAL',
      message: 'The ingestion worker failed.',
      raw: "ENOENT: open '/home/secret/project/.data/uploads/x.pdf'",
    });
    break;
  case 'parse':
    parentPort.postMessage({ type: 'opened', pageCount: 3 });
    await hang();
    break;
  case 'analyze':
    await hang();
    break;
}
