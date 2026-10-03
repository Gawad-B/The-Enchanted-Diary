// A thread that draws on the shared window of requests per minute as fast as it can, and reports how many slots it got.
// Test code only.
import { parentPort, workerData } from 'node:worker_threads';
import { register } from 'tsx/esm/api';

register();
const { GeminiPacer } = await import('../../src/gemini/pacing.ts');
const pacer = new GeminiPacer({ maxPerMinute: workerData.max, shared: workerData.buffer });
let granted = 0;
for (let i = 0; i < workerData.tries; i += 1) if (pacer.tryAcquire() === 0) granted += 1;
parentPort.postMessage(granted);
