/*
 * npm run calibrate:offline
 *
 * Recomputes the evidence-gate thresholds from the measures of the last `npm run calibrate` (.data/task4/calibration.json,
 * values kept to three decimals) and writes apps/server/src/rag/calibration.generated.ts: no request to Gemini. For when only
 * the arithmetic (apps/server/src/rag/calibration.ts) changed; whatever changed what the embedding model sees (the model, its
 * prefixes, the chunk sizes, the titles sent with the chunks) needs the real `npm run calibrate`.
 *
 * The generated file says in its header that it was recomputed offline (and from which run), the `report` stored in
 * calibration.json is replaced by the recomputed one (the file the header points to always matches the numbers shipped), and
 * a calibration whose own checks fail (a floor that would stop an answerable question, or sits closer to one than the minimum
 * margin) is not written: the command exits with 1.
 *
 *   npm run calibrate:offline            writes the generated file
 *   npm run calibrate:offline -- --dry   prints the thresholds and the margins only
 */
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { REPO_ROOT } from '../apps/server/src/config.js';
import {
  computeThresholds,
  renderGenerated,
  type CalibrationReport,
  type Measure,
} from '../apps/server/src/rag/calibration.js';

interface Stored {
  model: string;
  dimensions: number;
  calibratedOn: string;
  observations: Measure[];
  report?: CalibrationReport;
  recomputedOn?: string;
}

const source = path.join(REPO_ROOT, '.data', 'task4', 'calibration.json');
const stored = JSON.parse(await readFile(source, 'utf8')) as Stored;
const report = computeThresholds(stored.observations);
console.info(JSON.stringify(report, null, 2));
if (!report.checks.ok) {
  console.error(`calibration checks FAILED: ${report.checks.problems.join('; ')}`);
  process.exit(1);
}
if (process.argv.includes('--dry')) process.exit(0);
const today = new Date().toISOString().slice(0, 10);
const target = path.join(REPO_ROOT, 'apps', 'server', 'src', 'rag', 'calibration.generated.ts');
await writeFile(
  target,
  renderGenerated(
    stored.model,
    stored.dimensions,
    report,
    stored.calibratedOn,
    `(measured on ${stored.calibratedOn}, recomputed offline on ${today})`,
  ),
);
await writeFile(source, JSON.stringify({ ...stored, report, recomputedOn: today }, null, 2));
console.info(`written to ${path.relative(REPO_ROOT, target)} (measures of ${stored.calibratedOn})`);
