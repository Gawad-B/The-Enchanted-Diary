// An ingestion worker whose OCR task uses the Gemini provider over a stand-in client (FAKE_GEMINI describes how the
// stand-in behaves); every other task is the real worker. Test code only.
import { workerData } from 'node:worker_threads';
import { register } from 'tsx/esm/api';

register();
if (workerData.task === 'ocr') await import('./fake-gemini-worker-main.ts');
else await import('../../src/ingest/worker/worker.ts');
