// A worker for a document pdf.js reports as having no pages. Test code only.
import { parentPort } from 'node:worker_threads';

parentPort.postMessage({ type: 'opened', pageCount: 0 });
parentPort.postMessage({ type: 'outline', entries: [] });
parentPort.postMessage({ type: 'parsed' });
