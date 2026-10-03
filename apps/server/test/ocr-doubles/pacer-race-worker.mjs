// A thread that draws on the shared window as fast as it can for a while, with a lock that was left behind by a thread that is
// gone, and reports how many slots it got. Test code only.
import { parentPort, workerData } from 'node:worker_threads';
import { register } from 'tsx/esm/api';

register();
const { GeminiPacer } = await import('../../src/gemini/pacing.ts');
const pacer = new GeminiPacer({
  maxPerMinute: workerData.max,
  shared: workerData.buffer,
  staleLockMs: workerData.staleLockMs,
});
parentPort.postMessage('ready');
await new Promise((resolve) => parentPort.once('message', resolve));
const until = performance.now() + workerData.forMs;
let granted = 0;
while (performance.now() < until) if (pacer.tryAcquire() === 0) granted += 1;
parentPort.postMessage(granted);
