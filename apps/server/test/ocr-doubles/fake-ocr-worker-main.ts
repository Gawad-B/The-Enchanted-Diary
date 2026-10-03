import { parentPort, workerData } from 'node:worker_threads';
import { runOcrTask } from '../../src/ingest/worker/ocr-task.js';
import type { OcrTask, WorkerMessage } from '../../src/ingest/worker/protocol.js';
import { FakeOcrProvider, type FakeOcrScript } from './fake-ocr-provider.js';

// The OCR task of an ingestion worker with the fake engine instead of Tesseract. Test code only.
const script = JSON.parse(process.env.FAKE_OCR ?? '{}') as FakeOcrScript;
await runOcrTask(workerData as OcrTask, (message: WorkerMessage) => parentPort?.postMessage(message), {
  createProvider: () => new FakeOcrProvider(script),
});
