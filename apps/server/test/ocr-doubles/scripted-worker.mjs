// An ingestion worker that plays a script, to put the host through failure windows no real engine can be made to hit on
// demand: dying between two pages, hanging after a page, an engine that is gone when a thread is restarted. Test code only.
//
// SCRIPTED_WORKER (an environment variable, read when the thread starts) is JSON: { "<first page>": [step, ...] }. A
// thread plays the steps filed under the first page it was asked for (`pages[0]` of an OCR task, `startPage` of a parse
// task). A step is either a message for the host (an object with a `type`), or one of
//   { "$": "exit" }       the thread ends at once, as if it crashed
//   { "$": "hang" }       the thread goes on living and says nothing more
//   { "$": "wait", ms }   pause
import { parentPort, workerData } from 'node:worker_threads';

const script = JSON.parse(process.env.SCRIPTED_WORKER ?? '{}');
const first = workerData.task === 'ocr' ? workerData.pages[0] : workerData.startPage;
const steps = script[String(first)] ?? [];

for (const step of steps) {
  if (step.$ === 'exit') process.exit(1);
  else if (step.$ === 'hang') {
    setInterval(() => undefined, 1000); // a hung engine still has a live event loop; without a timer Node would end the thread
    await new Promise(() => undefined);
  } else if (step.$ === 'wait') await new Promise((resolve) => setTimeout(resolve, step.ms));
  else parentPort.postMessage(step);
}
