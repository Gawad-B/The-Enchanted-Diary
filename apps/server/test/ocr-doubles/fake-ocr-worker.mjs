// An ingestion worker whose OCR task uses the fake engine (FAKE_OCR describes its behaviour); every other task is the
// real worker. Test code only.
import { workerData } from 'node:worker_threads';
import { register } from 'tsx/esm/api';

register();
if (workerData.task === 'ocr') await import('./fake-ocr-worker-main.ts');
else await import('../../src/ingest/worker/worker.ts');
