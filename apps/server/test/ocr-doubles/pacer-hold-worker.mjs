// A thread that takes the lock of the shared window of requests per minute and never gives it back: what a thread that the
// host terminates inside the critical section leaves behind. Test code only.
import { parentPort, workerData } from 'node:worker_threads';

Atomics.store(new Int32Array(workerData.buffer, 0, 4), 0, 424242);
parentPort.postMessage('holding');
setInterval(() => undefined, 1000);
